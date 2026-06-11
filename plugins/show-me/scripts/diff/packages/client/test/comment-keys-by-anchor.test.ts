// buildCommentKeysByAnchor の characterization test。
//
// contract (Panel → SplitBody → SideRow に渡る逆引き Map の外部観測可能な形):
//   - key: `${side}\x1f${anchor}` (anchor = endNumber ?? number、range は終端行)
//   - value: その anchor に紐づく lineCommentKey の配列
//   - 構成順序: lineComments の挿入順 → activeForm (未含有時のみ) → threads (未含有時のみ)
//   - 他 panel の key / line 以外の scope の thread は除外
// 内部実装 (ヘルパー分割・ループ構造) を変えてもこのテストが通ることを保証する。

import { describe, test, expect } from 'vitest'
import type { ThreadSnapshot } from '@show-me/diff-shared'
import { buildCommentKeysByAnchor } from '../src/guide/Panel'
import { lineCommentKey } from '../src/lib/state'

const SEP = '\x1f'

function lineThread(panelId: string, side: 'asIs' | 'toBe', line: number, endLine?: number): ThreadSnapshot {
  return {
    scope: { type: 'line', panelId, side, file: 'a.ts', line, ...(endLine != null ? { endLine } : {}) },
    messages: [],
  } as unknown as ThreadSnapshot
}

describe('buildCommentKeysByAnchor: lineComments 系統', () => {
  test('単一行 key は number を anchor に grouping される', () => {
    const k3 = lineCommentKey('p1', 'asIs', 3)
    const k5 = lineCommentKey('p1', 'toBe', 5)
    const map = buildCommentKeysByAnchor('p1', [k3, k5], null, undefined)
    expect(map.get(`asIs${SEP}3`)).toEqual([k3])
    expect(map.get(`toBe${SEP}5`)).toEqual([k5])
    expect(map.size).toBe(2)
  })

  test('range key は endNumber (終端行) を anchor にする', () => {
    const range = lineCommentKey('p1', 'asIs', 2, 6)
    const map = buildCommentKeysByAnchor('p1', [range], null, undefined)
    expect(map.get(`asIs${SEP}6`)).toEqual([range])
    expect(map.has(`asIs${SEP}2`)).toBe(false)
  })

  test('同一 anchor の range + 単一行は挿入順で同じ配列にまとまる', () => {
    const range = lineCommentKey('p1', 'asIs', 2, 6)
    const single = lineCommentKey('p1', 'asIs', 6)
    const map = buildCommentKeysByAnchor('p1', [range, single], null, undefined)
    expect(map.get(`asIs${SEP}6`)).toEqual([range, single])
  })

  test('他 panel の key は除外される', () => {
    const other = lineCommentKey('p2', 'asIs', 3)
    const map = buildCommentKeysByAnchor('p1', [other], null, undefined)
    expect(map.size).toBe(0)
  })

  test('空入力なら空 Map', () => {
    expect(buildCommentKeysByAnchor('p1', [], null, undefined).size).toBe(0)
  })
})

describe('buildCommentKeysByAnchor: activeForm 系統', () => {
  test('lineComments に無い activeForm は末尾に追記される (新規入力中の行に CommentRow を出す)', () => {
    const existing = lineCommentKey('p1', 'asIs', 3)
    const form = lineCommentKey('p1', 'asIs', 7)
    const map = buildCommentKeysByAnchor('p1', [existing], form, undefined)
    expect(map.get(`asIs${SEP}7`)).toEqual([form])
  })

  test('lineComments と同一 key の activeForm は重複追記しない', () => {
    const key = lineCommentKey('p1', 'asIs', 3)
    const map = buildCommentKeysByAnchor('p1', [key], key, undefined)
    expect(map.get(`asIs${SEP}3`)).toEqual([key])
  })

  test('他 panel の activeForm は無視される', () => {
    const form = lineCommentKey('p2', 'asIs', 3)
    const map = buildCommentKeysByAnchor('p1', [], form, undefined)
    expect(map.size).toBe(0)
  })
})

describe('buildCommentKeysByAnchor: threads 系統', () => {
  test('line scope thread は lineCommentKey に変換され endLine を anchor に追記される', () => {
    const map = buildCommentKeysByAnchor('p1', [], null, {
      t1: lineThread('p1', 'toBe', 2, 4),
    })
    expect(map.get(`toBe${SEP}4`)).toEqual([lineCommentKey('p1', 'toBe', 2, 4)])
  })

  test('lineComments に既に同一 key があれば重複追記しない', () => {
    const key = lineCommentKey('p1', 'asIs', 5)
    const map = buildCommentKeysByAnchor('p1', [key], null, {
      t1: lineThread('p1', 'asIs', 5),
    })
    expect(map.get(`asIs${SEP}5`)).toEqual([key])
  })

  test('line 以外の scope / 他 panel の thread は除外される', () => {
    const map = buildCommentKeysByAnchor('p1', [], null, {
      file: { scope: { type: 'file', file: 'a.ts' }, messages: [] } as unknown as ThreadSnapshot,
      other: lineThread('p2', 'asIs', 3),
    })
    expect(map.size).toBe(0)
  })

  test('3 系統が同一 anchor に混在しても順序は lineComments → activeForm → threads', () => {
    // 同一 anchor 6 に: range (lineComments) / 単一行 (activeForm) / 別 range (threads)
    const fromComments = lineCommentKey('p1', 'asIs', 2, 6)
    const fromForm = lineCommentKey('p1', 'asIs', 6)
    const fromThread = lineCommentKey('p1', 'asIs', 4, 6)
    const map = buildCommentKeysByAnchor('p1', [fromComments], fromForm, {
      t1: lineThread('p1', 'asIs', 4, 6),
    })
    expect(map.get(`asIs${SEP}6`)).toEqual([fromComments, fromForm, fromThread])
  })
})
