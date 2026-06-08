// validateRangeSymmetry のテスト。
// 検証軸:
//   - 完全対称 (= AI が正しい summary.json を書いた) → ok=true
//   - asIs / toBe の不変行が反対側に存在しない → violation
//   - cross-file 移動 (rename 関係でない) → スキップ
//   - pure addition / pure deletion → スキップ
//   - rename + 内容変更 (oldPath/newPath) → 正常検査
//   - EOL-only change → スキップ
//   - 巨大ファイル末尾近くの panel (sources あり) → MAX_TAIL fallback 不要で検出

import { test, expect } from 'vitest'
import {
  validateRangeSymmetry,
  buildLineMappings,
  type FileChange,
  type Hunk,
} from '@zeus/review-diff-server'
import type { Panel } from '@zeus/review-diff-shared'

function makeChange(overrides: Partial<FileChange> & { path: string }): FileChange {
  return {
    path: overrides.path,
    oldPath: overrides.oldPath,
    status: overrides.status ?? 'modified',
    language: overrides.language ?? 'plaintext',
    additions: overrides.additions ?? 0,
    deletions: overrides.deletions ?? 0,
    asIsChangedLines: overrides.asIsChangedLines ?? new Set(),
    toBeChangedLines: overrides.toBeChangedLines ?? new Set(),
    hasContentChange: overrides.hasContentChange ?? false,
    hasStructuralChange: overrides.hasStructuralChange ?? false,
    eolOnlyChange: overrides.eolOnlyChange ?? false,
    hunks: overrides.hunks ?? [],
  }
}

// 1 hunk の典型例: before lines 10-14 (5 行) を after lines 10-16 (7 行) に変更
// before 1-9 と after 1-9 は identity mapping
// hunk 内 before 10-14, after 10-16 は changed 行で mapping せず
// hunk 後 before 15+ と after 17+ は (cursor のシフト後の) identity mapping
const SIMPLE_HUNK: Hunk = { fromStart: 10, fromLines: 5, toStart: 10, toLines: 7 }

test('1. 完全対称な panel → ok=true (no violations)', () => {
  const change = makeChange({
    path: 'a.ts',
    asIsChangedLines: new Set([10, 11, 12, 13, 14]),
    toBeChangedLines: new Set([10, 11, 12, 13, 14, 15, 16]),
    hasContentChange: true,
    hunks: [SIMPLE_HUNK],
  })
  // asIs 5-9 (= context 5 行) + hunk + 15-20 (= context 6 行)
  // 対応 toBe = 5-9 + hunk(10-16) + 17-22
  const panel: Panel = {
    panelId: 'p1',
    intent: 'change foo',
    asIs: { file: 'a.ts', ranges: [{ start: 5, end: 20 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 5, end: 22 }] },
  }
  const r = validateRangeSymmetry({ changes: [change], panels: [panel] })
  expect(r.ok).toBe(true)
  expect(r.violations).toEqual([])
})

test('2. asIs に不変行があるが対応 after 行が toBe にない → violation', () => {
  const change = makeChange({
    path: 'a.ts',
    asIsChangedLines: new Set([10, 11, 12, 13, 14]),
    toBeChangedLines: new Set([10, 11, 12, 13, 14, 15, 16]),
    hasContentChange: true,
    hunks: [SIMPLE_HUNK],
  })
  // asIs は line 5-20 (末尾 15-20 = 6 行の不変行) 含むが、toBe は 5-18 (17-18 = 2 行のみ)
  // 不変行 15→17, 16→18 は OK
  // 不変行 17→19, 18→20, 19→21, 20→22 は toBe にない → 4 violations
  const panel: Panel = {
    panelId: 'p1',
    intent: 'change foo',
    asIs: { file: 'a.ts', ranges: [{ start: 5, end: 20 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 5, end: 18 }] },
  }
  const r = validateRangeSymmetry({ changes: [change], panels: [panel] })
  expect(r.ok).toBe(false)
  expect(r.violations.length).toBeGreaterThan(0)
  expect(r.violations.every(v => v.reason === 'asis-context-not-in-tobe')).toBe(true)
  expect(r.violations[0].details.file).toBe('a.ts')
})

test('3. toBe に不変行があるが対応 before 行が asIs にない → violation', () => {
  const change = makeChange({
    path: 'a.ts',
    asIsChangedLines: new Set([10, 11, 12, 13, 14]),
    toBeChangedLines: new Set([10, 11, 12, 13, 14, 15, 16]),
    hasContentChange: true,
    hunks: [SIMPLE_HUNK],
  })
  // asIs は 5-15 (15 = 1 行の不変行)、toBe は 5-22 (17-22 = 6 行の不変行)
  // toBe 17→15(asIs にある), 18→16(asIs にない), 19→17, 20→18, 21→19, 22→20 → 5 violations
  const panel: Panel = {
    panelId: 'p1',
    intent: 'change foo',
    asIs: { file: 'a.ts', ranges: [{ start: 5, end: 15 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 5, end: 22 }] },
  }
  const r = validateRangeSymmetry({ changes: [change], panels: [panel] })
  expect(r.ok).toBe(false)
  expect(r.violations.length).toBeGreaterThan(0)
  expect(r.violations.every(v => v.reason === 'tobe-context-not-in-asis')).toBe(true)
})

test('4. cross-file 移動 (rename 関係でない) → スキップ (ok=true)', () => {
  // asIs.file = 'a.ts', toBe.file = 'b.ts' で rename ではない → 検査スキップ
  const changeA = makeChange({ path: 'a.ts', status: 'modified', hasContentChange: true })
  const changeB = makeChange({ path: 'b.ts', status: 'modified', hasContentChange: true })
  const panel: Panel = {
    panelId: 'p1',
    intent: 'move foo from a.ts to b.ts',
    asIs: { file: 'a.ts', ranges: [{ start: 1, end: 10 }] },
    toBe: { file: 'b.ts', ranges: [{ start: 1, end: 20 }] },
  }
  const r = validateRangeSymmetry({ changes: [changeA, changeB], panels: [panel] })
  expect(r.ok).toBe(true)
})

test('5. pure addition (asIs absent) → スキップ (ok=true)', () => {
  const change = makeChange({
    path: 'a.ts',
    status: 'added',
    toBeChangedLines: new Set([1, 2, 3]),
    hasContentChange: true,
    hunks: [{ fromStart: 0, fromLines: 0, toStart: 1, toLines: 3 }],
  })
  const panel: Panel = {
    panelId: 'p1',
    intent: 'new file',
    toBe: { file: 'a.ts', ranges: [{ start: 1, end: 3 }] },
  }
  const r = validateRangeSymmetry({ changes: [change], panels: [panel] })
  expect(r.ok).toBe(true)
})

test('6. pure deletion (toBe absent) → スキップ (ok=true)', () => {
  const change = makeChange({
    path: 'a.ts',
    status: 'deleted',
    asIsChangedLines: new Set([1, 2, 3]),
    hasContentChange: true,
    hunks: [{ fromStart: 1, fromLines: 3, toStart: 0, toLines: 0 }],
  })
  const panel: Panel = {
    panelId: 'p1',
    intent: 'delete file',
    asIs: { file: 'a.ts', ranges: [{ start: 1, end: 3 }] },
  }
  const r = validateRangeSymmetry({ changes: [change], panels: [panel] })
  expect(r.ok).toBe(true)
})

test('7. rename + 内容変更 (asIs=oldPath, toBe=newPath) → 正常検査される', () => {
  const change = makeChange({
    path: 'new.ts',
    oldPath: 'old.ts',
    status: 'renamed',
    asIsChangedLines: new Set([10, 11, 12, 13, 14]),
    toBeChangedLines: new Set([10, 11, 12, 13, 14, 15, 16]),
    hasContentChange: true,
    hasStructuralChange: true,
    hunks: [SIMPLE_HUNK],
  })
  const panel: Panel = {
    panelId: 'p1',
    intent: 'rename and edit',
    asIs: { file: 'old.ts', ranges: [{ start: 5, end: 20 }] },
    toBe: { file: 'new.ts', ranges: [{ start: 5, end: 22 }] },
  }
  const r = validateRangeSymmetry({ changes: [change], panels: [panel] })
  expect(r.ok).toBe(true)
})

test('8. EOL-only change → スキップ (ok=true)', () => {
  const change = makeChange({
    path: 'a.ts',
    hasContentChange: false,
    eolOnlyChange: true,
  })
  const panel: Panel = {
    panelId: 'p1',
    intent: 'eol only',
    asIs: { file: 'a.ts', ranges: [{ start: 1, end: 5 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 1, end: 4 }] },
  }
  const r = validateRangeSymmetry({ changes: [change], panels: [panel] })
  expect(r.ok).toBe(true)
})

test('9. buildLineMappings: hunk 外は identity, hunk 内は mapping 無し, 末尾は shift で identity', () => {
  const { beforeToAfter, afterToBefore } = buildLineMappings([SIMPLE_HUNK], 20, 22)
  // hunk 前 (1-9) identity
  for (let i = 1; i <= 9; i++) {
    expect(beforeToAfter.get(i)).toBe(i)
    expect(afterToBefore.get(i)).toBe(i)
  }
  // hunk 内 before 10-14, after 10-16 → mapping なし
  for (let i = 10; i <= 14; i++) expect(beforeToAfter.has(i)).toBe(false)
  for (let i = 10; i <= 16; i++) expect(afterToBefore.has(i)).toBe(false)
  // hunk 後: before 15 → after 17 (= 15 + (7-5))
  expect(beforeToAfter.get(15)).toBe(17)
  expect(beforeToAfter.get(20)).toBe(22)
  expect(afterToBefore.get(17)).toBe(15)
  expect(afterToBefore.get(22)).toBe(20)
})

test('10. buildLineMappings: pure addition hunk (fromLines=0) でも cursor は正しく進む', () => {
  // hunk: before 5 と 6 の間に after 6-10 を 5 行追加
  // → fromStart=5 (insertion anchor は line 5 の後)、fromLines=0
  //   toStart=6, toLines=5
  // before 1-5 → after 1-5 (identity)
  // before 6+ → after 11+ (5 行シフト)
  const { beforeToAfter, afterToBefore } = buildLineMappings(
    [{ fromStart: 6, fromLines: 0, toStart: 6, toLines: 5 }],
    10,
    15,
  )
  // hunk 前: before 1-5 → after 1-5
  for (let i = 1; i <= 5; i++) {
    expect(beforeToAfter.get(i)).toBe(i)
  }
  // hunk 後: before 6 → after 11
  expect(beforeToAfter.get(6)).toBe(11)
  expect(beforeToAfter.get(10)).toBe(15)
  expect(afterToBefore.get(11)).toBe(6)
  // pure addition なので after 6-10 は mapping なし
  for (let i = 6; i <= 10; i++) expect(afterToBefore.has(i)).toBe(false)
})
