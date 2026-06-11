// merge-threads (pending 層 → thread 合成) の characterization test。
//
// contract:
//   - lineComments Map / group textarea 残量が threadKey ベースの thread に合成される
//   - 既存 thread には user message を append し resolved を倒す (open に戻す)
//   - 同一 anchor の複数 body は 1 thread 内の連続 message として順序を維持する
//   - trim 後空の body は捨てる。入力 threads は変更しない (非破壊)
import { describe, expect, test } from 'vitest'
import type { ThreadSnapshot } from '@show-me/diff-shared'
import { mergeGroupCommentsIntoThreads, mergeLineCommentsIntoThreads } from '../src/lib/merge-threads'
import { lineCommentKey } from '../src/lib/state'

const panelFileMap = new Map([
  ['p1', { asIsFile: 'src/a.ts', toBeFile: 'src/b.ts' }],
  ['p2', { toBeFile: 'src/added.ts' }],
])

describe('mergeLineCommentsIntoThreads', () => {
  test('単一行コメントが line scope thread になる (side に応じた file 解決)', () => {
    const out = mergeLineCommentsIntoThreads(
      {},
      new Map([[lineCommentKey('p1', 'toBe', 2), ['needs null check']]]),
      panelFileMap,
    )
    const thread = out['line:p1:toBe:2']
    expect(thread.scope).toEqual({ type: 'line', panelId: 'p1', side: 'toBe', file: 'src/b.ts', line: 2 })
    expect(thread.messages).toHaveLength(1)
    expect(thread.messages[0]).toMatchObject({ author: 'user', body: 'needs null check' })
    expect(thread.resolved).toBe(false)
    expect(thread.outdated).toBe(false)
  })

  test('行範囲コメントは endLine 付き scope / key になる', () => {
    const out = mergeLineCommentsIntoThreads(
      {},
      new Map([[lineCommentKey('p1', 'asIs', 3, 5), ['range note']]]),
      panelFileMap,
    )
    const thread = out['line:p1:asIs:3:5']
    expect(thread.scope).toMatchObject({ type: 'line', line: 3, endLine: 5, file: 'src/a.ts' })
  })

  test('片側 panel では反対側の file に fallback する', () => {
    const out = mergeLineCommentsIntoThreads(
      {},
      new Map([[lineCommentKey('p2', 'asIs', 1), ['note']]]),
      panelFileMap,
    )
    expect(out['line:p2:asIs:1'].scope).toMatchObject({ file: 'src/added.ts' })
  })

  test('同一 anchor の複数 body は 1 thread に順序維持で積まれる', () => {
    const out = mergeLineCommentsIntoThreads(
      {},
      new Map([[lineCommentKey('p1', 'toBe', 2), ['first', 'second']]]),
      panelFileMap,
    )
    expect(out['line:p1:toBe:2'].messages.map(m => m.body)).toEqual(['first', 'second'])
  })

  test('既存 thread には append し resolved を倒す', () => {
    const existing: Record<string, ThreadSnapshot> = {
      'line:p1:toBe:2': {
        scope: { type: 'line', panelId: 'p1', side: 'toBe', file: 'src/b.ts', line: 2 },
        messages: [{ id: 'm1', author: 'agent', body: 'fixed', ts: 1 }],
        resolved: true,
        outdated: false,
      },
    }
    const out = mergeLineCommentsIntoThreads(
      existing,
      new Map([[lineCommentKey('p1', 'toBe', 2), ['still broken']]]),
      panelFileMap,
    )
    expect(out['line:p1:toBe:2'].messages.map(m => m.body)).toEqual(['fixed', 'still broken'])
    expect(out['line:p1:toBe:2'].resolved).toBe(false)
    // 入力は非破壊
    expect(existing['line:p1:toBe:2'].messages).toHaveLength(1)
    expect(existing['line:p1:toBe:2'].resolved).toBe(true)
  })

  test('trim 後空の body は捨てる (全部空なら thread を作らない)', () => {
    const out = mergeLineCommentsIntoThreads(
      {},
      new Map([[lineCommentKey('p1', 'toBe', 2), ['   ']]]),
      panelFileMap,
    )
    expect(out['line:p1:toBe:2']).toBeUndefined()
  })
})

describe('mergeGroupCommentsIntoThreads', () => {
  test('textarea 残量が group scope thread に合成される', () => {
    const out = mergeGroupCommentsIntoThreads({}, { g0: '  looks risky  ' })
    expect(out['group:g0'].scope).toEqual({ type: 'group', groupId: 'g0' })
    expect(out['group:g0'].messages[0]).toMatchObject({ author: 'user', body: 'looks risky' })
  })

  test('空文字 / 空白のみのエントリは無視する', () => {
    const out = mergeGroupCommentsIntoThreads({}, { g0: '', g1: '   ' })
    expect(Object.keys(out)).toHaveLength(0)
  })

  test('既存 group thread には append し resolved を倒す', () => {
    const existing: Record<string, ThreadSnapshot> = {
      'group:g0': {
        scope: { type: 'group', groupId: 'g0' },
        messages: [{ id: 'm1', author: 'user', body: 'earlier', ts: 1 }],
        resolved: true,
        outdated: false,
      },
    }
    const out = mergeGroupCommentsIntoThreads(existing, { g0: 'follow-up' })
    expect(out['group:g0'].messages.map(m => m.body)).toEqual(['earlier', 'follow-up'])
    expect(out['group:g0'].resolved).toBe(false)
  })
})
