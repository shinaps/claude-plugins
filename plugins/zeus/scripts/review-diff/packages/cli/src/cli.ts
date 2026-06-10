// CLI エントリ (panel model + v5: thread comments, editor link, script gate)。
//
// 呼ばれ方:
//   - 通常レビュー: node "$CLI" --summary <path> --diff <path> [--pr-meta <path>] [--restore-state <path>]
//                  [--config <path>] [--script-results <path>]
//   - 部分 patch:   node "$CLI" extract-group-patch --summary <...> --diff <...> --group <gid>
//   - スクリプトゲート: node "$CLI" run-scripts --config <...> --changed-files <...> --out <...>
//   - outdated 判定:  node "$CLI" mark-outdated --restore-state <...> --before-sha <sha> --after-sha <sha> --changed-files <...>
//
// stdout / stderr 分離方針: 呼び出し側はサブプロセスの stdout を「結果」として丸ごとパースしたい。
// 情報メッセージが stdout に混ざるとパースが詰むため、ログは確実に stderr へ送る。
//
// PR mode は v5 で gh pr diff + lazy gh api blob 方式を完全に捨てて、
// 「SKILL.md が事前に gh pr checkout してから CLI を起動する」前提に切り替えた。
// CLI 側は staged モードと同じく git show :path (after) / git show <baseSha>:path (before) で
// sources を構築する。期待される base SHA は --base-sha フラグで渡される。

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import type {
  ResultJson,
  PrMeta,
  ProjectInfo,
  SummaryJson,
  Panel,
  RenderedGroup,
  RenderedPanel,
  ScriptResultsPayload,
} from '@zeus/review-diff-shared'
import { countLines } from '@zeus/review-diff-shared'
import {
  parseDiff,
  validateSummarySchema,
  validateCoverage,
  validateRangeSymmetry,
  validatePanelExclusivity,
  formatMissesForStderr,
  formatRangeSymmetryViolations,
  formatExclusivityConflicts,
  renderPanel,
  extractGroupPatch,
  SchemaError,
  type SourcesMap,
} from '@zeus/review-diff-server'
import { buildHtml } from './template'
import { openUrl } from './open'
import { loadReviewDiffConfig } from './config.js'
import { runScriptsCommand } from './script-runner.js'
import { markOutdatedCommand } from './outdated.js'
import { readRestoreState } from './restore-state.js'

const HEARTBEAT_GRACE_MS = 15 * 1000
const HEARTBEAT_BOOT_GRACE_MS = 30 * 1000
const HEARTBEAT_POLL_INTERVAL_MS = 3 * 1000

async function main(): Promise<void> {
  // subcommand dispatcher
  if (process.argv[2] === 'extract-group-patch') {
    await extractGroupPatchCommand()
    return
  }
  if (process.argv[2] === 'run-scripts') {
    const code = await runScriptsCommand()
    process.exit(code)
  }
  if (process.argv[2] === 'mark-outdated') {
    const code = await markOutdatedCommand()
    process.exit(code)
  }

  const { values } = parseArgs({
    options: {
      summary: { type: 'string' },
      diff: { type: 'string' },
      'pr-meta': { type: 'string' },
      'restore-state': { type: 'string' },
      // v5: 設定ファイル (editor + scripts)
      config: { type: 'string' },
      // v5: Phase 4.5 で実行したスクリプト結果 JSON。Activity タブの Pre-flight チップ表示に使う。
      'script-results': { type: 'string' },
      // v5 PR mode: SKILL.md が gh pr checkout する際に取得する base ref の SHA。
      // 渡されなければ HEAD~1 を仮の base として扱う (= staged モードと同じ挙動)。
      'base-sha': { type: 'string' },
    },
    strict: false,
  })

  if (!values.summary || !values.diff) {
    process.stderr.write('Usage: cli --summary <path> --diff <path> [--pr-meta <path>] [--restore-state <path>] [--config <path>] [--script-results <path>] [--base-sha <sha>]\n')
    process.exit(1)
  }

  // 1. summary.json: parse → zod 検証 → legacy detection
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

  // 3. 全 panel が言及する path を union
  const allPanelPaths = collectAllPanelPaths(summary, changes.map(c => c.oldPath).filter(Boolean) as string[])

  // 4. sources 取得
  //    v5 では staged も pr も同じ「working tree + git show <baseSha>:path」経路で読む。
  //    staged モード: after = `:path` (index)、before = `HEAD:path`
  //    pr モード:    after = `:path` または HEAD:path、before = `<baseSha>:path`
  let sources: SourcesMap = new Map()
  let expandable = false
  const baseSha = (values['base-sha'] as string | undefined)?.trim() || null
  if (summary.mode === 'staged' && !prMeta) {
    sources = collectStagedSources(allPanelPaths)
    expandable = true
  } else if (summary.mode === 'pr' && prMeta) {
    sources = collectPrSourcesFromWorktree(allPanelPaths, baseSha)
    expandable = true
  }

  // 5. coverage 厳格検証
  const allPanels: Panel[] = summary.groups.flatMap(g => g.panels)
  const cov = validateCoverage({ changes, panels: allPanels })
  if (cov.warnings.length > 0) {
    process.stderr.write(formatMissesForStderr({ ok: true, misses: [], warnings: cov.warnings }) + '\n')
  }
  if (!cov.ok) {
    process.stderr.write(formatMissesForStderr(cov) + '\n')
    process.exit(1)
  }

  const sym = validateRangeSymmetry({ changes, panels: allPanels, sources })
  if (!sym.ok) {
    process.stderr.write(formatRangeSymmetryViolations(sym) + '\n')
    process.exit(1)
  }

  const excl = validatePanelExclusivity({
    changes,
    groups: summary.groups.map((g, i) => ({
      groupId: `g${i}`,
      title: g.title,
      panels: g.panels,
    })),
  })
  if (!excl.ok) {
    process.stderr.write(formatExclusivityConflicts(excl) + '\n')
    process.exit(1)
  }

  // 6. 各 panel を side-by-side に展開
  const renderedGroups: RenderedGroup[] = summary.groups.map((g, i) => ({
    groupId: `g${i}`,
    title: g.title,
    description: g.description,
    panels: g.panels.map(p => renderPanel(p, sources, summary.mode)),
  }))

  // 7. restore state を読む (v2 + v1 auto migrate)
  const restore = readRestoreState(values['restore-state'] as string | undefined)
  // スレッドの真実源。v1 restore.json の comments[] は readRestoreState が thread へ migrate 済み。
  const restoreThreads = restore?.threads ?? {}

  // 8. config (editor + scripts) を読む
  let editorPreset: ReturnType<typeof loadReviewDiffConfig>['editorPreset'] = null
  let loadedConfig: ReturnType<typeof loadReviewDiffConfig>['config'] | null = null
  try {
    const loaded = loadReviewDiffConfig(values.config as string | undefined)
    editorPreset = loaded.editorPreset
    loadedConfig = loaded.config
  } catch (e) {
    process.stderr.write(`[review-diff] config load failed (ignored): ${(e as Error).message}\n`)
  }
  const editorAvailable = editorPreset !== null
  // config が無い / editor 未設定 / scripts 未設定 のときに stderr に明示的な hint を出す。
  // 「サイレントに機能 off」だとユーザーが editor link / script gate の存在に気付かないため。
  if (!values.config) {
    process.stderr.write('[review-diff] no --config passed.\n')
    process.stderr.write('[review-diff]   - Editor link icon will NOT be rendered (no editor preset)\n')
    process.stderr.write('[review-diff]   - Pre-flight script gate is disabled\n')
    process.stderr.write('[review-diff]   To enable: copy plugins/zeus/skills/review-diff/example.review-diff.config.json\n')
    process.stderr.write('[review-diff]   to .claude/zeus/review-diff.config.json (= relative to repo root)\n')
  } else if (loadedConfig) {
    if (!editorAvailable) {
      process.stderr.write('[review-diff] config has no editor.kind — editor link icon will NOT be rendered.\n')
    }
    if (!loadedConfig.scripts || loadedConfig.scripts.length === 0) {
      process.stderr.write('[review-diff] config has no scripts[] — pre-flight script gate is disabled.\n')
    }
  }

  // 9. script results を読む (Pre-flight チップ表示用)
  let scriptResults: ScriptResultsPayload | undefined
  const scriptResultsPath = values['script-results'] as string | undefined
  if (scriptResultsPath) {
    try {
      const raw = JSON.parse(readFileSync(scriptResultsPath, 'utf8')) as ScriptResultsPayload
      scriptResults = raw
    } catch (e) {
      process.stderr.write(`[review-diff] script-results read failed (ignored): ${(e as Error).message}\n`)
    }
  }

  // 10. Diff タブ用 rawPanels
  const rawPanels: RenderedPanel[] = []
  for (const c of changes) {
    if (!c.hasContentChange) continue
    if (c.eolOnlyChange) continue
    const asIsFile = c.oldPath ?? c.path
    const toBeFile = c.path
    const beforeSrc = sources.get(asIsFile)?.before ?? ''
    const afterSrc = sources.get(toBeFile)?.after ?? ''
    const beforeLines = countLines(beforeSrc)
    const afterLines = countLines(afterSrc)
    const panelId = `raw-${toBeFile}`.replace(/[^A-Za-z0-9_-]/g, '_')
    const panel: Panel = {
      panelId,
      intent: c.oldPath && c.oldPath !== c.path ? `${c.oldPath} → ${c.path}` : c.path,
      ...(beforeLines > 0 ? { asIs: { file: asIsFile, ranges: [{ start: 1, end: beforeLines }] } } : {}),
      ...(afterLines > 0 ? { toBe: { file: toBeFile, ranges: [{ start: 1, end: afterLines }] } } : {}),
    }
    rawPanels.push(renderPanel(panel, sources, summary.mode))
  }

  // 11. HTML 生成
  const html = buildHtml({
    schemaVersion: 1,
    summary,
    prMeta,
    project: detectProjectInfo(),
    groups: renderedGroups,
    allPanels: allPanels.map(p => p.panelId),
    expandable,
    rawPanels,
    initialGroupDecisions: restore?.groupDecisions,
    initialGroupComments: restore?.groupComments,
    initialLineCommentDrafts: restore?.lineCommentDrafts,
    initialThreads: Object.keys(restoreThreads).length > 0 ? restoreThreads : undefined,
    initialReviewKind: restore?.reviewKind,
    scriptResults,
    editorAvailable,
  })

  const { startServer } = await import('@zeus/review-diff-server')
  const started = await startServer({
    html,
    sources,
    expandable,
    editorPreset,
  })

  process.stderr.write(`[review-diff] URL: ${started.url}\n`)
  process.stderr.write(`[review-diff] waiting for decision (tab close → auto exit via heartbeat)...\n`)
  openUrl(started.url)

  const startedAt = Date.now()
  const timeoutResult: ResultJson = {
    decision: 'timeout',
    reviewKind: 'comment',
    groupDecisions: {},
    threads: {},
  }
  const heartbeatLoss = new Promise<ResultJson>((resolve) => {
    const interval = setInterval(() => {
      const last = started.getLastHeartbeat()
      const now = Date.now()
      if (last === null) {
        if (now - startedAt < HEARTBEAT_BOOT_GRACE_MS) return
        process.stderr.write(`[review-diff] no initial heartbeat within ${HEARTBEAT_BOOT_GRACE_MS}ms — exiting\n`)
        clearInterval(interval)
        resolve(timeoutResult)
        return
      }
      if (now - last > HEARTBEAT_GRACE_MS) {
        process.stderr.write(`[review-diff] heartbeat lost for ${Math.round((now - last) / 1000)}s — tab closed, exiting\n`)
        clearInterval(interval)
        resolve(timeoutResult)
      }
    }, HEARTBEAT_POLL_INTERVAL_MS)
    interval.unref?.()
  })

  const result: ResultJson = await Promise.race([
    started.waitResult(),
    heartbeatLoss,
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

// extract-group-patch subcommand
async function extractGroupPatchCommand(): Promise<void> {
  const { values } = parseArgs({
    options: {
      summary: { type: 'string' },
      diff: { type: 'string' },
      group: { type: 'string' },
    },
    strict: false,
    args: process.argv.slice(3),
  })
  if (!values.summary || !values.diff || !values.group) {
    process.stderr.write('Usage: cli extract-group-patch --summary <path> --diff <path> --group <groupId>\n')
    process.exit(1)
  }
  let summary: SummaryJson
  try {
    const raw = JSON.parse(readFileSync(values.summary as string, 'utf8'))
    summary = validateSummarySchema(raw).summary
  } catch (e) {
    process.stderr.write(`failed to read/validate summary: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }
  const diffText = readFileSync(values.diff as string, 'utf8')
  const result = extractGroupPatch({ summary, diffText, groupId: values.group as string })
  if (!result.ok) {
    process.stderr.write(`extract-group-patch failed: ${result.error}\n`)
    process.exit(1)
  }
  process.stdout.write(result.patch)
  process.exit(0)
}

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

function collectStagedSources(paths: string[]): SourcesMap {
  const out: SourcesMap = new Map()
  for (const path of paths) {
    const after = gitShow(`:${path}`)
    const before = gitShow(`HEAD:${path}`)
    out.set(path, { before, after })
  }
  return out
}

// v5 PR mode: SKILL.md が gh pr checkout 済みの想定。
//   after  = `:path` (index = HEAD と等価、PR ブランチの head)
//   before = `<baseSha>:path` if baseSha given else `HEAD~1:path`
function collectPrSourcesFromWorktree(paths: string[], baseSha: string | null): SourcesMap {
  const out: SourcesMap = new Map()
  const baseRef = baseSha ?? 'HEAD~1'
  for (const path of paths) {
    const after = gitShow(`HEAD:${path}`)
    const before = gitShow(`${baseRef}:${path}`)
    out.set(path, { before, after })
  }
  return out
}

function gitShow(ref: string): string {
  const r = spawnSync('git', ['show', ref], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
  if (r.status !== 0) return ''
  return r.stdout
}

// 複数プロジェクトのレビュータブを同時に開いたとき識別できるよう、
// リポジトリ名 (= repo root の directory 名) + 現在ブランチを取得する。
// レビュー機能そのものには影響しない表示用情報なので、取得失敗は null フォールバックで握りつぶす。
function detectProjectInfo(): ProjectInfo | null {
  const top = gitOutput(['rev-parse', '--show-toplevel'])
  if (!top) return null
  const branchRaw = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'])
  return {
    name: basename(top),
    // detached HEAD では --abbrev-ref が文字どおり "HEAD" を返すので branch 無し扱いにする
    branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
  }
}

function gitOutput(args: string[]): string | null {
  const r = spawnSync('git', args, { encoding: 'utf8' })
  if (r.status !== 0) return null
  const out = r.stdout.trim()
  return out === '' ? null : out
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e)
  process.stderr.write(`error: ${msg}\n`)
  process.exit(2)
})
