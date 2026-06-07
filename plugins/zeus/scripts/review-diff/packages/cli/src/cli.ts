// CLI エントリ。Bash ツールから node "$CLI" --summary ... --diff ... [--pr-meta ...] で呼ばれる。
// 結果は stdout に 1 行の JSON、それ以外のログ (URL、進捗) は stderr へ。
// なぜ stdout / stderr を厳密に分離するか:
//   呼び出し側はサブプロセスの stdout を「結果」として丸ごとパースしたい。
//   情報メッセージが stdout に混ざるとパースが詰むため、ログは確実に stderr へ送る。

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { spawn, spawnSync } from 'node:child_process'
import { countLines, getRefKind, type SummaryJson, type ResultJson, type PrMeta, type DisplayRange } from '@zeus/review-diff-shared'
import { parseDiff, composeHunks, startServer, type SourcesMap } from '@zeus/review-diff-server'
import { buildHtml } from './template'
import { openUrl } from './open'

const TIMEOUT_MS = 9 * 60 * 1000 // Bash ツールが 10 分で打ち切るため、1 分早めに自爆して整合性を取る

// 隣接 hunk 間の gap がこの行数以下なら、CLI 側で 1 つの表示単位に統合する。
// 「変更ハンクの間に 5-10 行 unchanged が挟まる」程度なら最初から繋げて見せた方が
// レビューしやすい (zeus:review-diff の設計哲学: ユーザーに読ませる量を増やさず差分表示の工夫で語る)。
// 10 行は GitHub PR / Linear の expand behavior に近く、保守的に効く目安。
const AUTO_BRIDGE_THRESHOLD = 10

// gh api への並列度上限。GitHub の rate limit (authenticated 5000 req/hour) に余裕を残しつつ、
// N ファイル × 2 (base/head) の blob 取得を現実的な時間で終わらせるための値。
// 大きすぎると rate limit で 403 が増え、小さすぎると待ち時間が伸びる。経験則で 8。
const PR_FETCH_CONCURRENCY = 8

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      summary: { type: 'string' },
      diff: { type: 'string' },
      'pr-meta': { type: 'string' },
    },
  })

  if (!values.summary || !values.diff) {
    process.stderr.write('Usage: cli --summary <path> --diff <path> [--pr-meta <path>]\n')
    process.exit(1)
  }

  const summary: SummaryJson = JSON.parse(readFileSync(values.summary, 'utf8'))
  const diffText = readFileSync(values.diff, 'utf8')
  const prMeta: PrMeta | null = values['pr-meta']
    ? (JSON.parse(readFileSync(values['pr-meta'], 'utf8')) as PrMeta)
    : null

  const lineCount = diffText.split('\n').length
  process.stderr.write(`[review-diff] parsing ${lineCount} diff lines (highlight runs in browser)...\n`)

  // なぜ Shiki を CLI 側で呼ばないか:
  //   GitHub/GitLab と同様にハイライトはクライアントの責務に倒した。
  //   サーバ/CLI は raw text と language hint だけを ParsedFile に詰める。
  const files = parseDiff(diffText)
  const allFiles = files.map((f) => f.path)

  // unchanged 行 lazy 展開の有効化判定:
  //   staged: git show :path / HEAD:path で worktree から原文を取れる
  //   pr:     gh api 経由で base/head SHA の blob を取得 (pr-meta が必要な情報を持っている場合のみ)
  // どちらの経路でも sources Map が空 (= /source が 404) になればクライアント側がバナーを
  // "Expand unavailable" 表示にフォールバックする。
  let expandable = false
  let sources: SourcesMap = new Map()
  if (summary.mode === 'staged' && !prMeta) {
    sources = collectStagedSources(allFiles)
    expandable = true
  } else if (summary.mode === 'pr' && prMeta && canFetchPrSources(prMeta)) {
    const fetched = await collectPrSources(allFiles, prMeta)
    if (fetched.size > 0) {
      sources = fetched
      expandable = true
    } else {
      // gh api が全滅した場合 (gh 未インストール / 認証切れ / rate limit など) はフォールバック。
      // バナーは出るがクリックしても展開できない、という従来 PR モードの挙動に戻る。
      process.stderr.write('[review-diff] PR source fetch failed entirely; expand will be disabled\n')
    }
  }

  // sources Map (before/after の原文) を握っている場合、after の総行数を ParsedFile.afterTotal に
  // 注入してクライアント側で「最後の hunk 〜 ファイル末尾」までの unchanged バナーを描画できるようにする。
  // sources に無い (= 取得失敗 / 削除ファイル) ファイルは afterTotal undefined のままにし、末尾バナーを省く。
  for (const f of files) {
    const src = sources.get(f.path)
    if (!src || !src.after) continue
    f.afterTotal = countLines(src.after)
  }

  // summary.groups から path → DisplayRange[] のマップを構築。
  // 同一 path が複数 group / 複数 entry に分散していたら union を取る。
  // string 形式 (= ファイル全体) や hunks 指定 (= 既存 low-level 指定) は除外、
  // displayRanges 形式だけを集める。
  const rangesByPath = collectDisplayRanges(summary)

  // composeHunks で「表示単位の Hunk 列」に再編する:
  //   - sources がある file: displayRanges を反映 + 小 gap を auto-bridge
  //   - sources が無い file: no-op (元の hunks のまま、graceful degrade)
  const composedFiles = files.map((f) =>
    composeHunks({
      file: f,
      source: sources.get(f.path),
      displayRanges: rangesByPath.get(f.path),
      autoBridgeThreshold: AUTO_BRIDGE_THRESHOLD,
    }),
  )

  // composeHunks 後の hunk 数を集計してログる (デバッグ性)。
  const counts = composedFiles.reduce(
    (acc, f) => {
      for (const h of f.hunks) {
        const k = h.origin ?? 'changed'
        acc[k] = (acc[k] ?? 0) + 1
      }
      return acc
    },
    { changed: 0, 'ai-context': 0, 'auto-bridge': 0 } as Record<string, number>,
  )
  process.stderr.write(
    `[review-diff] composed hunks: changed=${counts.changed} ai-context=${counts['ai-context']} auto-bridge=${counts['auto-bridge']}\n`,
  )

  const html = buildHtml({ summary, prMeta, files: composedFiles, allFiles, expandable })

  const { url, waitResult } = await startServer({ html, sources, expandable })
  process.stderr.write(`[review-diff] URL: ${url}\n`)
  process.stderr.write(`[review-diff] waiting up to ${TIMEOUT_MS / 1000}s for decision...\n`)
  openUrl(url)

  const timeoutResult: ResultJson = { decision: 'timeout', reviewedFiles: [], comments: [] }
  const result: ResultJson = await Promise.race([
    waitResult(),
    new Promise<ResultJson>((r) => setTimeout(() => r(timeoutResult), TIMEOUT_MS)),
  ])

  // result.json は呼び出し側からも参照できるようにディスクにも残しておく (デバッグ性向上)。
  // 失敗してもパイプ経由の結果伝達自体は途切れないので例外は握り潰す。
  try {
    const resultPath = `${dirname(values.summary)}/result.json`
    writeFileSync(resultPath, JSON.stringify(result, null, 2))
  } catch {
    /* noop */
  }

  process.stdout.write(JSON.stringify(result) + '\n')
  // openUrl で detach した子プロセスや未解放ハンドルでイベントループが残るケースに備え、明示終了。
  setTimeout(() => process.exit(0), 100)
}

// summary.groups を走査し、各 file への DisplayRange[] を集約する。
// 同じ path が複数 group / 複数 entry に分かれている場合は素朴に concat (composeHunks 側で
// sort + merge してくれるので、ここで重複排除する必要は無い)。
// 判別は shared/getRefKind を通すことで client (App.tsx:buildBuckets) と挙動を統一する (W1)。
// hunks と displayRanges が併用された不正 ref を検出したら stderr 警告 (I2)。
function collectDisplayRanges(summary: SummaryJson): Map<string, DisplayRange[]> {
  const out = new Map<string, DisplayRange[]>()
  for (const group of summary.groups ?? []) {
    for (const ref of group.files ?? []) {
      if (typeof ref !== 'string' && 'hunks' in ref && 'displayRanges' in ref) {
        process.stderr.write(
          `[review-diff:compose] WARN: ${ref.path} で hunks と displayRanges が併用されています。displayRanges を優先します。\n`,
        )
      }
      const kind = getRefKind(ref)
      if (kind.kind !== 'ranges') continue
      const prev = out.get(kind.path) ?? []
      out.set(kind.path, [...prev, ...kind.displayRanges])
    }
  }
  return out
}

// staged モード: 各ファイルの「現在 index にある内容 (after)」と「HEAD の内容 (before)」を
// git show で取得する。新規ファイル → HEAD 側が無い、削除ファイル → index 側が無い、
// などのケースで git show が非 0 終了するが、その側を空文字列にしてもう一方だけ展開できれば
// 十分なので例外にせず空文字列でフォールバックする。
function collectStagedSources(paths: string[]): SourcesMap {
  const out: SourcesMap = new Map()
  for (const path of paths) {
    const after = gitShow(`:${path}`)
    const before = gitShow(`HEAD:${path}`)
    out.set(path, { before, after })
  }
  return out
}

function gitShow(ref: string): string {
  const r = spawnSync('git', ['show', ref], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
  if (r.status !== 0) return ''
  return r.stdout
}

// PR モード: gh api 経由で base/head SHA の blob を取得して sources Map を作る。
// ファイル数 × 2 (before/after) 回の API call が走るので、rate limit と所要時間のバランスを
// 取るため PR_FETCH_CONCURRENCY で並列化する。失敗 (新規ファイルで base に無い、削除ファイルで
// head に無い、API エラー) はその側を空文字列にして fallback、上位 expandable 判定で全滅時のみ
// バナーをクリック不可にする。
function canFetchPrSources(prMeta: PrMeta): boolean {
  return Boolean(prMeta.baseRefOid && prMeta.headRefOid && prMeta.headRepository?.nameWithOwner)
}

async function collectPrSources(paths: string[], prMeta: PrMeta): Promise<SourcesMap> {
  const repo = prMeta.headRepository!.nameWithOwner
  const baseSha = prMeta.baseRefOid!
  const headSha = prMeta.headRefOid!
  const t0 = Date.now()
  process.stderr.write(
    `[review-diff] fetching ${paths.length} files from ${repo} (PR #${prMeta.number}) via gh api...\n`,
  )

  const out: SourcesMap = new Map()
  // 並列度 PR_FETCH_CONCURRENCY で chunk 実行。Promise.all で一斉投入し続けるより、
  // chunk 区切りの方が gh CLI の同時 spawn 数を抑えやすい (子プロセスが重いので)。
  for (let i = 0; i < paths.length; i += PR_FETCH_CONCURRENCY) {
    const chunk = paths.slice(i, i + PR_FETCH_CONCURRENCY)
    const results = await Promise.all(
      chunk.map(async (path) => {
        const [before, after] = await Promise.all([
          fetchPrBlob(repo, baseSha, path),
          fetchPrBlob(repo, headSha, path),
        ])
        return { path, before, after }
      }),
    )
    for (const r of results) {
      // before / after 両方空 = この path は API 全滅。それでも Map に入れておくと
      // /source エンドポイントは 400 (range out of bounds) を返すだけになるが、
      // それより 404 を返した方が UI が "Expand unavailable" を出せて挙動が一貫する。
      if (r.before === '' && r.after === '') continue
      out.set(r.path, { before: r.before, after: r.after })
    }
  }

  const ms = Date.now() - t0
  process.stderr.write(`[review-diff] PR source fetch done in ${(ms / 1000).toFixed(1)}s (${out.size}/${paths.length} files)\n`)
  return out
}

function fetchPrBlob(repoNameWithOwner: string, sha: string, path: string): Promise<string> {
  // gh api -H "Accept: application/vnd.github.raw" /repos/{owner}/{repo}/contents/{path}?ref={sha}
  // raw media type を要求することで GitHub Contents API が JSON ラッパー無しの生バイトを返す。
  // path はクエリではなく URL path 要素なので encodeURIComponent 不可 ('/' を保持したい)。
  // 代わりに各セグメントだけエンコードする。
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const args = [
    'api',
    '-H',
    'Accept: application/vnd.github.raw',
    `/repos/${repoNameWithOwner}/contents/${encodedPath}?ref=${sha}`,
  ]
  return new Promise((resolve) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.on('error', () => resolve('')) // gh 未インストール等
    child.on('close', (code) => {
      if (code !== 0) {
        // 新規ファイル → base 側で 404、削除ファイル → head 側で 404 が頻発するため、
        // エラーログは出さず空文字列で素直に fallback する (上位で sources の空判定)。
        resolve('')
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e)
  process.stderr.write(`error: ${msg}\n`)
  process.exit(2)
})
