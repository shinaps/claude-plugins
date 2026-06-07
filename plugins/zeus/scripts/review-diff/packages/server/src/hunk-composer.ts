// composeHunks: 「diff の hunk 列」を「人間が読みやすい表示単位の Hunk 列」に再編する。
//
// 入力:
//   - file: parseDiff から出てきた ParsedFile (changed hunks のみ、origin='changed')
//   - source: after/before の原文 (lazy expand 用に既に CLI 側で集めたもの)
//   - displayRanges: AI が summary.json で指定した「文脈ごと見せたい after 行範囲」
//   - autoBridgeThreshold: hunk 間 gap がこの行数以下なら自動で繋ぐ (バナー化しない)
//
// 出力:
//   ParsedFile (hunks は再採番された Hunk[])。各 Hunk には origin が立つ:
//     - 'changed': 元 diff の hunk が起源
//     - 'ai-context': displayRanges のみが起源 (changed と被ってなかった)
//     - 'auto-bridge': gap ≤ threshold の自動繋ぎ
//   ※ 繋がった結果として複数 origin が混ざる場合は 'changed' を優先 (UI 上の強調を保つ)。
//
// 設計判断:
//   - source が無い (= PR モードで gh fetch 失敗 / 削除ファイル) 場合は no-op で元 ParsedFile を返す。
//     unchanged 行を埋める術が無いので auto-bridge / displayRanges 共に static degrade させる。
//   - displayRanges が空 かつ どの gap も threshold 超え → 入力をそのまま返す fast path。
//     hunk index が後方互換で保たれる ({ path, hunks: [n] } 既存指定が動き続ける)。
//   - pure-deletion hunk (newLines === 0) は after 軸に「占有する行」を持たない。
//     表示単位 Hunk からは除外する (採用案 A)。displayRanges 指定経路では range 外の
//     deletion は表示されなくなるが、fast-path 経路では元の file をそのまま返すので、
//     ユーザーが AI 指定無しで起動した従来 UX は維持される。
//
// oldStart / oldLines の意味論 (重要):
//   結果 Hunk の oldStart / oldLines は「after 軸の Hunk 範囲を before 軸に写像した値」。
//   parse-git-diff の fromFileRange とは意味が異なる: 各 Hunk について
//     oldStart = newStart - cumulativeDeltaAt(file.hunks, newStart)
//     oldEnd   = (newStart + newLines - 1) - cumulativeDeltaAt(file.hunks, newStart + newLines)
//     oldLines = max(0, oldEnd - oldStart + 1)
//   DiffTable の gapStartBefore = prev.oldStart + prev.oldLines 計算が before 軸で
//   連続するように設計されている (banner 表示用の before 範囲算出)。

import { countLines, type DisplayRange, type Hunk, type HunkOrigin, type ParsedFile, type SideBySideRow } from '@zeus/review-diff-shared'
import type { FileSource } from './server'

// after 行範囲を表す内部型。inclusive。
type Range = { start: number; end: number; origin: HunkOrigin }

export type ComposeHunksOptions = {
  file: ParsedFile
  source: FileSource | undefined
  displayRanges?: DisplayRange[]
  autoBridgeThreshold: number
}

export function composeHunks(opts: ComposeHunksOptions): ParsedFile {
  const { file, source, displayRanges, autoBridgeThreshold } = opts
  const ranges = (displayRanges ?? []).filter((r) => r.end >= r.start)

  // graceful degrade: 原文が無いので unchanged を埋められない。
  // 「変更点だけ表示」する旧挙動にフォールバックする。
  if (!source || !source.after) return file
  // バイナリは composeHunks の対象外 (rows がそもそも無い)。
  if (file.status === 'binary') return file
  // hunk 0 件かつ displayRanges 0 件: 何もすることがない。
  if (file.hunks.length === 0 && ranges.length === 0) return file

  // pure-deletion (newLines === 0) は after 行を 1 行も占有しないので、Range merge や
  // changedByStart map では取り扱えない (cur が進まず buildRows が無限ループする原因)。
  // 表示単位 Hunk からは除外する。before 軸 delta 計算 (cumulativeDeltaAt) では
  // file.hunks の全件を使うので mapping 自体は引き続き正しい。
  const positiveHunks = file.hunks.filter((h) => h.newLines > 0)

  // fast path: displayRanges 未指定なら元 file をそのまま返す。
  // 「AUTO_BRIDGE は ranges 指定時のみ発火」設計: ranges 空のまま auto-bridge を効かせると、
  // 既存 `{ path, hunks: [n] }` 指定の hunk index が再採番で意図せず崩れるケースがあった (W2)。
  // ranges を指定したときだけ auto-bridge が動く形にすることで、AI が「意味的範囲を見せたい」と
  // 明示したときの副次効果として merge を起動する設計に揃え、後方互換 を守る。
  if (ranges.length === 0) {
    return file
  }

  // すべての対象範囲 (changed hunks の after 範囲 + displayRanges) をリスト化。
  const changedRanges: Range[] = positiveHunks.map((h) => ({
    start: h.newStart,
    end: h.newStart + h.newLines - 1,
    origin: 'changed',
  }))
  const aiRanges: Range[] = ranges.map((r) => ({
    start: Math.max(1, r.start),
    end: r.end,
    origin: 'ai-context',
  }))

  // start 昇順で並べる。同 start なら end 降順 (より広い範囲を先に)。
  const all = [...changedRanges, ...aiRanges].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return b.end - a.end
  })

  // 重なり / 隣接 (gap ≤ threshold) で merge。merge 後の origin は 'changed' > 'ai-context' > 'auto-bridge' で優先。
  const merged: Range[] = []
  for (const r of all) {
    const last = merged[merged.length - 1]
    if (!last) {
      merged.push({ ...r })
      continue
    }
    const gap = r.start - last.end - 1
    if (gap <= autoBridgeThreshold) {
      // 連続扱い。end を伸ばし、origin は強い方を残す。
      last.end = Math.max(last.end, r.end)
      last.origin = strongerOrigin(last.origin, r.origin)
    } else {
      merged.push({ ...r })
    }
  }

  // changed の hunks を after 行で逆引きできるようにしておく。
  // 同じ after 開始行に複数 hunk は無いので Map<newStart, Hunk> で OK。
  // pure-deletion は newLines === 0 で cur 前進不可なため除外済み。
  const changedByStart = new Map<number, Hunk>()
  for (const h of positiveHunks) changedByStart.set(h.newStart, h)

  const afterLines = source.after.split('\n')
  const beforeLines = source.before ? source.before.split('\n') : null
  // 末尾 \n を 1 行として数えないよう countLines と整合させる (CLI の afterTotal と同じ式)。
  // 末尾近くを range で指定したとき phantom 空 row が 1 行余分に出るのを防ぐ (A2)。
  const afterMax = countLines(source.after)

  const newHunks: Hunk[] = []
  let idx = 0
  for (const range of merged) {
    const start = Math.max(1, range.start)
    const end = Math.min(afterMax, range.end)
    if (end < start) continue
    // 進入時点の before 軸オフセット。Hunk 内で最初の changed hunk に当たるまでの
    // context 行は「after - initialLeftDelta = before」で写像する (Critical #2 治癒)。
    const initialLeftDelta = cumulativeDeltaAt(file.hunks, start)
    const rows = buildRows({
      startAfter: start,
      endAfter: end,
      afterLines,
      beforeLines,
      changedByStart,
      allHunks: file.hunks,
      initialLeftDelta,
    })
    if (rows.length === 0) continue
    // oldStart / oldLines は「after → before mapping」で統一算出する。
    // rows 内 left.line の null fallback に依存しないので addition-only (A1) でも正値。
    const oldStart = start - initialLeftDelta
    const endLeftDelta = cumulativeDeltaAt(file.hunks, end + 1)
    const oldEnd = end - endLeftDelta
    const oldLines = Math.max(0, oldEnd - oldStart + 1)
    newHunks.push({
      index: idx++,
      oldStart,
      oldLines,
      newStart: start,
      newLines: end - start + 1,
      rows,
      origin: range.origin,
    })
  }

  // totalLines は新しい hunks の行数合計で更新。additions / deletions は元のまま (changed の総数)。
  const totalLines = newHunks.reduce((acc, h) => acc + h.rows.length, 0)
  return {
    ...file,
    hunks: newHunks,
    totalLines,
  }
}

function strongerOrigin(a: HunkOrigin, b: HunkOrigin): HunkOrigin {
  // 強さ: changed > ai-context > auto-bridge
  if (a === 'changed' || b === 'changed') return 'changed'
  if (a === 'ai-context' || b === 'ai-context') return 'ai-context'
  return 'auto-bridge'
}

// allHunks 内のうち「afterLine より前で完全に終わっている」hunk について、
// (newLines - oldLines) の累積を返す。leftLine = afterLine - cumulativeDelta で
// before 行番号を引き当てるための補助関数。
//
// pure-deletion (newLines === 0) も累積に含める: after 行を消費しないが、
// before 軸では行数 (oldLines) を消費しているため delta に effect がある。
// 境界条件は `newStart + newLines <= afterLine` (= 完全に afterLine より前)。
function cumulativeDeltaAt(allHunks: Hunk[], afterLine: number): number {
  let acc = 0
  for (const h of allHunks) {
    if (h.newStart + h.newLines <= afterLine) {
      acc += h.newLines - h.oldLines
    }
  }
  return acc
}

// 与えられた after 行範囲を SideBySideRow[] に変換する。
// 範囲内に既存 changed hunk があれば、その hunk の rows をその位置に差し込み、
// それ以外は context 行として after / before 原文から生成する。
function buildRows(params: {
  startAfter: number
  endAfter: number
  afterLines: string[]
  beforeLines: string[] | null
  changedByStart: Map<number, Hunk>
  // delta 算出に file.hunks 全体が必要。changed hunk 通過後の leftDelta 再計算で参照する。
  allHunks: Hunk[]
  // 範囲進入時点の before 軸オフセット (cumulativeDeltaAt(file.hunks, startAfter))。
  // leftDelta = 0 から始めると、Hunk 範囲が最初の changed hunk より前から始まる場合に
  // 左カラム行番号が誤値 (= after 行番号と同値) になる (Critical #2)。
  initialLeftDelta: number
}): SideBySideRow[] {
  const { startAfter, endAfter, afterLines, beforeLines, changedByStart, allHunks, initialLeftDelta } = params
  const rows: SideBySideRow[] = []
  let cur = startAfter
  // 「左 (before) 行番号 = after 行 - leftDelta」。範囲進入時点では initialLeftDelta、
  // changed hunk を通過したら cumulativeDeltaAt で正規化する (addition-only hunk のように
  // rows 末尾に left.line を持たない hunk でも正しく delta が反映される)。
  let leftDelta = initialLeftDelta
  while (cur <= endAfter) {
    const h = changedByStart.get(cur)
    if (h) {
      for (const r of h.rows) rows.push(r)
      // positiveHunks のみ entry されているので newLines > 0 が保証される (cur は必ず進む)。
      cur = h.newStart + h.newLines
      // hunk 通過後の正しい leftDelta は「cur 時点までに完全に終わった hunk の累積」。
      // rows 内の left.line を逆引きする方式は addition-only hunk で lastLeft=null になり
      // 更新されない bug を生んでいたため、ここで delta ベースに統一する。
      leftDelta = cumulativeDeltaAt(allHunks, cur)
      continue
    }
    // unchanged context 行を 1 行流す。
    const raw = afterLines[cur - 1] ?? ''
    const leftLine = cur - leftDelta
    const left = beforeLines && leftLine >= 1 && leftLine <= beforeLines.length
      ? { type: 'context' as const, line: leftLine, raw: beforeLines[leftLine - 1] ?? raw }
      : { type: 'context' as const, line: leftLine, raw }
    rows.push({
      left,
      right: { type: 'context', line: cur, raw },
    })
    cur++
  }
  return rows
}
