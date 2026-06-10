// useLineComments の characterization test。
//
// contract (外部観測可能な振る舞い):
//   - lineComments / activeForm / editing の各 Map の内容が、各 handler 適用後に
//     ここで assert する状態になること
//   - onSaveEditLineComment の空保存は onDeleteLineComment と同一の観測結果になること
//     (空保存 = 削除と同義)
//   - 存在しない key への delete / save は lineComments を無変更に保つこと
// 内部実装 (削除ロジックのヘルパー抽出など) を変えてもこのテストが通ることを保証する。

import { act, renderHook } from '@testing-library/react'
import { describe, test, expect } from 'vitest'
import { useLineComments } from '../src/guide/useLineComments'
import { lineCommentKey } from '../src/lib/state'

const KEY = lineCommentKey('p1', 'asIs', 3)

function renderWith() {
  return renderHook(() => useLineComments())
}

// 既存コメントがある状態を作る (hook は seed 引数を持たないため handler 経由で積む)
function renderWithExisting(bodies: string[]) {
  const rendered = renderWith()
  act(() => {
    for (const body of bodies) {
      rendered.result.current.onAddLineComment('p1', { side: 'asIs', number: 3 }, body)
    }
  })
  return rendered
}

describe('useLineComments: add / form open-close', () => {
  test('onAddLineComment は trim した body を key 配下に追記し form を閉じる', () => {
    const { result } = renderWith()
    act(() => {
      result.current.onOpenLineForm('p1', { side: 'asIs', number: 3 })
    })
    expect(result.current.activeForm).toBe(KEY)
    act(() => {
      result.current.onAddLineComment('p1', { side: 'asIs', number: 3 }, '  first  ')
    })
    expect(result.current.lineComments.get(KEY)).toEqual(['first'])
    expect(result.current.activeForm).toBeNull()
  })

  test('onAddLineComment は同一 key への追加でコメントを後ろに積む', () => {
    const { result } = renderWithExisting(['first'])
    act(() => {
      result.current.onAddLineComment('p1', { side: 'asIs', number: 3 }, 'second')
    })
    expect(result.current.lineComments.get(KEY)).toEqual(['first', 'second'])
  })

  test('onAddLineComment は空 body なら何も追加せず form だけ閉じる', () => {
    const { result } = renderWith()
    act(() => {
      result.current.onOpenLineForm('p1', { side: 'asIs', number: 3 })
      result.current.onAddLineComment('p1', { side: 'asIs', number: 3 }, '   ')
    })
    expect(result.current.lineComments.size).toBe(0)
    expect(result.current.activeForm).toBeNull()
  })

  test('range 指定 (endNumber) は範囲つき key に保存される', () => {
    const { result } = renderWith()
    act(() => {
      result.current.onAddLineComment('p1', { side: 'toBe', number: 5, endNumber: 8 }, 'range comment')
    })
    expect(result.current.lineComments.get(lineCommentKey('p1', 'toBe', 5, 8))).toEqual(['range comment'])
  })
})

describe('useLineComments: edit start / cancel', () => {
  test('onStartEditLineComment は editing に `${key}#${index}` で body を積み、cancel で消える', () => {
    const { result } = renderWithExisting(['first'])
    act(() => {
      result.current.onStartEditLineComment(KEY, 0, 'first')
    })
    expect(result.current.editing.get(`${KEY}#0`)).toBe('first')
    act(() => {
      result.current.onCancelEditLineComment(KEY, 0)
    })
    expect(result.current.editing.has(`${KEY}#0`)).toBe(false)
    // cancel はコメント本体には触れない
    expect(result.current.lineComments.get(KEY)).toEqual(['first'])
  })
})

describe('useLineComments: delete', () => {
  test('onDeleteLineComment は index 番目だけを除去し、残りがあれば key を保持する', () => {
    const { result } = renderWithExisting(['a', 'b', 'c'])
    act(() => {
      result.current.onDeleteLineComment(KEY, 1)
    })
    expect(result.current.lineComments.get(KEY)).toEqual(['a', 'c'])
  })

  test('onDeleteLineComment は最後の 1 件を消すと key 自体を Map から削除する', () => {
    const { result } = renderWithExisting(['only'])
    act(() => {
      result.current.onDeleteLineComment(KEY, 0)
    })
    expect(result.current.lineComments.has(KEY)).toBe(false)
  })

  test('onDeleteLineComment は editing 中のエントリも掃除する', () => {
    const { result } = renderWithExisting(['a', 'b'])
    act(() => {
      result.current.onStartEditLineComment(KEY, 1, 'b')
      result.current.onDeleteLineComment(KEY, 1)
    })
    expect(result.current.editing.has(`${KEY}#1`)).toBe(false)
    expect(result.current.lineComments.get(KEY)).toEqual(['a'])
  })

  test('onDeleteLineComment は存在しない key なら lineComments を無変更に保つ', () => {
    const { result } = renderWithExisting(['a'])
    const before = result.current.lineComments
    act(() => {
      result.current.onDeleteLineComment('missing-key', 0)
    })
    // 参照同一 (= setState が prev をそのまま返し re-render を起こさない) まで含めて contract
    expect(result.current.lineComments).toBe(before)
  })
})

describe('useLineComments: save edit', () => {
  test('onSaveEditLineComment は index 番目を trim 済み body で置換し editing を掃除する', () => {
    const { result } = renderWithExisting(['a', 'b'])
    act(() => {
      result.current.onStartEditLineComment(KEY, 0, 'a')
      result.current.onSaveEditLineComment(KEY, 0, '  updated  ')
    })
    expect(result.current.lineComments.get(KEY)).toEqual(['updated', 'b'])
    expect(result.current.editing.has(`${KEY}#0`)).toBe(false)
  })

  test('onSaveEditLineComment は存在しない key なら lineComments を無変更に保ち editing だけ掃除する', () => {
    const { result } = renderWithExisting(['a'])
    const before = result.current.lineComments
    act(() => {
      result.current.onStartEditLineComment('missing-key', 0, 'x')
      result.current.onSaveEditLineComment('missing-key', 0, 'updated')
    })
    expect(result.current.lineComments).toBe(before)
    expect(result.current.editing.has('missing-key#0')).toBe(false)
  })

  test('空保存は削除と同義: index 番目を除去し editing を掃除する', () => {
    const { result } = renderWithExisting(['a', 'b'])
    act(() => {
      result.current.onStartEditLineComment(KEY, 0, 'a')
      result.current.onSaveEditLineComment(KEY, 0, '   ')
    })
    expect(result.current.lineComments.get(KEY)).toEqual(['b'])
    expect(result.current.editing.has(`${KEY}#0`)).toBe(false)
  })

  test('空保存で最後の 1 件を消すと key 自体が Map から消える (削除と同一の観測結果)', () => {
    const { result } = renderWithExisting(['only'])
    act(() => {
      result.current.onSaveEditLineComment(KEY, 0, '')
    })
    expect(result.current.lineComments.has(KEY)).toBe(false)
  })

  test('空保存は存在しない key なら lineComments を無変更に保つ', () => {
    const { result } = renderWithExisting(['a'])
    const before = result.current.lineComments
    act(() => {
      result.current.onSaveEditLineComment('missing-key', 0, '')
    })
    expect(result.current.lineComments).toBe(before)
  })
})

describe('useLineComments: 参照安定性', () => {
  test('handler は re-render 後も参照同一 (React.memo した Panel 側の前提)', () => {
    const { result } = renderWith()
    const first = result.current
    act(() => {
      result.current.onOpenLineForm('p1', { side: 'asIs', number: 3 })
    })
    expect(result.current.onDeleteLineComment).toBe(first.onDeleteLineComment)
    expect(result.current.onSaveEditLineComment).toBe(first.onSaveEditLineComment)
    expect(result.current.onAddLineComment).toBe(first.onAddLineComment)
  })
})
