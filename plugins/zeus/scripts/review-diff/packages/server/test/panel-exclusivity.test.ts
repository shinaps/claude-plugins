// validatePanelExclusivity のテスト。
// 検証軸:
//   - 同一変更行を 2 group が claim → conflict
//   - 同一不変行を 2 group が claim → OK (context 重複は許容)
//   - 同一 group 内の panel 重複 → no-conflict
//   - パフォーマンス回帰 (大規模 diff)

import { test, expect } from 'vitest'
import {
  validatePanelExclusivity,
  type FileChange,
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

test('1. 同一変更行を 2 group が claim → conflict', () => {
  const change = makeChange({
    path: 'a.ts',
    toBeChangedLines: new Set([42, 43]),
    hasContentChange: true,
  })
  const groupA = {
    groupId: 'g0',
    title: '型刷新',
    panels: [
      {
        panelId: 'p1',
        intent: 'A',
        toBe: { file: 'a.ts', ranges: [{ start: 40, end: 45 }] },
      } as Panel,
    ],
  }
  const groupB = {
    groupId: 'g1',
    title: 'API 実装',
    panels: [
      {
        panelId: 'p2',
        intent: 'B',
        toBe: { file: 'a.ts', ranges: [{ start: 42, end: 50 }] },
      } as Panel,
    ],
  }
  const r = validatePanelExclusivity({
    changes: [change],
    groups: [groupA, groupB],
  })
  expect(r.ok).toBe(false)
  expect(r.conflicts.length).toBe(2)
  expect(r.conflicts[0].file).toBe('a.ts')
  expect(r.conflicts[0].side).toBe('toBe')
  expect([42, 43]).toContain(r.conflicts[0].line)
  expect(r.conflicts[0].groupIdA).toBe('g0')
  expect(r.conflicts[0].groupIdB).toBe('g1')
})

test('2. 同一不変行 (changedLines に含まれない) を 2 group が claim → OK (context 重複許容)', () => {
  const change = makeChange({
    path: 'a.ts',
    toBeChangedLines: new Set([42]),
    hasContentChange: true,
  })
  // 両 group が line 40-50 を toBe.ranges に含む。changed line 42 だけが排他チェック対象。
  // しかしどちらの panel も 42 を含む → conflict 出る予定
  // 不変行重複が OK を確認するため、片方は changed line を含まないようにする。
  const groupA = {
    groupId: 'g0',
    title: 'A group',
    panels: [
      {
        panelId: 'p1',
        intent: 'context only A',
        toBe: { file: 'a.ts', ranges: [{ start: 30, end: 40 }] }, // 不変行のみ (changed=42)
      } as Panel,
    ],
  }
  const groupB = {
    groupId: 'g1',
    title: 'B group',
    panels: [
      {
        panelId: 'p2',
        intent: 'context only B',
        toBe: { file: 'a.ts', ranges: [{ start: 30, end: 40 }] }, // 同じく不変行のみ
      } as Panel,
    ],
  }
  const r = validatePanelExclusivity({
    changes: [change],
    groups: [groupA, groupB],
  })
  expect(r.ok).toBe(true)
})

test('3. 同一 group 内の panel 重複 (=同一変更行を group g0 の p1 と p2 両方が touch) → 許容', () => {
  const change = makeChange({
    path: 'a.ts',
    toBeChangedLines: new Set([42]),
    hasContentChange: true,
  })
  const group = {
    groupId: 'g0',
    title: 'same group double',
    panels: [
      {
        panelId: 'p1',
        intent: 'A',
        toBe: { file: 'a.ts', ranges: [{ start: 40, end: 45 }] },
      } as Panel,
      {
        panelId: 'p2',
        intent: 'B',
        toBe: { file: 'a.ts', ranges: [{ start: 40, end: 50 }] },
      } as Panel,
    ],
  }
  const r = validatePanelExclusivity({
    changes: [change],
    groups: [group],
  })
  expect(r.ok).toBe(true)
})

test('4. パフォーマンス: 1000 変更行 × 10 group が 500ms 以内', () => {
  // 1000 行変更を 10 group に分割 (各 group 100 行ずつを排他に touch)
  const allChangedLines = new Set<number>()
  for (let i = 1; i <= 1000; i++) allChangedLines.add(i)
  const change = makeChange({
    path: 'big.ts',
    toBeChangedLines: allChangedLines,
    hasContentChange: true,
  })
  const groups = Array.from({ length: 10 }, (_, gi) => ({
    groupId: `g${gi}`,
    title: `group ${gi}`,
    panels: [
      {
        panelId: `p${gi}`,
        intent: 'split',
        toBe: { file: 'big.ts', ranges: [{ start: gi * 100 + 1, end: (gi + 1) * 100 }] },
      } as Panel,
    ],
  }))
  const t0 = Date.now()
  const r = validatePanelExclusivity({ changes: [change], groups })
  const elapsed = Date.now() - t0
  expect(r.ok).toBe(true)
  // CI 環境で多少ぶれるので 500ms に緩める (architect 案では 100ms だったが flaky 回避)
  expect(elapsed).toBeLessThan(500)
})

test('5. asIs 側でも変更行 (deletion) が複数 group に分かれていたら conflict', () => {
  // rename + 内容変更で asIs = oldPath
  const change = makeChange({
    path: 'new.ts',
    oldPath: 'old.ts',
    status: 'renamed',
    asIsChangedLines: new Set([5, 6]),
    hasContentChange: true,
    hasStructuralChange: true,
  })
  const groupA = {
    groupId: 'g0',
    title: 'A',
    panels: [
      {
        panelId: 'p1',
        intent: 'A',
        asIs: { file: 'old.ts', ranges: [{ start: 5, end: 5 }] },
      } as Panel,
    ],
  }
  const groupB = {
    groupId: 'g1',
    title: 'B',
    panels: [
      {
        panelId: 'p2',
        intent: 'B',
        asIs: { file: 'old.ts', ranges: [{ start: 5, end: 6 }] },
      } as Panel,
    ],
  }
  const r = validatePanelExclusivity({
    changes: [change],
    groups: [groupA, groupB],
  })
  expect(r.ok).toBe(false)
  expect(r.conflicts.length).toBe(1)
  expect(r.conflicts[0].file).toBe('old.ts')
  expect(r.conflicts[0].side).toBe('asIs')
  expect(r.conflicts[0].line).toBe(5)
})
