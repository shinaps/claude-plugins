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

// git diff の hunk header (@@ -X,Y +A,B @@) から変更行 interval を抽出。
// 追加・変更 hunk (B > 0) は after 側の {A, A+B-1}。純粋削除 hunk (B = 0) は after 側に
// 行が存在しないため、thread の line anchor と同じ座標系である before 側の削除範囲
// {X, X+Y-1} を使う (after 側の境界 1 点では削除された行上の thread と交叉できない)。
// 例: "@@ -2 +1,0 @@" → {2,2}、先頭削除 "@@ -1,2 +0,0 @@" → {1,2}
export function extractChangedIntervals(diffText: string): LineInterval[] {
  const intervals: LineInterval[] = []
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(diffText)) !== null) {
    const beforeStart = parseInt(m[1], 10)
    const beforeLen = m[2] ? parseInt(m[2], 10) : 1
    const afterStart = parseInt(m[3], 10)
    const afterLen = m[4] ? parseInt(m[4], 10) : 1
    if (![beforeStart, beforeLen, afterStart, afterLen].every(Number.isFinite)) continue
    if (afterLen > 0) {
      intervals.push({ start: afterStart, end: afterStart + afterLen - 1 })
    } else if (beforeLen > 0) {
      intervals.push({ start: beforeStart, end: beforeStart + beforeLen - 1 })
    }
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

  const getDiff: FileDiffProvider = file => gitDiff(args.beforeSha, args.afterSha, file)
  let updated = 0
  for (const [key, snap] of Object.entries(threads)) {
    const newSnap = computeOutdated(snap, changedSet, getDiff)
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

// file → unified diff テキストの取得を注入可能にして、git 非依存で単体テストできるようにする。
export type FileDiffProvider = (file: string) => string

export function computeOutdated(
  snap: ThreadSnapshot,
  changedFiles: Set<string>,
  getDiff: FileDiffProvider,
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
  const diff = getDiff(file)
  if (!diff) return snap
  const intervals = extractChangedIntervals(diff)
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
