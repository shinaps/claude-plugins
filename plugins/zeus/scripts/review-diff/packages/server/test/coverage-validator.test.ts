// coverage-validator.ts: asIs/toBe 別軸検証 + rename サジェスト + EOL-only skip + 構造変更検出。

import { test, expect } from 'vitest'
import { validateCoverage, type FileChange } from '@zeus/review-diff-server'
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
    // v4.12.0: FileChange に hunks 必須化。coverage 検証では hunks を直接使わないので
    // 既存テストは空配列でフォールバック。新規 validator (range-symmetry / extract-group-patch)
    // のテストでは override で実 hunk を渡す。
    hunks: overrides.hunks ?? [],
  }
}

test('1. full cover → ok=true, no misses, no warnings', () => {
  const change = makeChange({
    path: 'a.ts',
    status: 'modified',
    asIsChangedLines: new Set([10, 11, 12]),
    toBeChangedLines: new Set([10, 11, 12, 13]),
    hasContentChange: true,
  })
  const panel: Panel = {
    panelId: 'p1',
    intent: 'change',
    asIs: { file: 'a.ts', ranges: [{ start: 5, end: 15 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 5, end: 20 }] },
  }
  const r = validateCoverage({ changes: [change], panels: [panel] })
  expect(r.ok).toBe(true)
  expect(r.misses).toEqual([])
  expect(r.warnings).toEqual([])
})

test('2. toBe 軸 1 line miss → ok=false, miss with file/side/lines', () => {
  const change = makeChange({
    path: 'a.ts',
    asIsChangedLines: new Set([1]),
    toBeChangedLines: new Set([1, 2]),
    hasContentChange: true,
  })
  const panel: Panel = {
    panelId: 'p1',
    intent: 'change',
    asIs: { file: 'a.ts', ranges: [{ start: 1, end: 1 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 1, end: 1 }] }, // line 2 が漏れる
  }
  const r = validateCoverage({ changes: [change], panels: [panel] })
  expect(r.ok).toBe(false)
  const m = r.misses.find(x => x.side === 'toBe')!
  expect(m.file).toBe('a.ts')
  expect(m.lines).toEqual([2])
  expect(m.ranges).toEqual([{ start: 2, end: 2 }])
})

test('3. cross-file rename: asIs miss is reported under oldPath', () => {
  // rename + 内容変更: asIs 軸は oldPath ベースで lookup される。
  // panel が asIs.file = oldPath, toBe.file = newPath で正しく書かれているが asIs 範囲が漏れているケース。
  const change = makeChange({
    path: 'new.ts',
    oldPath: 'old.ts',
    status: 'renamed',
    asIsChangedLines: new Set([3, 4]),
    toBeChangedLines: new Set([3, 4]),
    hasContentChange: true,
    hasStructuralChange: true,
  })
  const panel: Panel = {
    panelId: 'p1',
    intent: 'rename',
    asIs: { file: 'old.ts', ranges: [{ start: 3, end: 3 }] }, // line 4 漏れ
    toBe: { file: 'new.ts', ranges: [{ start: 3, end: 4 }] },
  }
  const r = validateCoverage({ changes: [change], panels: [panel] })
  expect(r.ok).toBe(false)
  const asIsMiss = r.misses.find(m => m.side === 'asIs')!
  expect(asIsMiss.file).toBe('old.ts')
  expect(asIsMiss.lines).toEqual([4])
})

test('4. context-only panel: panel exists but range does not overlap changed lines is OK if another panel carries them', () => {
  // changed = [10], panel A は context (1-5), panel B が 10 を cover
  const change = makeChange({
    path: 'a.ts',
    asIsChangedLines: new Set([10]),
    toBeChangedLines: new Set([10]),
    hasContentChange: true,
  })
  const context: Panel = {
    panelId: 'ctx',
    intent: 'context',
    asIs: { file: 'a.ts', ranges: [{ start: 1, end: 5 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 1, end: 5 }] },
  }
  const carrier: Panel = {
    panelId: 'p1',
    intent: 'change',
    asIs: { file: 'a.ts', ranges: [{ start: 10, end: 10 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 10, end: 10 }] },
  }
  const r = validateCoverage({ changes: [change], panels: [context, carrier] })
  expect(r.ok).toBe(true)
})

test('5. duplicate panels covering same range are OK (FR-9)', () => {
  const change = makeChange({
    path: 'a.ts',
    asIsChangedLines: new Set([3]),
    toBeChangedLines: new Set([3]),
    hasContentChange: true,
  })
  const p1: Panel = {
    panelId: 'p1', intent: 'a',
    asIs: { file: 'a.ts', ranges: [{ start: 1, end: 5 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 1, end: 5 }] },
  }
  const p2: Panel = {
    panelId: 'p2', intent: 'b',
    asIs: { file: 'a.ts', ranges: [{ start: 1, end: 5 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 1, end: 5 }] },
  }
  const r = validateCoverage({ changes: [change], panels: [p1, p2] })
  expect(r.ok).toBe(true)
})

test('6. rename without content change → miss with renameSuggestion when no panel mentions either path', () => {
  const change = makeChange({
    path: 'new.ts',
    oldPath: 'old.ts',
    status: 'renamed',
    hasContentChange: false,
    hasStructuralChange: true,
  })
  // panel は無関係なファイルにしか言及していない
  const irrelevant: Panel = {
    panelId: 'p1', intent: 'other',
    toBe: { file: 'other.ts', ranges: [{ start: 1, end: 1 }] },
  }
  const r = validateCoverage({ changes: [change], panels: [irrelevant] })
  expect(r.ok).toBe(false)
  const miss = r.misses[0]
  expect(miss.file).toBe('new.ts')
  expect(miss.renameSuggestion).toEqual({ from: 'old.ts', to: 'new.ts' })
  expect(miss.ranges).toEqual([])
})

test('7. EOL-only change → ok=true, warnings populated', () => {
  const change = makeChange({
    path: 'a.ts',
    hasContentChange: false,
    eolOnlyChange: true,
  })
  const r = validateCoverage({ changes: [change], panels: [] })
  expect(r.ok).toBe(true)
  expect(r.warnings.length).toBe(1)
  expect(r.warnings[0]).toContain('EOL-only')
  expect(r.warnings[0]).toContain('a.ts')
})
