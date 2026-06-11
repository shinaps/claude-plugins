import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import type { ThreadSnapshot } from '@show-me/diff-shared'
import { parseThreadSnapshot } from './restore-state.js'

// mark-outdated subcommand:
//   - 入力: --restore-state <path>, --changed-files <path>
//   - 処理:
//     1. restore.json を Read → threads を取得 (不正 entry は判定 skip + 原文温存)
//     2. 各 toBe line scope thread について file が changed-files にあるなら
//        git diff --unified=0 -- <file> (index vs working tree) から変更行 interval を抽出し、
//        thread.scope.line[..endLine] と交叉すれば outdated = true
//     3. outdatedOverride='keep' なら強制 false、'force' なら強制 true
//     4. group / file scope thread は override 以外で自動判定しない
//        (行交叉の概念が無く、ファイルの部分変更で「ファイル全体への指摘」が陳腐化するとは限らないため)
//     5. restore.json へ outdated フィールドだけ上書きして書き戻す
//
// なぜ commit SHA ペアではなく「index vs working tree」の diff か:
//   apply (SKILL.md comment-reply の修正反映) は Edit/Write による working tree 書き換えで、
//   commit も stage も作らない。レビュアーが見ていた toBe 表示は staged モードで index
//   (git show :path)、PR モードで HEAD (dirty precheck + gh pr checkout 直後なので index と一致)。
//   つまり「index vs working tree」の diff の before 側がレビュアーの見ていた座標系そのもので、
//   thread の line anchor とそのまま交叉判定できる。
//   前提: この subcommand は apply 直後・いかなる git add よりも前に呼ばれる (add すると index が
//   動いて apply 差分が消える)。staged モードで apply 前から unstaged drift があると、その差分も
//   判定に混入するが、「レビュアーが見た index と現物が違う」検出としては正しい方向なので受容する。

export type LineInterval = { start: number; end: number }

export function intervalsOverlap(a: LineInterval, b: LineInterval): boolean {
  return a.start <= b.end && b.start <= a.end
}

// git diff の hunk header (@@ -X,Y +A,B @@) から変更行 interval を抽出。
// interval は全 hunk で before 側 {X, X+Y-1} に統一する。thread の line anchor は apply 前の
// 内容 (= この diff の before 側) を指しており、after 側座標を混ぜると先行 hunk の行数増減で
// 2 つ目以降の hunk が累積オフセット分ドリフトして誤判定する (false negative / positive 両方向)。
// 純粋挿入 hunk (Y = 0) は既存行を 1 行も変更しないため interval を作らない。
// 例: "@@ -2 +1,0 @@" → {2,2}、先頭削除 "@@ -1,2 +0,0 @@" → {1,2}、挿入 "@@ -5,0 +6,3 @@" → なし
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
    if (beforeLen > 0) {
      intervals.push({ start: beforeStart, end: beforeStart + beforeLen - 1 })
    }
  }
  return intervals
}

// index vs working tree の diff (ファイルヘッダの WHY 参照)。SHA 引数を取らないのは意図的。
function gitDiff(file: string): string {
  const r = spawnSync('git', ['diff', '--unified=0', '--', file], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  })
  if (r.status !== 0) return ''
  return r.stdout
}

export type MarkOutdatedArgs = {
  restoreStatePath: string
  changedFilesPath: string
}

export type MarkOutdatedResult = {
  updated: number
  totalThreads: number
}

export function markOutdated(args: MarkOutdatedArgs): MarkOutdatedResult {
  const raw = JSON.parse(readFileSync(args.restoreStatePath, 'utf8')) as Record<string, unknown>
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('restore-state is not an object')
  }
  // read-modify-write なので、検証に通らない entry を drop すると永続データが消える。
  // raw entry は原文のまま保持し、parseThreadSnapshot は「判定対象にできるか」の
  // フィルタとしてのみ使う。書き戻しも outdated フィールドだけの上書きに限定する。
  const rawThreads = raw.threads
  // threads コンテナ自体が配列等の不正型だった場合は空 object に正規化して書き戻す
  // (entry 単位の温存原則の例外。この形のデータは readRestoreState でもどのみち無視される)。
  const threads: Record<string, unknown> =
    rawThreads && typeof rawThreads === 'object' && !Array.isArray(rawThreads)
      ? { ...(rawThreads as Record<string, unknown>) }
      : {}

  const changedSet = new Set(
    readFileSync(args.changedFilesPath, 'utf8')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean),
  )

  const getDiff: FileDiffProvider = file => gitDiff(file)
  let updated = 0
  for (const [key, rawSnap] of Object.entries(threads)) {
    const snap = parseThreadSnapshot(rawSnap)
    if (!snap) continue
    const next = computeOutdated(snap, changedSet, getDiff)
    if (next.outdated !== snap.outdated) {
      threads[key] = { ...(rawSnap as Record<string, unknown>), outdated: next.outdated }
      updated++
    }
  }

  const out = { ...raw, threads }
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
  // toBe anchor のみ判定する。asIs ペインは HEAD / base の不変スナップショットを表示しており、
  // working tree 書き換えである apply では内容が変わらない。また asIs anchor は HEAD 座標系で、
  // index 座標系の interval と比較すると誤判定するため、自動判定の対象外にする。
  if (snap.scope.side !== 'toBe') return snap
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
      'changed-files': { type: 'string' },
    },
    strict: false,
    args: process.argv.slice(3),
  })
  const restoreStatePath = values['restore-state'] as string | undefined
  const changedFilesPath = values['changed-files'] as string | undefined
  if (!restoreStatePath || !changedFilesPath) {
    process.stderr.write('mark-outdated requires --restore-state --changed-files\n')
    return 2
  }
  try {
    const { updated, totalThreads } = markOutdated({
      restoreStatePath,
      changedFilesPath,
    })
    process.stderr.write(`[show-me:diff] mark-outdated: ${updated}/${totalThreads} threads updated\n`)
    return 0
  } catch (e) {
    process.stderr.write(`[show-me:diff] mark-outdated crashed: ${(e as Error).message}\n`)
    return 2
  }
}
