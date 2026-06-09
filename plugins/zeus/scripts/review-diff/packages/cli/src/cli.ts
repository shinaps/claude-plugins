// CLI エントリ (panel model)。
//
// 呼ばれ方:  node "$CLI" --summary <path> --diff <path> [--pr-meta <path>] [--restore-state <path>]
//
// Channels インフラ (ACTIVE_DIR / sessionId / browserToken / channelToken / SIGINT cleanup hook) は
// 存在しない。代わりに --restore-state を持ち、SKILL.md が close-relaunch ループで前回の
// Reviewed + line comments + 未保存 draft を注入できるようにしてある。--restore-state を
// 知らない SKILL.md からの fallback 互換も parseArgs の strict:false で吸収する。
//
// stdout / stderr 分離方針 (継続):
//   呼び出し側はサブプロセスの stdout を「結果」として丸ごとパースしたい。
//   情報メッセージが stdout に混ざるとパースが詰むため、ログは確実に stderr へ送る。
//
// pipeline:
//   1. validateSummarySchema (zod + legacy 検出): legacy schema は migration メッセージ付きで exit 1
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
import type {
  ResultJson,
  PrMeta,
  SummaryJson,
  Panel,
  RenderedGroup,
  RenderedPanel,
  Comment,
  RestoreState,
  GroupDecision,
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

// ブラウザから 5 秒ごとに /heartbeat が打たれる前提で、最終 ping から N ms 経過したら「タブが閉じられた」と
// 判断して CLI も自発的に終了する。Skill ツール側は run_in_background で起動して TaskOutput で
// 待ち合わせるモデルに移行したので、絶対値タイムアウト (旧 9 分制限) は撤廃した。
// 15 秒 = 5s 間隔の heartbeat を 3 回連続で取りこぼした猶予幅 (ネットワーク詰まり / GC pause を吸収)。
const HEARTBEAT_GRACE_MS = 15 * 1000
// 初回 ping が来るまでの猶予 (ブラウザ open + bundle ロード + 初回 fetch まで)。
// この期間内は heartbeat 未受信でも終了しない。
const HEARTBEAT_BOOT_GRACE_MS = 30 * 1000
const HEARTBEAT_POLL_INTERVAL_MS = 3 * 1000

// gh api への並列度上限。GitHub の rate limit (authenticated 5000 req/hour) に余裕を残しつつ、
// N ファイル × 2 (base/head) の blob 取得を現実的な時間で終わらせるための値。
// 大きすぎると rate limit で 403 が増え、小さすぎると待ち時間が伸びる。経験則で 8。
const PR_FETCH_CONCURRENCY = 8

async function main(): Promise<void> {
  // subcommand dispatcher。argv[2] が 'extract-group-patch' なら部分 patch 生成モードに分岐。
  // SKILL.md (bash) が `node dist/cli.js extract-group-patch --summary <...> --diff <...> --group g0`
  // のように呼ぶ。stdout に unified diff (--unidiff-zero 互換) を吐く。
  if (process.argv[2] === 'extract-group-patch') {
    await extractGroupPatchCommand()
    return
  }

  // parseArgs の strictOption は default true だが、unknown flag を渡された時に process が
  // 即落ちすると forward compatibility が失われる。SKILL.md と CLI のバージョンがズレた時に
  // 余計な flag を skip できるように strict:false に倒す (validation は handler 側で行う)。
  const { values } = parseArgs({
    options: {
      summary: { type: 'string' },
      diff: { type: 'string' },
      'pr-meta': { type: 'string' },
      // regen-group の close-relaunch で、SKILL.md が書き出した restore JSON
      // (groupDecisions / groupComments / comments / lineCommentDrafts) を再起動後の CLI に渡すパス。
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
  //    legacy schema は SchemaError + migration メッセージで exit 1。
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

  // 5.5. asIs/toBe range の対称性検証。
  //   sources を渡して MAX_TAIL fallback を不要にする (W-1: ファイル行数を上限に使う)。
  const sym = validateRangeSymmetry({ changes, panels: allPanels, sources })
  if (!sym.ok) {
    process.stderr.write(formatRangeSymmetryViolations(sym) + '\n')
    process.exit(1)
  }

  // 5.6. panel exclusivity 検証 (同一変更行を 2 group が claim していないか)。
  //   linear-stack の commit-per-group を破綻させないため必須。
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

  // 7. restore state を読む (close-relaunch)。
  //    restore.json は SKILL.md が前回 CLI 終了時に書き出すもので、shared RestoreState 型:
  //      { groupDecisions, groupComments, comments, lineCommentDrafts }
  //    CLI 側で comments を line scope と group scope に pre-split して ClientPayload に注入する
  //    (client 側の二重 seed を防止、C-4)。
  const restore = readRestoreState(values['restore-state'] as string | undefined)
  const { lineComments, groupCommentsFromComments } = splitRestoreComments(restore?.comments ?? [])
  // restore.groupComments を base に、comments scope='group' から再構築した groupCommentsFromComments を
  // 上書き merge (comments 側が後勝ち = 直前 UI の最新状態を優先)。
  const initialGroupComments: Record<string, string> = {
    ...(restore?.groupComments ?? {}),
    ...groupCommentsFromComments,
  }

  // 8. HTML 生成 + サーバ起動
  // Diff タブ用の「ファイル単位 panel」を別途構築する。
  // Guide タブが AI 指定の細粒度 panel を見せるのに対し、Diff タブはグルーピング無しの
  // 「git diff を file 順に俯瞰する」用途で、各 file の全行を 1 panel に詰める。
  // binary / rename-only / EOL-only は実用上見せても意味がないので skip。
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
    // panel.intent には file path をそのまま入れる (PanelHeader が太字でレンダーする)。
    // raw panel の panelId は file path から決定的に派生させ、line comment の永続化先を Guide 側と分ける。
    const panelId = `raw-${toBeFile}`.replace(/[^A-Za-z0-9_-]/g, '_')
    const panel: Panel = {
      panelId,
      intent: c.oldPath && c.oldPath !== c.path ? `${c.oldPath} → ${c.path}` : c.path,
      ...(beforeLines > 0 ? { asIs: { file: asIsFile, ranges: [{ start: 1, end: beforeLines }] } } : {}),
      ...(afterLines > 0 ? { toBe: { file: toBeFile, ranges: [{ start: 1, end: afterLines }] } } : {}),
    }
    rawPanels.push(renderPanel(panel, sources, summary.mode))
  }

  const html = buildHtml({
    schemaVersion: 1,
    summary,
    prMeta,
    groups: renderedGroups,
    allPanels: allPanels.map(p => p.panelId),
    expandable,
    rawPanels,
    initialGroupDecisions: restore?.groupDecisions,
    initialGroupComments: Object.keys(initialGroupComments).length > 0 ? initialGroupComments : undefined,
    initialComments: lineComments.length > 0 ? lineComments : undefined,
    initialLineCommentDrafts: restore?.lineCommentDrafts,
  })

  const { startServer } = await import('@zeus/review-diff-server')
  const started = await startServer({
    html,
    sources,
    expandable,
  })

  process.stderr.write(`[review-diff] URL: ${started.url}\n`)
  process.stderr.write(`[review-diff] waiting for decision (tab close → auto exit via heartbeat)...\n`)
  openUrl(started.url)

  // タブ close 検知: ブラウザは setInterval で /heartbeat を打っている。
  // 最終 ping から HEARTBEAT_GRACE_MS 経過したらタブが閉じられたと判断して timeout 扱いで終了する。
  // 起動直後は HEARTBEAT_BOOT_GRACE_MS の間「まだ初回 ping 来ていないだけ」扱いで猶予する。
  const startedAt = Date.now()
  const timeoutResult: ResultJson = { decision: 'timeout', groupDecisions: {}, comments: [] }
  const heartbeatLoss = new Promise<ResultJson>((resolve) => {
    const interval = setInterval(() => {
      const last = started.getLastHeartbeat()
      const now = Date.now()
      if (last === null) {
        // 初回 ping 未着でも boot grace 期間内なら待つ
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
    // unref で「heartbeat 監視だけ残った」状態でも process が exit できるようにする (実害は無いが念のため)
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

// restore.json は SKILL が書き出す中間 JSON (shared RestoreState 型)。存在 / parse / shape 全てに defensive。
// 1 つでも欠ければ「初回起動」と同じ扱い (initial* を undefined のまま) でフォールバック。
// 旧 reviewedPanels field は廃止済み (clean break)。残っていても無視する。
function readRestoreState(path: string | undefined): RestoreState | undefined {
  if (!path) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object') return undefined
    const r = raw as RestoreState
    // 部分的に取れるだけでも seed する。型不正な field だけ落とす。
    const out: RestoreState = {}
    if (r.groupDecisions && typeof r.groupDecisions === 'object' && !Array.isArray(r.groupDecisions)) {
      // value が 'approved' | 'request-changes' のもののみ採用
      const filtered: Record<string, GroupDecision> = {}
      for (const [k, v] of Object.entries(r.groupDecisions)) {
        if (v === 'approved' || v === 'request-changes') filtered[k] = v
      }
      if (Object.keys(filtered).length > 0) out.groupDecisions = filtered
    }
    if (r.groupComments && typeof r.groupComments === 'object' && !Array.isArray(r.groupComments)) {
      const filtered: Record<string, string> = {}
      for (const [k, v] of Object.entries(r.groupComments)) {
        if (typeof v === 'string') filtered[k] = v
      }
      if (Object.keys(filtered).length > 0) out.groupComments = filtered
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

// restore.json の comments[] を line scope と group scope に分ける。
// 設計判断: client 側が二重 seed しないよう、CLI 側で pre-split して
// initialComments (= line scope のみ) と initialGroupComments (= group scope の Record) に
// 分けて payload に乗せる (C-4)。
function splitRestoreComments(comments: Comment[]): {
  lineComments: Comment[]
  groupCommentsFromComments: Record<string, string>
} {
  const lineComments: Comment[] = []
  const groupCommentsFromComments: Record<string, string> = {}
  for (const c of comments) {
    // restore.json が破損していたり、旧 `scope: { type: 'overall' }` が
    // 残っている可能性に備え、shape をここで検証する。typo や undefined は静かに skip。
    if (!c || typeof c !== 'object') continue
    if (typeof c.body !== 'string') continue
    if (!c.scope || typeof c.scope !== 'object') continue
    if (c.scope.type === 'line') {
      // line scope の内部 shape (panelId/side/file/line) も検証する。
      // 破損 restore.json を素通しすると、useLineComments の seed で undefined/NaN が混入し
      // 結果として「壊れた restore で不正コメントが新規生成される」副作用を生む。
      const s = c.scope
      if (typeof s.panelId !== 'string' || s.panelId === '') continue
      if (s.side !== 'asIs' && s.side !== 'toBe') continue
      if (typeof s.file !== 'string') continue
      if (typeof s.line !== 'number' || !Number.isFinite(s.line)) continue
      if (s.endLine != null && (typeof s.endLine !== 'number' || !Number.isFinite(s.endLine))) continue
      lineComments.push(c)
    } else if (c.scope.type === 'group') {
      if (typeof c.scope.groupId !== 'string' || c.scope.groupId === '') continue
      // 同一 groupId が複数あったら後勝ち (UI 上は 1 textarea しかないため自然な扱い)。
      groupCommentsFromComments[c.scope.groupId] = c.body
    }
  }
  return { lineComments, groupCommentsFromComments }
}

// extract-group-patch subcommand: 指定 group の panels が claim する変更行だけを含む
// unified diff (--unidiff-zero 互換) を stdout に吐く。SKILL.md (bash) が `git apply --cached
// --unidiff-zero --recount` で linear-stack の各 commit を構築するのに使う。
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
// 収集対象 path は allPanelPaths (panel が言及する全 file の union)。
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
