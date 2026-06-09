// 127.0.0.1 限定の HTTP サーバー (Hono + @hono/node-server)。
// 同一 PC 上で動く別ユーザーやプロセスからの覗き見だけを脅威モデルにし、4 層で防御する:
//   1. listen を 127.0.0.1 に固定 (localhost 別名や :: 経由を弾く)
//   2. Host ヘッダを 127.0.0.1:<port> と完全一致でチェック (DNS rebinding 対策)
//   3. 32 byte ランダム token を URL クエリで毎リクエスト検証
//   4. POST /result では Origin ヘッダも検証 (CSRF 対策)
// 加えて token 検証失敗が 20 回貯まったらプロセスごと落として brute force 試行を断つ。
//
// context+ は close-relaunch + state restore モデルで動く。ブラウザは POST /result に
// decision='regen-group' を送って window.close() するだけ。SSE / event bus / 別 token
// (browserToken / channelToken) のような Channels インフラは存在しない (廃止済み)。
//
// なぜ Hono か:
//   - middleware を順序付きで宣言できるためセキュリティ層の責務が一目で読める
//   - app.fetch(Request) でリスナー無しテストが書け、テストの所要時間と flakiness が下がる
//   - compress() を使うと gzip / Accept-Encoding 判定を自前で書かなくて済む

import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import type { MiddlewareHandler } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import type { ResultJson } from '@zeus/review-diff-shared'

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // inline 化された script/style だけを許可。外部リソースは一切ロードできない。
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'none'",
}

const MAX_TOKEN_FAILURES = 20
const RESULT_SETTLE_MS = 200 // POST のレスポンスを返し切ってから resolve するまでの猶予
const MAX_BODY = 1 * 1024 * 1024 // 1 MiB。コメント全部入れてもこれを超えないはず

// staged モード時に「unchanged 行を lazy 展開」できるよう、ファイルの before/after 全文を
// CLI から渡してもらう。PR モードでは Map が空 (= 404 を返してクライアント側でバナーを
// "Expand unavailable" 表示にする)。
export type FileSource = { before: string; after: string }
export type SourcesMap = Map<string, FileSource>

export type CreateAppOptions = {
  html: string
  // 実 port が決まる前にミドルウェアが起動するケース (テストで app.fetch を直叩きする場合)
  // のため、port は遅延参照できるよう関数で渡す。
  getPort: () => number
  token: string
  onBruteForce?: () => void // テスト時は process.exit を差し替えたい
  onResult: (r: ResultJson) => void
  sources?: SourcesMap
  // ブラウザから一定間隔で /heartbeat が打たれる。最終 ping 時刻を CLI 側に伝えるための callback。
  // CLI は最終 ping から一定時間 (gracePeriod) 経過したら「タブ close された」と判断して終了する。
  // 渡されない場合は heartbeat 機能無効 (テスト互換用)。
  onHeartbeat?: () => void
}

export function createApp(opts: CreateAppOptions): Hono {
  const { html, getPort, token, onResult, onHeartbeat } = opts
  const sources: SourcesMap = opts.sources ?? new Map()
  const onBruteForce = opts.onBruteForce ?? (() => setTimeout(() => process.exit(1), 50))

  let failCount = 0
  const app = new Hono()

  // 1. セキュリティヘッダ (全レスポンスに付与)
  app.use('*', async (c, next) => {
    await next()
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v)
  })

  // 2. Host header 検証 (127.0.0.1:<port> のみ allow、DNS rebinding / localhost 別名対策)
  const hostCheck: MiddlewareHandler = async (c, next) => {
    const host = c.req.header('host') ?? ''
    if (host !== `127.0.0.1:${getPort()}`) {
      return c.text('forbidden', 403)
    }
    await next()
  }
  app.use('*', hostCheck)

  // 3. token 検証 + brute force ガード (20 回失敗で onBruteForce、デフォルトはプロセス自爆)
  const tokenCheck: MiddlewareHandler = async (c, next) => {
    if (c.req.query('token') !== token) {
      failCount++
      if (failCount >= MAX_TOKEN_FAILURES) {
        onBruteForce()
      }
      return c.text('forbidden', 403)
    }
    await next()
  }
  app.use('*', tokenCheck)

  // 4. Origin 検証 (CSRF 対策) を **書き込み系 (GET/HEAD 以外) すべて** に一段で適用する。
  //
  // 脅威モデルメモ:
  //   - ブラウザから来る POST (/result) は Origin header を必ず持つので、
  //     `http://127.0.0.1:<port>` と完全一致で弾けば CSRF (悪意ある別 origin の fetch) を遮断できる。
  //   - 将来 PUT/PATCH を追加した時もこの一段ミドルウェアが自動で守る (per-path 追加忘れ防止)。
  const originCheck: MiddlewareHandler = async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next()
    const origin = c.req.header('origin') ?? ''
    if (origin !== `http://127.0.0.1:${getPort()}`) {
      return c.text('forbidden', 403)
    }
    await next()
  }
  app.use('*', originCheck)

  // 5. gzip / deflate 圧縮 (Web Streams ベース、Node 22.8+ で動く前提)
  // GET / の HTML レスポンスだけ対象になれば十分なので、全ルートにかけても害は無い。
  app.use('*', compress())

  // GET / → HTML を返す
  app.get('/', (c) => {
    c.header('Content-Type', 'text/html; charset=utf-8')
    return c.body(html)
  })

  // GET /heartbeat → ブラウザから 5 秒間隔で打たれる「タブ生存通知」。
  // CLI 側は最終 ping から N 秒 (gracePeriod) 経過したら「タブ close」と判断して exit する設計。
  // これによりユーザーがタブを閉じれば数秒以内に CLI も自動終了し、zombie process を防ぐ。
  // 認証は token middleware で既に通過済み (token 認証済みリクエストしかここに来ない)。
  app.get('/heartbeat', (c) => {
    if (onHeartbeat) onHeartbeat()
    return c.body(null, 204)
  })

  // GET /source → unchanged-lines バナークリックで呼ばれる。
  // sources Map から原文を引いて指定行範囲 (1-based, 両端 inclusive) を text/plain で返す。
  // セキュリティ: middleware で token / Host を既に検証済み。path は Map の key 完全一致で
  // 引くだけなのでパストラバーサルにはならない (filesystem を直接見ない設計)。
  app.get('/source', (c) => {
    const path = c.req.query('path') ?? ''
    const side = c.req.query('side') ?? ''
    const startStr = c.req.query('start') ?? ''
    const endStr = c.req.query('end') ?? ''
    if (side !== 'before' && side !== 'after') return c.text('bad side', 400)
    const start = Number(startStr)
    const end = Number(endStr)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return c.text('bad range', 400)
    }
    const src = sources.get(path)
    if (!src) return c.text('not found', 404)
    const text = side === 'before' ? src.before : src.after
    const lines = text.split('\n')
    // 末尾改行で 1 つ余分な空文字列が出るパターンを許容しつつ、
    // 範囲超過は 400 で明示する (UI 側にバグがあった時に気付けるように)。
    if (end > lines.length) return c.text('range out of bounds', 400)
    const slice = lines.slice(start - 1, end).join('\n')
    c.header('Content-Type', 'text/plain; charset=utf-8')
    return c.body(slice)
  })

  // POST /result → JSON 受信 → 200 を返し切ってから resolve (ブラウザに描画余地を残す)
  //
  // decision='regen-group' もここで受け取る。CLI 側は decision を見ずに
  // ResultJson をそのまま resolve するので、SKILL.md が JSON.parse で分岐する設計。
  // approve / reject と同じ close-relaunch ルートで動くので endpoint 追加不要。
  app.post('/result', async (c) => {
    // body size ガード: Content-Length が無いリクエストでも、生バッファを直接読んで上限超過なら 413。
    // c.req.json() に渡す前に上限を実測する。
    const buf = await readBodyWithLimit(c.req.raw, MAX_BODY)
    if (buf === null) return c.text('payload too large', 413)
    let json: ResultJson
    try {
      json = JSON.parse(buf.toString('utf8')) as ResultJson
    } catch {
      return c.text('bad json', 400)
    }
    // RESULT_SETTLE_MS の猶予をブラウザ描画用に挟んでから resolve する。
    setTimeout(() => onResult(json), RESULT_SETTLE_MS)
    return c.json({ ok: true })
  })

  return app
}

async function readBodyWithLimit(req: Request, max: number): Promise<Buffer | null> {
  const reader = req.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > max) {
        try { await reader.cancel() } catch { /* noop */ }
        return null
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks.map((u) => Buffer.from(u)))
}

export type StartServerOptions = {
  html: string
  sources?: SourcesMap
  // 現状はクライアントペイロード経由で expandable を伝えるため、server 自体は値を保持しない。
  // 将来 server 側で expandable に応じた挙動分岐が必要になれば opts に追加する。
  expandable?: boolean
}
export type StartedServer = {
  url: string
  port: number
  waitResult: () => Promise<ResultJson>
  // 最後にブラウザから /heartbeat が来た時刻 (Date.now() 形式)。CLI 側で「タブが閉じられたか」を
  // 検知するために poll する。未受信の場合は null (初回 ping が来るまでの猶予期間)。
  getLastHeartbeat: () => number | null
  close: () => void
}

export async function startServer(opts: StartServerOptions): Promise<StartedServer> {
  const { html, sources } = opts
  const token = randomBytes(32).toString('hex')

  let resolveResult!: (r: ResultJson) => void
  const resultPromise = new Promise<ResultJson>((r) => {
    resolveResult = r
  })

  // serve() callback で実 port が判明するまで getPort() の参照先を遅延しておく。
  let port = 0
  let lastHeartbeatAt: number | null = null

  let server: ServerType
  const app = createApp({
    html,
    token,
    getPort: () => port,
    sources,
    onResult: (json) => {
      resolveResult(json)
      try { server.close() } catch { /* noop */ }
    },
    onHeartbeat: () => {
      lastHeartbeatAt = Date.now()
    },
  })

  await new Promise<void>((resolve, reject) => {
    try {
      server = serve(
        {
          fetch: app.fetch,
          port: 0,
          hostname: '127.0.0.1',
          // SSE 経路が無いので keep-alive を切る必要は無い。
          // 既定値 (Node の default) のままで OK。
        },
        (info) => {
          port = info.port
          resolve()
        },
      )
    } catch (e) {
      reject(e)
    }
  })

  const url = `http://127.0.0.1:${port}/?token=${token}`
  return {
    url,
    port,
    waitResult: () => resultPromise,
    getLastHeartbeat: () => lastHeartbeatAt,
    close: () => {
      try { server.close() } catch { /* noop */ }
    },
  }
}

// テスト用: listen せずに app.fetch を直接叩けるエントリ。
// port は引数で固定 (Host / Origin ヘッダの突き合わせのため)。
export type CreateTestAppResult = {
  app: Hono
  token: string
  port: number
}
export function createTestApp({
  html,
  port = 12345,
  sources,
}: {
  html: string
  port?: number
  sources?: SourcesMap
}): CreateTestAppResult {
  const token = randomBytes(32).toString('hex')
  const app = createApp({
    html,
    token,
    getPort: () => port,
    sources,
    // テストでは brute force しないので exit を抑止 (ガード自体は本番で機能する)。
    onBruteForce: () => { /* noop in tests */ },
    onResult: () => { /* tests use the e2e path for the resolve case */ },
  })
  return { app, token, port }
}
