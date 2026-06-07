// CLI エントリ (v4.8.0 panel model)。
//
// 呼ばれ方:  node "$CLI" --summary <path> --diff <path> [--pr-meta <path>] [--restore-state <path>]
//
// v4.8.0 で Channels インフラを全廃したので、ACTIVE_DIR / sessionId / browserToken /
// channelToken / SIGINT cleanup hook は消滅した。代わりに --restore-state を追加し、
// SKILL.md が close-relaunch ループで前回の Reviewed + line comments + 未保存 draft を
// 注入できるようにしてある。--restore-state を知らない旧 SKILL.md からの fallback 互換も
// parseArgs の strict:false で吸収する。
//
// stdout / stderr 分離方針 (継続):
//   呼び出し側はサブプロセスの stdout を「結果」として丸ごとパースしたい。
//   情報メッセージが stdout に混ざるとパースが詰むため、ログは確実に stderr へ送る。
//
// v4.8.0 pipeline:
//   1. validateSummarySchema (zod + legacy 検出): legacy v4.6 は migration メッセージ付きで exit 1
//   2. parseDiff → FileChange[] (asIs/toBe 別軸の changed lines)
//   3. collectAllPanelPaths: panel が言及する全 file (asIs.file + toBe.file) + rename oldPath を union
//   4. collectStagedSources / collectPrSources: 上記 paths の before/after 原文を取得
//   5. validateCoverage: panel が diff の changed lines を網羅しているか厳格検証 (miss → exit 1)
//   6. renderPanel: 各 panel を side-by-side RenderedPanel に展開
//   7. (任意) --restore-state を読んで ClientPayload.initial* に注入
//   8. buildHtml: ClientPayload を inline した HTML 生成
//   9. startServer: Hub サーバ起動
//  10. waitResult (タイムアウト 9 分) → 結果を stdout に 1 行 JSON で吐く

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { spawn, spawnSync } from 'node:child_process'
import type { ResultJson, PrMeta, SummaryJson, Panel, RenderedGroup, Comment } from '@zeus/review-diff-shared'
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

async function main(): Promise<void> {
  // parseArgs の strictOption は default true だが、unknown flag を渡された時に process が
  // 即落ちすると forward compatibility が失われる。SKILL.md と CLI のバージョンがズレた時に
  // 余計な flag を skip できるように strict:false に倒す (validation は handler 側で行う)。
  const { values } = parseArgs({
    options: {
      summary: { type: 'string' },
      diff: { type: 'string' },
      'pr-meta': { type: 'string' },
      // v4.8.0: regen-group の close-relaunch で、SKILL.md が書き出した restore JSON
      // (reviewedPanels / comments / lineCommentDrafts) を再起動後の CLI に渡すパス。
      // 初回起動 (regen ループの外) では未指定で OK。
      'restore-state': { type: 'string' },
    },
    strict: false,
  })

  if (!values.summary || !values.diff) {
    process.stderr.write('Usage: cli --summary <path> --diff <path> [--pr-meta <path>] [--restore-state <path>]\n')
    process.exit(1)
  }

  // 1. summary.json: parse → zod 検証 → legacy detection。
  //    legacy v4.6 schema は SchemaError + migration メッセージで exit 1。
  let rawSummary: unknown
  try {
    rawSummary = JSON.parse(readFileSync(values.summary as string, 'utf8'))
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

  const diffText = readFileSync(values.diff as string, 'utf8')
  const prMeta: PrMeta | null = values['pr-meta']
    ? (JSON.parse(readFileSync(values['pr-meta'] as string, 'utf8')) as PrMeta)
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
  //
  // W-1: groupId は title に依存せず index ベースの `g${i}` で生成する。同じ title の group が
  //   複数あっても key 衝突しない (App.tsx の React key と SKILL.md の regen-group 識別の両方で必要)。
  // I-4: renderPanel に summary.mode を渡し、staged / pr で sourcesUnavailable kind を分岐させる。
  const renderedGroups: RenderedGroup[] = summary.groups.map((g, i) => ({
    groupId: `g${i}`,
    title: g.title,
    description: g.description,
    panels: g.panels.map(p => renderPanel(p, sources, summary.mode)),
  }))

  // 7. restore state を読む (v4.8.0 close-relaunch)。
  //    restore.json は SKILL.md が前回 CLI 終了時に書き出すもので、形式は:
  //      { "reviewedPanels": string[], "comments": Comment[], "lineCommentDrafts": Record<string,string> }
  //    今回再生成された panels と panelId が一致するものだけが UI に活きる
  //    (panelId は intent 除外 hash なので、context+ で intent が書き直されても安定)。
  const restore = readRestoreState(values['restore-state'] as string | undefined)

  // 8. HTML 生成 + サーバ起動
  const html = buildHtml({
    schemaVersion: 1,
    summary,
    prMeta,
    groups: renderedGroups,
    allPanels: allPanels.map(p => p.panelId),
    expandable,
    initialReviewedPanels: restore?.reviewedPanels,
    initialComments: restore?.comments,
    initialLineCommentDrafts: restore?.lineCommentDrafts,
  })

  const { startServer } = await import('@zeus/review-diff-server')
  const started = await startServer({
    html,
    sources,
    expandable,
  })

  process.stderr.write(`[review-diff] URL: ${started.url}\n`)
  process.stderr.write(`[review-diff] waiting up to ${TIMEOUT_MS / 1000}s for decision...\n`)
  openUrl(started.url)

  const timeoutResult: ResultJson = { decision: 'timeout', reviewedPanels: [], comments: [] }
  const result: ResultJson = await Promise.race([
    started.waitResult(),
    new Promise<ResultJson>((r) => setTimeout(() => r(timeoutResult), TIMEOUT_MS)),
  ])

  try {
    const resultPath = `${dirname(values.summary as string)}/result.json`
    writeFileSync(resultPath, JSON.stringify(result, null, 2))
  } catch {
    /* noop */
  }

  process.stdout.write(JSON.stringify(result) + '\n')
  setTimeout(() => process.exit(0), 100)
}

// restore.json は SKILL が書き出す中間 JSON。存在 / parse / shape 全てに defensive。
// 1 つでも欠ければ「初回起動」と同じ扱い (initial* を undefined のまま) でフォールバック。
type RestoreState = {
  reviewedPanels?: string[]
  comments?: Comment[]
  lineCommentDrafts?: Record<string, string>
}
function readRestoreState(path: string | undefined): RestoreState | undefined {
  if (!path) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object') return undefined
    const r = raw as RestoreState
    // 部分的に取れるだけでも seed する。型不正な field だけ落とす。
    const out: RestoreState = {}
    if (Array.isArray(r.reviewedPanels) && r.reviewedPanels.every(x => typeof x === 'string')) {
      out.reviewedPanels = r.reviewedPanels
    }
    if (Array.isArray(r.comments)) {
      // shape の細かい検証は client 側で行うので、ここは Array であれば素通し。
      out.comments = r.comments as Comment[]
    }
    if (r.lineCommentDrafts && typeof r.lineCommentDrafts === 'object') {
      out.lineCommentDrafts = r.lineCommentDrafts as Record<string, string>
    }
    return out
  } catch (e) {
    process.stderr.write(`[review-diff] restore-state read failed (ignored): ${e instanceof Error ? e.message : String(e)}\n`)
    return undefined
  }
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
