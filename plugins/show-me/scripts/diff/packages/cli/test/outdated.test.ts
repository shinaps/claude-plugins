// mark-outdated の interval 抽出と outdated 自動判定の characterization test。
//
// contract:
//   - interval は全 hunk で before 側の行範囲に統一する。thread の line anchor は apply 前の
//     内容 (= diff の before 側 = レビュアーが見ていた toBe 表示) を指しており、after 座標を
//     混ぜると先行 hunk の行数増減で後続 hunk がドリフトして誤判定するため
//   - 純粋挿入 hunk (before len=0) は既存行を変更しないため interval を作らない
//   - computeOutdated は toBe line scope thread のみ自動判定し、override (keep/force) が最優先
//   - 変更が無い thread は同一参照を返す (markOutdated の updated カウントの前提)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { ThreadSnapshot } from '@show-me/diff-shared'
import {
  computeOutdated,
  extractChangedIntervals,
  intervalsOverlap,
  markOutdated,
} from '../src/outdated.js'

describe('extractChangedIntervals', () => {
  test('変更 hunk は before 側の行範囲を返す', () => {
    expect(extractChangedIntervals('@@ -1,3 +1,4 @@\n')).toEqual([{ start: 1, end: 3 }])
  })

  test('len 省略 (=1) の hunk', () => {
    expect(extractChangedIntervals('@@ -2 +3 @@\n')).toEqual([{ start: 2, end: 2 }])
  })

  test('純粋削除 hunk (中間行) は before 側の削除範囲を返す', () => {
    expect(extractChangedIntervals('@@ -2 +1,0 @@\n')).toEqual([{ start: 2, end: 2 }])
  })

  test('先頭複数行の純粋削除 (after start=0) も before 範囲で返す', () => {
    expect(extractChangedIntervals('@@ -1,2 +0,0 @@\n')).toEqual([{ start: 1, end: 2 }])
  })

  test('純粋挿入 hunk (before len=0) は interval を作らない', () => {
    expect(extractChangedIntervals('@@ -5,0 +6,3 @@\n')).toEqual([])
  })

  test('複数 hunk を全件 before 座標で抽出する', () => {
    const diff = '@@ -1,2 +1,3 @@\nctx\n@@ -10,3 +11,0 @@\n'
    expect(extractChangedIntervals(diff)).toEqual([
      { start: 1, end: 2 },
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

  test('asIs anchor の thread は交叉する diff があっても自動判定しない (同一参照)', () => {
    const snap: ThreadSnapshot = {
      scope: { type: 'line', panelId: 'p1', side: 'asIs', file: 'src/foo.ts', line: 9 },
      messages: [{ id: 'm1', author: 'user', body: 'note', ts: 1 }],
      resolved: false,
      outdated: false,
    }
    expect(computeOutdated(snap, changed, pureDeletionDiff)).toBe(snap)
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

describe('markOutdated (read-modify-write の安全性)', () => {
  function writeRestore(threads: Record<string, unknown>, extra?: Record<string, unknown>): {
    dir: string
    restorePath: string
    changedPath: string
  } {
    const dir = mkdtempSync(join(tmpdir(), 'mark-outdated-test-'))
    const restorePath = join(dir, 'restore.json')
    const changedPath = join(dir, 'changed-files.txt')
    writeFileSync(restorePath, JSON.stringify({ schemaVersion: 2, threads, ...extra }), 'utf8')
    // changed-files を空にして git diff 経路を踏まずに書き戻しロジックだけ検証する
    writeFileSync(changedPath, '', 'utf8')
    return { dir, restorePath, changedPath }
  }

  test('scope 欠損の不正 thread と未知フィールドは原文のまま書き戻される (drop による消失防止)', () => {
    const valid = {
      scope: { type: 'group', groupId: 'g0' },
      messages: [],
      resolved: false,
      outdated: false,
      customField: 'preserve-me',
    }
    const broken = { messages: [], resolved: false }
    const { dir, restorePath, changedPath } = writeRestore({ valid, broken })
    try {
      const result = markOutdated({ restoreStatePath: restorePath, changedFilesPath: changedPath })
      expect(result.totalThreads).toBe(2)
      const after = JSON.parse(readFileSync(restorePath, 'utf8'))
      expect(after.threads.broken).toEqual(broken)
      expect(after.threads.valid.customField).toBe('preserve-me')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("outdatedOverride='keep' の書き戻しは outdated だけ倒し他フィールドを温存する", () => {
    const thread = {
      scope: { type: 'line', panelId: 'p1', side: 'toBe', file: 'src/foo.ts', line: 3 },
      messages: [{ id: 'm1', author: 'user', body: 'note', ts: 1 }],
      resolved: true,
      outdated: true,
      outdatedOverride: 'keep',
      extraMeta: { keep: true },
    }
    const { dir, restorePath, changedPath } = writeRestore({ t: thread })
    try {
      const result = markOutdated({ restoreStatePath: restorePath, changedFilesPath: changedPath })
      expect(result.updated).toBe(1)
      const after = JSON.parse(readFileSync(restorePath, 'utf8'))
      expect(after.threads.t.outdated).toBe(false)
      expect(after.threads.t.resolved).toBe(true)
      expect(after.threads.t.extraMeta).toEqual({ keep: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('threads が配列でも crash せず threads 0 件として扱う', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mark-outdated-test-'))
    const restorePath = join(dir, 'restore.json')
    const changedPath = join(dir, 'changed-files.txt')
    writeFileSync(restorePath, JSON.stringify({ schemaVersion: 2, threads: [1, 2] }), 'utf8')
    writeFileSync(changedPath, '', 'utf8')
    try {
      const result = markOutdated({ restoreStatePath: restorePath, changedFilesPath: changedPath })
      expect(result.totalThreads).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
