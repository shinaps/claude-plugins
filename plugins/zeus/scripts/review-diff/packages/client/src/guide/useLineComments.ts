// 行コメント (line comment) 機能の state + ハンドラ (panel model)。
//
// LineTarget は panelId をアンカーにし、side は 'asIs' | 'toBe' を使う。
// handler signature: onOpenLineForm(panelId, target) / onAddLineComment(panelId, target, body)。
//
// パフォーマンス上の WHY (useCallback / useMemo):
//   返却される 7 個の handler を毎 render 新規 function にすると、Panel / PanelBlock を React.memo
//   化しても props 参照同一性が崩れて memo が効かない。全 handler は setState callback 版で書いて
//   依存値を持たないので useCallback の依存配列は空でよい。返却オブジェクトは useMemo で安定化。

import { useCallback, useMemo, useState } from 'react'
import type { Side } from '@zeus/review-diff-shared'
import { lineCommentKey } from '../lib/state'

export type LineTarget = {
  side: Side
  number: number
  endNumber?: number
}

// 「コメント削除」の state 遷移の唯一の実装。onDeleteLineComment と onSaveEditLineComment の
// 空保存 (= 削除と同義) の両方がここを通ることで、削除の振る舞いを変えるときに修正箇所が
// 1 つで済む。key が存在しないときは prev をそのまま返し、無駄な re-render を起こさない。
function removeLineCommentAt(
  prev: Map<string, string[]>,
  key: string,
  index: number,
): Map<string, string[]> {
  const existing = prev.get(key)
  if (!existing) return prev
  const next = new Map(prev)
  const updated = existing.filter((_, i) => i !== index)
  if (updated.length === 0) next.delete(key)
  else next.set(key, updated)
  return next
}

// 編集中エントリ (`${key}#${index}`) の除去。cancel / save / delete の全経路で editing から
// エントリを消す処理が同一であることをここで保証する。
function removeEditingEntry(
  prev: Map<string, string>,
  key: string,
  index: number,
): Map<string, string> {
  const next = new Map(prev)
  next.delete(`${key}#${index}`)
  return next
}

export type LineCommentHandlers = {
  lineComments: Map<string, string[]>
  activeForm: string | null
  editing: Map<string, string>
  onOpenLineForm: (panelId: string, target: LineTarget) => void
  onCloseLineForm: () => void
  onAddLineComment: (panelId: string, target: LineTarget, body: string) => void
  onStartEditLineComment: (key: string, index: number, body: string) => void
  onCancelEditLineComment: (key: string, index: number) => void
  onSaveEditLineComment: (key: string, index: number, body: string) => void
  onDeleteLineComment: (key: string, index: number) => void
}

// regen-group → close-relaunch → restore の経路で、前回起動時の line comments を
// 引き継いで Map に seed できるよう initial を受け取る。CommentForm 側の draft は sessionStorage
// 経由で別途復元される (App.tsx mount 時に payload.initialLineCommentDrafts を sessionStorage に
// 書き戻す)。
export function useLineComments(
  initial?: { lineComments?: Map<string, string[]> },
): LineCommentHandlers {
  const [lineComments, setLineComments] = useState<Map<string, string[]>>(
    () => initial?.lineComments ? new Map(initial.lineComments) : new Map(),
  )
  const [activeForm, setActiveForm] = useState<string | null>(null)
  const [editing, setEditing] = useState<Map<string, string>>(() => new Map())

  const onOpenLineForm = useCallback((panelId: string, target: LineTarget) => {
    setActiveForm(lineCommentKey(panelId, target.side, target.number, target.endNumber))
  }, [])
  const onCloseLineForm = useCallback(() => { setActiveForm(null) }, [])
  const onAddLineComment = useCallback((panelId: string, target: LineTarget, body: string) => {
    const trimmed = body.trim()
    if (!trimmed) {
      setActiveForm(null)
      return
    }
    const key = lineCommentKey(panelId, target.side, target.number, target.endNumber)
    setLineComments(prev => {
      const next = new Map(prev)
      const existing = next.get(key) ?? []
      next.set(key, [...existing, trimmed])
      return next
    })
    setActiveForm(null)
  }, [])
  const onStartEditLineComment = useCallback((key: string, index: number, body: string) => {
    setEditing(prev => {
      const next = new Map(prev)
      next.set(`${key}#${index}`, body)
      return next
    })
  }, [])
  const onCancelEditLineComment = useCallback((key: string, index: number) => {
    setEditing(prev => removeEditingEntry(prev, key, index))
  }, [])
  const onDeleteLineComment = useCallback((key: string, index: number) => {
    setLineComments(prev => removeLineCommentAt(prev, key, index))
    setEditing(prev => removeEditingEntry(prev, key, index))
  }, [])
  const onSaveEditLineComment = useCallback((key: string, index: number, body: string) => {
    const trimmed = body.trim()
    if (!trimmed) {
      // 空保存 = 削除と同義。onDeleteLineComment と同じヘルパーを通すことで振る舞いの一致を保証する
      setLineComments(prev => removeLineCommentAt(prev, key, index))
      setEditing(prev => removeEditingEntry(prev, key, index))
      return
    }
    setLineComments(prev => {
      const existing = prev.get(key)
      if (!existing) return prev
      const next = new Map(prev)
      const updated = existing.slice()
      updated[index] = trimmed
      next.set(key, updated)
      return next
    })
    setEditing(prev => removeEditingEntry(prev, key, index))
  }, [])

  return useMemo(() => ({
    lineComments,
    activeForm,
    editing,
    onOpenLineForm,
    onCloseLineForm,
    onAddLineComment,
    onStartEditLineComment,
    onCancelEditLineComment,
    onSaveEditLineComment,
    onDeleteLineComment,
  }), [
    lineComments,
    activeForm,
    editing,
    onOpenLineForm,
    onCloseLineForm,
    onAddLineComment,
    onStartEditLineComment,
    onCancelEditLineComment,
    onSaveEditLineComment,
    onDeleteLineComment,
  ])
}
