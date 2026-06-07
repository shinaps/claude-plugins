// CLI エントリ (v4.7.0 panel model)。
//
// 呼ばれ方:  node "$CLI" --summary <path> --diff <path> [--pr-meta <path>] [--channels-enabled]
//
// stdout / stderr 分離方針 (継続):
//   呼び出し側はサブプロセスの stdout を「結果」として丸ごとパースしたい。
//   情報メッセージが stdout に混ざるとパースが詰むため、ログは確実に stderr へ送る。
//
// v4.7.0 pipeline:
//   1. validateSummarySchema (zod + legacy 検出): legacy v4.6 は migration メッセージ付きで exit 1
//   2. parseDiff → FileChange[] (asIs/toBe 別軸の changed lines)
//   3. collectAllPanelPaths: panel が言及する全 file (asIs.file + toBe.file) + rename oldPath を union
//   4. collectStagedSources / collectPrSources: 上記 paths の before/after 原文を取得
//   5. validateCoverage: panel が diff の changed lines を網羅しているか厳格検証 (miss → exit 1)
//   6. renderPanel: 各 panel を side-by-side RenderedPanel に展開
//   7. buildHtml: ClientPayload を inline した HTML 生成
//   8. startServer: Hub サーバ起動。channelsEnabled=true なら active/<sessionId>.json も書き出し
//   9. waitResult (タイムアウト 9 分) → 結果を stdout に 1 行 JSON で吐く

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { spawn, spawnSync } from 'node:child_process'
import type { ResultJson, PrMeta, SummaryJson, Panel } from '@zeus/review-diff-shared'
import {
  parseDiff,
  validateSummarySchema,
  validateCoverage,
  formatMissesForStderr,
  renderPanel,
  SchemaError,
  type SourcesMap,
} from '@zeus/review-diff-server'
import { buildHtml } from './template'
import { openUrl } from './open'

const TIMEOUT_MS = 9 * 60 * 1000 // Bash ツールが 10 分で打ち切るため、1 分早めに自爆して整合性を取る

// gh api への並列度上限。GitHub の rate limit (authenticated 5000 req/hour) に余裕を残しつつ、
// N ファイル × 2 (base/head) の blob 取得を現実的な時間で終わらせるための値。
// 大きすぎると rate limit で 403 が増え、小さすぎると待ち時間が伸びる。経験則で 8。
const PR_FETCH_CONCURRENCY = 8

// ~/.claude/zeus/review-diffs/active/<sessionId>.json の格納場所。
// Process A (channel-server.js) はここを 5 秒間隔で走査して生存 session を把握する。
const ACTIVE_DIR = join(homedir(), '.claude/zeus/review-diffs/active')

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      summary: { type: 'string' },
      diff: { type: 'string' },
      'pr-meta': { type: 'string' },
      // Claude Code Channels 経路を有効化する opt-in フラグ。
      // research preview なので未指定 (= false) がデフォルト。SKILL.md Phase 5 が
      // Claude Code v2.1.80+ かつ --dangerously-load-development-channels が利用可能な
      // 環境でだけ true を渡すように案内する。
      'channels-enabled': { type: 'boolean', default: false },
    },
  })

  if (!values.summary || !values.diff) {
    process.stderr.write('Usage: cli --summary <path> --diff <path> [--pr-meta <path>] [--channels-enabled]\n')
    process.exit(1)
  }

  // 1. summary.json: parse → zod 検証 → legacy detection。
  //    legacy v4.6 schema は SchemaError + migration メッセージで exit 1。
  let rawSummary: unknown
  try {
    rawSummary = JSON.parse(readFileSync(values.summary, 'utf8'))
  } catch (e) {
    process.stderr.write(`failed to parse summary.json: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }

  let summary: SummaryJson
  try {
    summary = validateSummarySchema(rawSummary).summary
  } catch (e) {
    if (e instanceof SchemaError) {
      process.stderr.write(e.message + '\n')
    } else {
      process.stderr.write(`summary.json validation failed: ${e instanceof Error ? e.message : String(e)}\n`)
    }
    process.exit(1)
  }

  const diffText = readFileSync(values.diff, 'utf8')
  const prMeta: PrMeta | null = values['pr-meta']
    ? (JSON.parse(readFileSync(values['pr-meta'], 'utf8')) as PrMeta)
    : null

  const lineCount = diffText.split('\n').length
  process.stderr.write(`[review-diff] parsing ${lineCount} diff lines (highlight runs in browser)...\n`)

  // 2. diff parse → FileChange[]
  const changes = parseDiff(diffText)

  // 3. 全 panel が言及する path を union (asIs.file ∪ toBe.file ∪ rename oldPath)。
  //    rename + 内容変更の panel が asIs.file = oldPath で書かれている時、その oldPath も
  //    sources 取得対象に入れる必要があるため、changes.oldPath も合流する。
  const allPanelPaths = collectAllPanelPaths(summary, changes.map(c => c.oldPath).filter(Boolean) as string[])

  // 4. sources 取得
  let expandable = false
  let sources: SourcesMap = new Map()
  if (summary.mode === 'staged' && !prMeta) {
    sources = collectStagedSources(allPanelPaths)
    expandable = true
  } else if (summary.mode === 'pr' && prMeta && canFetchPrSources(prMeta)) {
    const fetched = await collectPrSources(allPanelPaths, prMeta)
    if (fetched.size > 0) {
      sources = fetched
      expandable = true
    } else {
      process.stderr.write('[review-diff] PR source fetch failed entirely; expand will be disabled\n')
    }
  }

  // 5. coverage 厳格検証。miss があれば stderr に詳細出して exit 1 (AC-3)。
  const allPanels: Panel[] = summary.groups.flatMap(g => g.panels)
  const cov = validateCoverage({ changes, panels: allPanels })
  if (cov.warnings.length > 0) {
    process.stderr.write(formatMissesForStderr({ ok: true, misses: [], warnings: cov.warnings }) + '\n')
  }
  if (!cov.ok) {
    process.stderr.write(formatMissesForStderr(cov) + '\n')
    process.exit(1)
  }

  // 6. 各 panel を side-by-side に展開
  const renderedGroups = summary.groups.map(g => ({
    title: g.title,
    description: g.description,
    panels: g.panels.map(p => renderPanel(p, sources)),
  }))

  // 7. channels 設定 + sessionId + token 確定
  // browserToken は ClientPayload に埋め込むため、startServer に渡す前にここで生成し、
  // startServer に opts.browserToken として明示的に渡す (同じ token を payload と server で共有)。
  const channelsEnabled = !!values['channels-enabled']
  const sessionId = randomBytes(8).toString('hex')
  const browserToken = randomBytes(32).toString('hex')
  const channelToken = randomBytes(32).toString('hex')

  // 8. HTML 生成 + サーバ起動
  const html = buildHtml({
    schemaVersion: 1,
    summary,
    prMeta,
    groups: renderedGroups,
    allPanels: allPanels.map(p => p.panelId),
    expandable,
    channelsEnabled,
    sessionId,
    browserToken,
  })

  const started = await startServerAndMaybeRegister({
    html,
    sources,
    expandable,
    channelsEnabled,
    sessionId,
    browserToken,
    channelToken,
  })

  process.stderr.write(`[review-diff] URL: ${started.url}\n`)
  if (channelsEnabled) {
    process.stderr.write(`[review-diff] channels enabled; session=${sessionId}\n`)
  }
  process.stderr.write(`[review-diff] waiting up to ${TIMEOUT_MS / 1000}s for decision...\n`)
  openUrl(started.url)

  const timeoutResult: ResultJson = { decision: 'timeout', reviewedPanels: [], comments: [] }
  const result: ResultJson = await Promise.race([
    started.waitResult(),
    new Promise<ResultJson>((r) => setTimeout(() => r(timeoutResult), TIMEOUT_MS)),
  ])

  try {
    const resultPath = `${dirname(values.summary)}/result.json`
    writeFileSync(resultPath, JSON.stringify(result, null, 2))
  } catch {
    /* noop */
  }

  process.stdout.write(JSON.stringify(result) + '\n')
  setTimeout(() => process.exit(0), 100)
}

// startServer + active/<sessionId>.json の atomic write + cleanup hook をまとめたヘルパ。
// channelsEnabled=false なら active/ への書き出しは skip し、startServer の戻り値だけ返す。
async function startServerAndMaybeRegister(params: {
  html: string
  sources: SourcesMap
  expandable: boolean
  channelsEnabled: boolean
  sessionId: string
  browserToken: string
  channelToken: string
}): Promise<{ url: string; waitResult: () => Promise<ResultJson> }> {
  // server を遅延 import するのは esbuild bundle で循環参照を避けるため (cli は server に
  // 依存するが、server の test 経路で cli を import される副作用回避)。
  const { startServer } = await import('@zeus/review-diff-server')
  const started = await startServer({
    html: params.html,
    sources: params.sources,
    expandable: params.expandable,
    channelsEnabled: params.channelsEnabled,
    browserToken: params.browserToken,
    channelToken: params.channelToken,
  })

  if (params.channelsEnabled) {
    writeActiveSessionFile(params.sessionId, {
      sessionId: params.sessionId,
      pid: process.pid,
      hubUrl: `http://127.0.0.1:${started.port}`,
      browserToken: started.browserToken,
      channelToken: started.channelToken,
      createdAt: Date.now(),
    })

    // cleanup hook: 通常終了 / SIGINT / SIGTERM で active/<sessionId>.json を unlink する。
    // SIGKILL (kill -9) では呼ばれないため、Process A 側で process.kill(pid, 0) による
    // 生存確認 + 死亡 session の unlink で stale を回収する設計 (channel-server.ts 側)。
    const cleanup = () => {
      try { unlinkSync(join(ACTIVE_DIR, `${params.sessionId}.json`)) } catch { /* race OK */ }
    }
    process.on('exit', cleanup)
    process.on('SIGINT', () => { cleanup(); process.exit(130) })
    process.on('SIGTERM', () => { cleanup(); process.exit(143) })
  }

  return { url: started.url, waitResult: started.waitResult }
}

// atomic write: 同ディレクトリの hidden tmp ファイルに書き出してから rename する。
// rename は同一ファイルシステム内で atomic に振る舞うため、Process A が走査中に
// 途中 write の half-written JSON を読む事故が起きない。
function writeActiveSessionFile(sessionId: string, env: {
  sessionId: string
  pid: number
  hubUrl: string
  browserToken: string
  channelToken: string
  createdAt: number
}): void {
  mkdirSync(ACTIVE_DIR, { recursive: true })
  const finalPath = join(ACTIVE_DIR, `${sessionId}.json`)
  const tmpPath = join(ACTIVE_DIR, `.${sessionId}.json.tmp`)
  writeFileSync(tmpPath, JSON.stringify(env, null, 2))
  renameSync(tmpPath, finalPath)
}

// 全 panel が言及する file path を集約。asIs.file + toBe.file + rename oldPath を union。
//   - asIs.file: deletion 軸のレンダリングに必要 (rename の場合は oldPath とほぼ同義)
//   - toBe.file: addition 軸のレンダリングに必要
//   - changeOldPaths: rename 時の oldPath。AI が asIs.file = newPath と書いてしまった場合でも
//                     before 原文を取得しておく必要があるため (coverage-validator が rename サジェスト
//                     を出すケースで sources を表示できるように)
function collectAllPanelPaths(summary: SummaryJson, changeOldPaths: string[]): string[] {
  const set = new Set<string>()
  for (const g of summary.groups) {
    for (const p of g.panels) {
      if (p.asIs) set.add(p.asIs.file)
      if (p.toBe) set.add(p.toBe.file)
    }
  }
  for (const op of changeOldPaths) set.add(op)
  return [...set]
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
// 経路自体は v4.6 から変更なし (収集対象 path だけが allPanelPaths に変わる)。
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
      if (r.before === '' && r.after === '') continue
      out.set(r.path, { before: r.before, after: r.after })
    }
  }

  const ms = Date.now() - t0
  process.stderr.write(`[review-diff] PR source fetch done in ${(ms / 1000).toFixed(1)}s (${out.size}/${paths.length} files)\n`)
  return out
}

function fetchPrBlob(repoNameWithOwner: string, sha: string, path: string): Promise<string> {
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
    child.on('error', () => resolve(''))
    child.on('close', (code) => {
      if (code !== 0) {
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
