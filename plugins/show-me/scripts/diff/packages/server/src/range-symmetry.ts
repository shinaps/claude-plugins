// validateRangeSymmetry: panel.asIs.ranges と panel.toBe.ranges に含まれる「不変行 (= context 行)」が、
// git diff の hunks から逆算した「before↔after の対応マッピング」上で対称的に含まれているかを検証する。
//
// 背景:
//   panel-renderer は asIs/toBe ranges を slice してから jsdiff の LCS で再構築するため、
//   asIs と toBe の不変行が論理的に対応していないと、本来 unchanged な行が「deletion / addition」として
//   赤緑に表示される事故が起きる。
//   このバリデータは AI 出力の summary.json をゲートで弾くことで、UI 上の嘘ハイライトを根本防止する。
//
// アルゴリズム:
//   1. 各 panel について asIs + toBe 両方ある同一 file or rename ペアのみ検査
//   2. buildLineMappings(hunks) で beforeToAfter / afterToBefore の Map を作る
//      - hunk 外は cursor を進めながら identity mapping
//      - hunk 内 changed 行 (Added/Deleted) は mapping しない (undefined を意味する)
//      - hunk 外 tail は sources の行数まで、無ければ MAX_TAIL=2000 まで延長
//   3. asIs.ranges の context 行 (= asIsChangedLines に含まれない行) について
//      対応 after 行 = beforeToAfter[line] が toBe.ranges に含まれるかチェック
//   4. toBe.ranges の context 行についても逆方向に同様
//
// スキップ条件:
//   - pure addition / pure deletion (片側 absent) → 対称性問えない
//   - cross-file 移動 (asIs.file !== toBe.file かつ rename 関係でない) → hunks マッピング不可
//   - EOL-only change → 文字通り context 不変なので検証不要

import type { Panel } from '@zeus/review-diff-shared'
import { unionRanges } from '@zeus/review-diff-shared'
import type { FileChange, Hunk } from './diff-parser'
import type { SourcesMap } from './server'

export type RangeSymmetryViolation = {
  panelId: string
  intent: string
  reason: 'asis-context-not-in-tobe' | 'tobe-context-not-in-asis'
  details: {
    side: 'asIs' | 'toBe'
    file: string
    line: number
    // 反対側で含まれるべきだった対応行 (undefined: 反対側の hunk 内に落ちて mapping できない)
    expectedOpposite?: number
  }
  suggestion: string
}

export type RangeSymmetryReport = {
  ok: boolean
  violations: RangeSymmetryViolation[]
}

// PR モードで sources が取得できない時の tail 拡張 fallback 上限。
// staged モードでは sources から実ファイル行数が取れるのでこの fallback は使わない。
const MAX_TAIL_FALLBACK = 2000

export function validateRangeSymmetry(params: {
  changes: FileChange[]
  panels: Panel[]
  sources?: SourcesMap
}): RangeSymmetryReport {
  const { changes, panels, sources } = params
  const violations: RangeSymmetryViolation[] = []

  for (const p of panels) {
    if (!p.asIs || !p.toBe) continue
    const asIsFile = p.asIs.file
    const toBeFile = p.toBe.file

    // 同一 file または rename ペア (asIs.file = oldPath, toBe.file = path) のみ検査。
    // cross-file 移動 (rename 関係でない) は hunks マッピングが作れないので静かにスキップ。
    const matched = findMatchingChange(changes, asIsFile, toBeFile)
    if (!matched) continue
    if (matched.eolOnlyChange) continue

    // 行数上限: sources があれば実ファイル行数を使う (W-1 解消)。
    // before/after の行数は countLines 相当の式で求められるが、ここでは split で十分精度。
    const beforeMaxLine = computeMaxLine(sources?.get(asIsFile)?.before) ?? MAX_TAIL_FALLBACK
    const afterMaxLine = computeMaxLine(sources?.get(toBeFile)?.after) ?? MAX_TAIL_FALLBACK
    const { beforeToAfter, afterToBefore } = buildLineMappings(
      matched.hunks,
      beforeMaxLine,
      afterMaxLine,
    )

    const asIsCovered = unionRanges(p.asIs.ranges)
    const toBeCovered = unionRanges(p.toBe.ranges)

    // 検査 1: asIs の不変行 → 対応 after 行が toBe に含まれているか
    for (const line of asIsCovered) {
      if (matched.asIsChangedLines.has(line)) continue
      const afterLine = beforeToAfter.get(line)
      if (afterLine == null) continue
      if (!toBeCovered.has(afterLine)) {
        violations.push({
          panelId: p.panelId,
          intent: p.intent,
          reason: 'asis-context-not-in-tobe',
          details: { side: 'asIs', file: asIsFile, line, expectedOpposite: afterLine },
          suggestion:
            `panel "${p.intent}" [${p.panelId}]: asIs.ranges に含まれる不変行 ${line} (${asIsFile}) は ` +
            `変更後ファイルの行 ${afterLine} (${toBeFile}) に対応しますが、toBe.ranges に含まれていません。` +
            ` toBe.ranges を拡張するか、asIs.ranges からこの行を外してください。`,
        })
      }
    }

    // 検査 2: toBe の不変行 → 対応 before 行が asIs に含まれているか
    for (const line of toBeCovered) {
      if (matched.toBeChangedLines.has(line)) continue
      const beforeLine = afterToBefore.get(line)
      if (beforeLine == null) continue
      if (!asIsCovered.has(beforeLine)) {
        violations.push({
          panelId: p.panelId,
          intent: p.intent,
          reason: 'tobe-context-not-in-asis',
          details: { side: 'toBe', file: toBeFile, line, expectedOpposite: beforeLine },
          suggestion:
            `panel "${p.intent}" [${p.panelId}]: toBe.ranges に含まれる不変行 ${line} (${toBeFile}) は ` +
            `変更前ファイルの行 ${beforeLine} (${asIsFile}) に対応しますが、asIs.ranges に含まれていません。` +
            ` asIs.ranges を拡張するか、toBe.ranges からこの行を外してください。`,
        })
      }
    }
  }

  return { ok: violations.length === 0, violations }
}

// FileChange のうち、対象 panel の asIsFile / toBeFile を持つものを探す。
// - asIsFile === toBeFile の単純な modified case
// - asIsFile = oldPath, toBeFile = path の rename + 内容変更 case
function findMatchingChange(
  changes: FileChange[],
  asIsFile: string,
  toBeFile: string,
): FileChange | undefined {
  for (const c of changes) {
    if (c.path !== toBeFile) continue
    const expectedAsIs = c.oldPath ?? c.path
    if (expectedAsIs === asIsFile) return c
  }
  return undefined
}

// text の行数を返す。末尾改行は 1 行として数えない (shared/countLines と同じ式)。
function computeMaxLine(text: string | undefined): number | null {
  if (text == null || text === '') return null
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

// hunks 群から before_line ↔ after_line の Map (両方向) を構築する。
// changed 行 (hunk 内の Added/Deleted で消費される行) は mapping せず undefined 扱い。
// hunks は parse 順 (= ファイル先頭から末尾) であることを前提とする (parse-git-diff の出力順)。
export function buildLineMappings(
  hunks: Hunk[],
  beforeMax: number,
  afterMax: number,
): {
  beforeToAfter: Map<number, number>
  afterToBefore: Map<number, number>
} {
  const beforeToAfter = new Map<number, number>()
  const afterToBefore = new Map<number, number>()
  let beforeCursor = 1
  let afterCursor = 1

  for (const h of hunks) {
    // hunk 開始までの identity mapping (両側同じ行番号)
    while (beforeCursor < h.fromStart && beforeCursor <= beforeMax) {
      beforeToAfter.set(beforeCursor, afterCursor)
      afterToBefore.set(afterCursor, beforeCursor)
      beforeCursor++
      afterCursor++
    }
    // hunk 内: changed 行は mapping せず cursor を進めるだけ。
    // fromLines = 0 (pure addition hunk) の場合は before cursor を進めない。
    // toLines = 0 (pure deletion hunk) の場合は after cursor を進めない。
    beforeCursor += h.fromLines
    afterCursor += h.toLines
  }

  // 末尾の identity mapping。両側それぞれの上限まで延長。
  while (beforeCursor <= beforeMax && afterCursor <= afterMax) {
    beforeToAfter.set(beforeCursor, afterCursor)
    afterToBefore.set(afterCursor, beforeCursor)
    beforeCursor++
    afterCursor++
  }

  return { beforeToAfter, afterToBefore }
}

export function formatRangeSymmetryViolations(report: RangeSymmetryReport): string {
  if (report.violations.length === 0) return ''
  const out: string[] = []
  out.push('Range symmetry validation failed. The following panels have asymmetric asIs/toBe ranges:')
  for (const v of report.violations) {
    out.push(`  [${v.panelId}] "${v.intent}"`)
    out.push(`    ${v.suggestion}`)
  }
  out.push('')
  out.push(
    'WHY: asIs/toBe の context 行マッピングが非対称だと jsdiff LCS が「不変行を変更行扱い」して ' +
      'UI 上のハイライトが嘘になります。',
  )
  return out.join('\n')
}
