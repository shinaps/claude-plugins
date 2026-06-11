// 127.0.0.1 bind の HTTP サーバー (Hono + @hono/node-server)。脅威モデルは 2 系統:
//
// [local モード (デフォルト)]
//   同一 PC 上で動く別ユーザーやプロセスからの覗き見を脅威モデルにし、4 層で防御する:
//   1. listen を 127.0.0.1 に固定 (localhost 別名や :: 経由を弾く)
//   2. Host ヘッダを 127.0.0.1:<port> と完全一致でチェック (DNS rebinding 対策)
//   3. 32 byte ランダム token を URL クエリで毎リクエスト検証
//   4. POST /result では Origin ヘッダも検証 (CSRF 対策)
//   token 検証失敗が 20 回貯まったらプロセスごと落として brute force 試行を断つ。
//
// [remote モード (opt-in)]
//   cloudflared Quick Tunnel が 127.0.0.1:<port> へ proxy し、https://xxx.trycloudflare.com の
//   公開 URL からスマホ等で開く。bind は 127.0.0.1 のまま (層 1 不変) で、層 2 / 4 に
//   setTunnelHost() で遅延注入された tunnel host を「追加許可」する (切替ではない —
//   cloudflared が落ちた時のローカル縮退先を残すため 127.0.0.1 も引き続き許可)。
//   TLS は Cloudflare が終端し、実質の認証は「推測不能な 32 byte token + ランダムサブドメイン」。
//   brute force 閾値は 1000 に緩和する: 公開 URL はクローラー等の token 無しアクセスを受けるため、
//   20 のままだと無関係なアクセス 20 回でレビューセッションが自爆する DoS ベクタになる
//   (32 byte hex token に対して 1000 回の試行では推測不能なので、hammering 遮断の目的は保たれる)。
//   残余リスク: token 入り URL を第三者サービス (メッセンジャー等) へ転送すると、その
//   link preview bot が GET / を fetch して diff 全文 HTML を取得し得る。これはサーバー側では
//   防げないため、SKILL.md が「URL は Claude 会話以外へ転送しない」運用警告でカバーする。
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
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import type { MiddlewareHandler } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import type { EditorPreset, ResultJson } from '@show-me/diff-shared'

const MAX_TOKEN_FAILURES = 20
// remote モードの brute force 閾値 (緩和理由は冒頭の脅威モデルコメント参照)
const MAX_TOKEN_FAILURES_REMOTE = 1000
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
  // v5: editor preset を server 側のみで保持する。クライアントには editorAvailable: boolean だけ
  // を払い出し、command 文字列はサーバを抜けない (CR-3)。null の場合は /editor-open は 503 で返す。
  editorPreset?: EditorPreset | null
  // remote モード (brute force 閾値の切替に使う)。詳細は冒頭の脅威モデルコメント参照。
  remote?: boolean
  // cloudflared tunnel の host (例: 'xxx.trycloudflare.com')。tunnel URL は cloudflared 起動後に
  // しか判明しないため、getPort() と同じ遅延参照で受け取る。null の間は local URL のみ許可。
  getTunnelHost?: () => string | null
}

export function createApp(opts: CreateAppOptions): Hono {
  const { html, getPort, token, onResult, onHeartbeat } = opts
  const sources: SourcesMap = opts.sources ?? new Map()
  const editorPreset: EditorPreset | null = opts.editorPreset ?? null
  const onBruteForce = opts.onBruteForce ?? (() => setTimeout(() => process.exit(1), 50))
  const getTunnelHost = opts.getTunnelHost ?? (() => null)
  const maxTokenFailures = opts.remote ? MAX_TOKEN_FAILURES_REMOTE : MAX_TOKEN_FAILURES

  let failCount = 0
  const app = new Hono()

  // 1. セキュリティヘッダ (全レスポンスに付与)。Hono 標準の secureHeaders に寄せる。
  // HSTS は http://127.0.0.1 配信ではブラウザが無視する (HTTPS 限定の仕様) ため無効化。
  app.use(
    '*',
    secureHeaders({
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      strictTransportSecurity: false,
      // inline 化された script/style だけを許可。外部リソースは一切ロードできない。
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'unsafe-inline'"],
        styleSrc: ["'unsafe-inline'"],
        imgSrc: ['data:'],
        connectSrc: ["'self'"],
        formAction: ["'none'"],
      },
    }),
  )
  // Cache-Control は secureHeaders の守備範囲外なのでここだけ手動で付与する
  // (token 入り URL のレスポンスをディスクキャッシュに残させない)。
  app.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  })

  // 2. Host header 検証 (DNS rebinding / localhost 別名対策)。
  // 127.0.0.1:<port> に加え、remote モードで tunnel host が確定していればそれも許可する
  // (OR 判定 = 追加であって切替ではない。冒頭の脅威モデルコメント参照)。
  const hostCheck: MiddlewareHandler = async (c, next) => {
    const host = c.req.header('host') ?? ''
    const tunnelHost = getTunnelHost()
    const allowed =
      host === `127.0.0.1:${getPort()}`
      || (tunnelHost != null && host === tunnelHost)
    if (!allowed) {
      return c.text('forbidden', 403)
    }
    await next()
  }
  app.use('*', hostCheck)

  // 3. token 検証 + brute force ガード (20 回失敗で onBruteForce、デフォルトはプロセス自爆)
  const tokenCheck: MiddlewareHandler = async (c, next) => {
    if (c.req.query('token') !== token) {
      failCount++
      if (failCount >= maxTokenFailures) {
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
    const tunnelHost = getTunnelHost()
    // tunnel 経由は Cloudflare が TLS 終端するため Origin は必ず https になる
    const allowed =
      origin === `http://127.0.0.1:${getPort()}`
      || (tunnelHost != null && origin === `https://${tunnelHost}`)
    if (!allowed) {
      return c.text('forbidden', 403)
    }
    await next()
  }
  app.use('*', originCheck)

  // 5. gzip / deflate 圧縮 (Web Streams ベース、Node 22.8+ で動く前提)
  // GET / の HTML レスポンスだけ対象になれば十分なので、全ルートにかけても害は無い。
  app.use('*', compress())

  // GET / → HTML を返す
  app.get('/', (c) => c.html(html))

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
  // セキュリティ: middleware で token / Host を既に検証済み。query の path は Map の key
  // 完全一致で引くだけなのでパストラバーサルにはならない (filesystem を直接見ない設計)。
  app.get('/source', (c) => {
    const filePath = c.req.query('path') ?? ''
    const side = c.req.query('side') ?? ''
    const startStr = c.req.query('start') ?? ''
    const endStr = c.req.query('end') ?? ''
    if (side !== 'before' && side !== 'after') return c.text('bad side', 400)
    const start = Number(startStr)
    const end = Number(endStr)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return c.text('bad range', 400)
    }
    const src = sources.get(filePath)
    if (!src) return c.text('not found', 404)
    const text = side === 'before' ? src.before : src.after
    const lines = text.split('\n')
    // 末尾改行で 1 つ余分な空文字列が出るパターンを許容しつつ、
    // 範囲超過は 400 で明示する (UI 側にバグがあった時に気付けるように)。
    if (end > lines.length) return c.text('range out of bounds', 400)
    return c.text(lines.slice(start - 1, end).join('\n'))
  })

  // POST /result → JSON 受信 → 200 を返し切ってから resolve (ブラウザに描画余地を残す)
  //
  // decision='regen-group' もここで受け取る。CLI 側は decision を見ずに
  // ResultJson をそのまま resolve するので、SKILL.md が JSON.parse で分岐する設計。
  // approve / reject と同じ close-relaunch ルートで動くので endpoint 追加不要。
  // body size ガードは Hono 標準の bodyLimit に委譲。Content-Length が無いリクエストでも
  // ストリームを実測カウントして上限超過なら 413 を返す。
  app.post('/result', bodyLimit({ maxSize: MAX_BODY }), async (c) => {
    let json: ResultJson
    try {
      json = await c.req.json<ResultJson>()
    } catch {
      return c.text('bad json', 400)
    }
    // RESULT_SETTLE_MS の猶予をブラウザ描画用に挟んでから resolve する。
    setTimeout(() => onResult(json), RESULT_SETTLE_MS)
    return c.json({ ok: true })
  })

  // POST /editor-open → editor preset の CLI command で対象ファイルを開く (v5 機能 2)。
  //   - editorPreset が null の場合は 503 を返してクライアントは Toast のみ
  //   - body: { path: string, line: number }
  //   - shell escape を厳格に行い、cwd を明示し、relative path は cwd 基準で resolve
  //   - 子プロセスを detached + unref で完全に切り離す (CLI exit 後も editor は生きる)
  app.post('/editor-open', bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    let payload: { path?: unknown; line?: unknown }
    try {
      payload = await c.req.json<{ path?: unknown; line?: unknown }>()
    } catch {
      return c.text('bad json', 400)
    }
    if (typeof payload.path !== 'string' || !Number.isFinite(payload.line as number)) {
      return c.text('bad payload', 400)
    }
    const lineNum = Math.max(1, Math.floor(payload.line as number))
    if (!editorPreset) {
      // editor 未設定: クライアントは Toast の clipboard コピーだけで完結する
      return c.json({ ok: false, reason: 'editor not configured' }, 503)
    }
    const absPath = path.resolve(process.cwd(), payload.path)
    const escapedPath = shellEscape(absPath)
    const cmd = editorPreset.command
      .replaceAll('{path}', escapedPath)
      .replaceAll('{line}', String(lineNum))
    try {
      const child = spawn('sh', ['-c', cmd], {
        stdio: 'ignore',
        detached: true,
        cwd: process.cwd(),
        env: process.env,
      })
      child.unref()
    } catch (e) {
      process.stderr.write(`[show-me:diff] editor open failed: ${cmd}: ${(e as Error).message}\n`)
      return c.json({ ok: false, reason: 'spawn failed' }, 500)
    }
    return c.json({ ok: true })
  })

  return app
}

// shellEscape: POSIX 標準パターン (closing quote + escaped quote + opening quote)。
// 任意のバイト列を単一引用符で囲み、内側の `'` を `'\''` に置換することで bash / dash / zsh で
// 安全な引数になる。`$`, `;`, `&&`, `|`, space, newline すべて含めて 1 トークンとして扱われる。
function shellEscape(s: string): string {
  return `'${s.replaceAll(`'`, `'\\''`)}'`
}

export type StartServerOptions = {
  html: string
  sources?: SourcesMap
  // 現状はクライアントペイロード経由で expandable を伝えるため、server 自体は値を保持しない。
  // 将来 server 側で expandable に応じた挙動分岐が必要になれば opts に追加する。
  expandable?: boolean
  // v5: editor preset (server 側でのみ保持、CR-3)
  editorPreset?: EditorPreset | null
  // remote モード (brute force 閾値を緩和し、setTunnelHost で tunnel host を後付け許可できる)
  remote?: boolean
}
export type StartedServer = {
  url: string
  port: number
  waitResult: () => Promise<ResultJson>
  // 最後にブラウザから /heartbeat が来た時刻 (Date.now() 形式)。CLI 側で「タブが閉じられたか」を
  // 検知するために poll する。未受信の場合は null (初回 ping が来るまでの猶予期間)。
  getLastHeartbeat: () => number | null
  // cloudflared 起動後に判明した tunnel host を Host / Origin 検証の許可リストへ注入する。
  // 注入前に tunnel URL が配布されることはない (CLI は setTunnelHost してから URL を出力する)
  // ため、検証すり抜けの競合ウィンドウは存在しない。
  setTunnelHost: (host: string) => void
  close: () => void
}

export async function startServer(opts: StartServerOptions): Promise<StartedServer> {
  const { html, sources, editorPreset, remote } = opts
  const token = randomBytes(32).toString('hex')

  let resolveResult!: (r: ResultJson) => void
  const resultPromise = new Promise<ResultJson>((r) => {
    resolveResult = r
  })

  // serve() callback で実 port が判明するまで getPort() の参照先を遅延しておく。
  let port = 0
  let lastHeartbeatAt: number | null = null
  // tunnel host も port と同じ遅延注入 (cloudflared 起動後に setTunnelHost で確定する)
  let tunnelHost: string | null = null

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
    editorPreset,
    remote,
    getTunnelHost: () => tunnelHost,
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
    setTunnelHost: (host) => {
      tunnelHost = host
    },
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
  // startServer の setTunnelHost と同じ遅延注入をテストで再現するための setter
  setTunnelHost: (host: string) => void
}
export function createTestApp({
  html,
  port = 12345,
  sources,
  remote,
  tunnelHost = null,
  onBruteForce,
}: {
  html: string
  port?: number
  sources?: SourcesMap
  remote?: boolean
  tunnelHost?: string | null
  onBruteForce?: () => void
}): CreateTestAppResult {
  const token = randomBytes(32).toString('hex')
  let currentTunnelHost = tunnelHost
  const app = createApp({
    html,
    token,
    getPort: () => port,
    sources,
    remote,
    getTunnelHost: () => currentTunnelHost,
    // テストでは brute force でプロセスを落とさない (閾値テストは onBruteForce 差し替えで観測する)。
    onBruteForce: onBruteForce ?? (() => { /* noop in tests */ }),
    onResult: () => { /* tests use the e2e path for the resolve case */ },
  })
  return { app, token, port, setTunnelHost: (host) => { currentTunnelHost = host } }
}
