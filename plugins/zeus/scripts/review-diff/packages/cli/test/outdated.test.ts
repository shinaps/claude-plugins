// mark-outdated の interval 抽出と outdated 自動判定の characterization test。
//
// contract:
//   - 追加・変更 hunk は after 側の行範囲、純粋削除 hunk (after len=0) は before 側の
//     削除範囲を interval として返す (削除行に anchor された thread が outdated になるため)
//   - computeOutdated は line scope thread のみ自動判定し、override (keep/force) が最優先
//   - 変更が無い thread は同一参照を返す (markOutdated の updated カウントの前提)
import { describe, expect, test } from 'vitest'
import type { ThreadSnapshot } from '@zeus/review-diff-shared'
import {
  computeOutdated,
  extractChangedIntervals,
  intervalsOverlap,
} from '../src/outdated.js'

describe('extractChangedIntervals', () => {
  test('通常 hunk は after 側の行範囲を返す', () => {
    expect(extractChangedIntervals('@@ -1,3 +1,4 @@\n')).toEqual([{ start: 1, end: 4 }])
  })

  test('len 省略 (=1) の hunk', () => {
    expect(extractChangedIntervals('@@ -2 +3 @@\n')).toEqual([{ start: 3, end: 3 }])
  })

  test('純粋削除 hunk (中間行) は before 側の削除範囲を返す', () => {
    expect(extractChangedIntervals('@@ -2 +1,0 @@\n')).toEqual([{ start: 2, end: 2 }])
  })

  test('先頭複数行の純粋削除 (after start=0) も before 範囲で返す', () => {
    expect(extractChangedIntervals('@@ -1,2 +0,0 @@\n')).toEqual([{ start: 1, end: 2 }])
  })

  test('複数 hunk を全件抽出する', () => {
    const diff = '@@ -1,2 +1,3 @@\nctx\n@@ -10,3 +11,0 @@\n'
    expect(extractChangedIntervals(diff)).toEqual([
      { start: 1, end: 3 },
      { start: 10, end: 12 },
    ])
  })

  test('hunk header 以外の @@ もどき行は無視する', () => {
    expect(extractChangedIntervals('foo @@ -1,2 +1,2 @@ bar\nplain text\n')).toEqual([])
  })
})

describe('intervalsOverlap', () => {
  test('1 点 interval 同士の一致', () => {
    expect(intervalsOverlap({ start: 9, end: 9 }, { start: 9, end: 9 })).toBe(true)
  })

  test('閉区間の境界外は交叉しない', () => {
    expect(intervalsOverlap({ start: 9, end: 9 }, { start: 10, end: 12 })).toBe(false)
  })
})

describe('computeOutdated', () => {
  function lineThread(line: number, endLine?: number, extra?: Partial<ThreadSnapshot>): ThreadSnapshot {
    return {
      scope: { type: 'line', panelId: 'p1', side: 'toBe', file: 'src/foo.ts', line, ...(endLine != null ? { endLine } : {}) },
      messages: [{ id: 'm1', author: 'user', body: 'note', ts: 1 }],
      resolved: false,
      outdated: false,
      ...extra,
    }
  }

  const changed = new Set(['src/foo.ts'])
  const pureDeletionDiff = () => '@@ -9,2 +8,0 @@\n'

  test('削除された行に anchor された thread が outdated になる (W-1 回帰テスト)', () => {
    const out = computeOutdated(lineThread(9), changed, pureDeletionDiff)
    expect(out.outdated).toBe(true)
  })

  test('削除範囲外の thread は不変 (同一参照)', () => {
    const snap = lineThread(11)
    expect(computeOutdated(snap, changed, pureDeletionDiff)).toBe(snap)
  })

  test('範囲 thread (line..endLine) が削除範囲と交叉すれば outdated', () => {
    const out = computeOutdated(lineThread(5, 9), changed, pureDeletionDiff)
    expect(out.outdated).toBe(true)
  })

  test("outdatedOverride='keep' は outdated を倒す", () => {
    const out = computeOutdated(
      lineThread(9, undefined, { outdated: true, outdatedOverride: 'keep' }),
      changed,
      pureDeletionDiff,
    )
    expect(out.outdated).toBe(false)
  })

  test("outdatedOverride='force' は交叉しなくても outdated を立てる", () => {
    const out = computeOutdated(
      lineThread(100, undefined, { outdatedOverride: 'force' }),
      changed,
      pureDeletionDiff,
    )
    expect(out.outdated).toBe(true)
  })

  test('changedFiles に無いファイルは diff を取得しない', () => {
    let called = 0
    const snap = lineThread(9)
    const out = computeOutdated(snap, new Set(['other.ts']), () => { called++; return pureDeletionDiff() })
    expect(out).toBe(snap)
    expect(called).toBe(0)
  })

  test('group / file scope は自動判定しない (同一参照)', () => {
    const group: ThreadSnapshot = {
      scope: { type: 'group', groupId: 'g0' },
      messages: [],
      resolved: false,
      outdated: false,
    }
    expect(computeOutdated(group, changed, pureDeletionDiff)).toBe(group)
  })

  test('既に outdated=true の thread は同一参照を返す (updated カウントに乗らない)', () => {
    const snap = lineThread(9, undefined, { outdated: true })
    expect(computeOutdated(snap, changed, pureDeletionDiff)).toBe(snap)
  })
})
