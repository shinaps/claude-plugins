import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import type { RestoreStateV2, ThreadSnapshot } from '@zeus/review-diff-shared'

// mark-outdated subcommand:
//   - 入力: --restore-state <path>, --before-sha <sha>, --after-sha <sha>, --changed-files <path>
//   - 処理:
//     1. restore.json (v2) を Read → threads を取得
//     2. 各 line scope thread について file が changed-files にあるなら
//        git diff <before-sha>..<after-sha> -- <file> から changed line interval を抽出
//        thread.scope.line[..endLine] と交叉すれば outdated = true
//     3. outdatedOverride='keep' なら強制 false、'force' なら強制 true
//     4. group / file scope thread は override 以外で自動判定しない
//        (行交叉の概念が無く、ファイルの部分変更で「ファイル全体への指摘」が陳腐化するとは限らないため)
//     5. restore.json を書き戻す
//
// この subcommand は SKILL.md Phase 6 で agent が apply action を選んだ直後に呼ばれる。

export type LineInterval = { start: number; end: number }

export function intervalsOverlap(a: LineInterval, b: LineInterval): boolean {
  return a.start <= b.end && b.start <= a.end
}

// git diff の hunk header (@@ -X,Y +A,B @@) から after 側の変更行 interval を抽出。
// 1 hunk = 1 interval (B 行ぶん、A 開始)。改名/削除は無視 (chat の threads は file path で持つ)。
export function extractChangedAfterIntervals(diffText: string): LineInterval[] {
  const intervals: LineInterval[] = []
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(diffText)) !== null) {
    const start = parseInt(m[1], 10)
    const lenStr = m[2]
    const len = lenStr ? parseInt(lenStr, 10) : 1
    if (!Number.isFinite(start) || !Number.isFinite(len) || len <= 0) continue
    intervals.push({ start, end: start + len - 1 })
  }
  return intervals
}

function gitDiff(beforeSha: string, afterSha: string, file: string): string {
  const r = spawnSync('git', ['diff', '--unified=0', `${beforeSha}..${afterSha}`, '--', file], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  })
  if (r.status !== 0) return ''
  return r.stdout
}

export type MarkOutdatedArgs = {
  restoreStatePath: string
  beforeSha: string
  afterSha: string
  changedFilesPath: string
}

export type MarkOutdatedResult = {
  updated: number
  totalThreads: number
}

export function markOutdated(args: MarkOutdatedArgs): MarkOutdatedResult {
  const raw = JSON.parse(readFileSync(args.restoreStatePath, 'utf8')) as RestoreStateV2
  if (!raw || typeof raw !== 'object') throw new Error('restore-state is not an object')
  const threads = raw.threads ?? {}

  const changedSet = new Set(
    readFileSync(args.changedFilesPath, 'utf8')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean),
  )

  let updated = 0
  for (const [key, snap] of Object.entries(threads)) {
    const newSnap = computeOutdated(snap, args.beforeSha, args.afterSha, changedSet)
    if (newSnap !== snap) {
      threads[key] = newSnap
      updated++
    }
  }

  const out: RestoreStateV2 = {
    ...raw,
    schemaVersion: 2,
    threads,
  }
  writeFileSync(args.restoreStatePath, JSON.stringify(out, null, 2), 'utf8')
  return { updated, totalThreads: Object.keys(threads).length }
}

function computeOutdated(
  snap: ThreadSnapshot,
  beforeSha: string,
  afterSha: string,
  changedFiles: Set<string>,
): ThreadSnapshot {
  if (snap.outdatedOverride === 'keep') {
    return snap.outdated ? { ...snap, outdated: false } : snap
  }
  if (snap.outdatedOverride === 'force') {
    return snap.outdated ? snap : { ...snap, outdated: true }
  }
  // 自動判定: line scope のみ。group / file scope は値不変。
  if (snap.scope.type !== 'line') return snap
  const file = snap.scope.file
  if (!changedFiles.has(file)) return snap
  const diff = gitDiff(beforeSha, afterSha, file)
  if (!diff) return snap
  const intervals = extractChangedAfterIntervals(diff)
  const threadInterval: LineInterval = {
    start: snap.scope.line,
    end: snap.scope.endLine ?? snap.scope.line,
  }
  const hit = intervals.some(iv => intervalsOverlap(iv, threadInterval))
  if (hit && !snap.outdated) return { ...snap, outdated: true }
  return snap
}

export async function markOutdatedCommand(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'restore-state': { type: 'string' },
      'before-sha': { type: 'string' },
      'after-sha': { type: 'string' },
      'changed-files': { type: 'string' },
    },
    strict: false,
    args: process.argv.slice(3),
  })
  const restoreStatePath = values['restore-state'] as string | undefined
  const beforeSha = values['before-sha'] as string | undefined
  const afterSha = values['after-sha'] as string | undefined
  const changedFilesPath = values['changed-files'] as string | undefined
  if (!restoreStatePath || !beforeSha || !afterSha || !changedFilesPath) {
    process.stderr.write('mark-outdated requires --restore-state --before-sha --after-sha --changed-files\n')
    return 2
  }
  try {
    const { updated, totalThreads } = markOutdated({
      restoreStatePath,
      beforeSha,
      afterSha,
      changedFilesPath,
    })
    process.stderr.write(`[review-diff] mark-outdated: ${updated}/${totalThreads} threads updated\n`)
    return 0
  } catch (e) {
    process.stderr.write(`[review-diff] mark-outdated crashed: ${(e as Error).message}\n`)
    return 2
  }
}
