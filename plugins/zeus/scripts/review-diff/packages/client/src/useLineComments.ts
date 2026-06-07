// 行コメント (line comment) 機能の state + ハンドラを 1 つに束ねた custom hook。
//
// なぜ hook 化したか:
//   - App.tsx 本来の責務は「全体構成・送信・スクロール」だが、行コメントの 3 state +
//     7 ハンドラだけで 60 行近くを占めていた。読み手は App.tsx の上から下まで
//     スクロールしないと submit / scroll の流れを掴めない。
//   - 行コメント関連の props は App → GroupSection → FileBlock → DiffTable と
//     4 階層を素通りしており、各階層の Props 型に同じ 9 個 (lineComments / activeForm /
//     editing + 6 ハンドラ) を列挙していた。Props 型を 1 つに束ねたほうが
//     `{...lineCommentHandlers}` で spread できる。
//   - DiffTable は既に LineCommentHandlers という型でこれらを 1 つに集約していたが、
//     上位だけ素のフィールドで持つ非対称があった。ここで型ごと共有して上から下まで揃える。
//
// パフォーマンス上の WHY (useCallback / useMemo):
//   返却される 7 個の handler を毎 render 新規 function にしてしまうと、後続で
//   GroupSection / FileBlock / DiffTable を React.memo 化しても props 参照同一性が
//   崩れて memo が効かない (= App ルートの軽微な state 変化で全 file が再 render する)。
//   全 handler は setState callback 版で書いてあり依存値を持たないので、useCallback の
//   依存配列は空でよい。返却オブジェクト自体も useMemo で安定化し、state (lineComments /
//   activeForm / editing) が変わったときだけ新オブジェクトを返す。

import { useCallback, useMemo, useState } from 'react'
import { lineCommentKey } from './state.ts'

// 行コメントの handler 群と関連 state をまとめて束ねた型。
// DiffTable / FileBlock / GroupSection の Props に `& LineCommentHandlers` で混ぜ込み、
// App から `{...lineCommentHandlers}` で spread して流す。
//
// LineTarget: 単一行 (endNumber 省略) または行範囲 (endNumber あり) を指す。
// number === endNumber は意味的に「単一行」と同じなので呼び出し側は endNumber を省くべきだが、
// 実装側 (lineCommentKey / onAddLineComment) でも safety net としてその同値ケースを単一行扱いにする。
export type LineTarget = { side: 'left' | 'right'; number: number; endNumber?: number }

export type LineCommentHandlers = {
  lineComments: Map<string, string[]>
  activeForm: string | null
  editing: Map<string, string>
  onOpenLineForm: (file: string, target: LineTarget) => void
  onCloseLineForm: () => void
  onAddLineComment: (file: string, target: LineTarget, body: string) => void
  onStartEditLineComment: (key: string, index: number, body: string) => void
  onCancelEditLineComment: (key: string, index: number) => void
  onSaveEditLineComment: (key: string, index: number, body: string) => void
  onDeleteLineComment: (key: string, index: number) => void
}

export function useLineComments(): LineCommentHandlers {
  // 行コメントの本体。同じ行に複数コメントを許すため、value は string[] にしている。
  // (各要素 = 1 件のコメント本文。順序 = 投稿順。)
  const [lineComments, setLineComments] = useState<Map<string, string[]>>(() => new Map())
  // 現在「新規入力フォーム」を開いている行キー。1 度に 1 箇所だけ開く前提 (Linear / GitHub PR と同じ UX)。
  const [activeForm, setActiveForm] = useState<string | null>(null)
  // 「保存済みコメントを編集中」の状態。key = `${lineKey}#${index}`、value = 編集中の本文。
  // 編集中バッファを別 state に切り出すことで、Cancel で簡単に破棄できる。
  const [editing, setEditing] = useState<Map<string, string>>(() => new Map())

  const onOpenLineForm = useCallback((file: string, target: LineTarget) => {
    setActiveForm(lineCommentKey(file, target.side, target.number, target.endNumber))
  }, [])
  const onCloseLineForm = useCallback(() => {
    setActiveForm(null)
  }, [])
  const onAddLineComment = useCallback((file: string, target: LineTarget, body: string) => {
    const trimmed = body.trim()
    if (!trimmed) {
      setActiveForm(null)
      return
    }
    const key = lineCommentKey(file, target.side, target.number, target.endNumber)
    setLineComments((prev) => {
      const next = new Map(prev)
      const existing = next.get(key) ?? []
      next.set(key, [...existing, trimmed])
      return next
    })
    setActiveForm(null)
  }, [])
  const onStartEditLineComment = useCallback((key: string, index: number, body: string) => {
    setEditing((prev) => {
      const next = new Map(prev)
      next.set(`${key}#${index}`, body)
      return next
    })
  }, [])
  const onCancelEditLineComment = useCallback((key: string, index: number) => {
    setEditing((prev) => {
      const next = new Map(prev)
      next.delete(`${key}#${index}`)
      return next
    })
  }, [])
  const onDeleteLineComment = useCallback((key: string, index: number) => {
    setLineComments((prev) => {
      const next = new Map(prev)
      const existing = next.get(key)
      if (!existing) return prev
      const updated = existing.filter((_, i) => i !== index)
      if (updated.length === 0) next.delete(key)
      else next.set(key, updated)
      return next
    })
    // onCancelEditLineComment と同じ後始末を inline で行う。
    // useCallback の依存配列を空にしたいため、別 handler を呼ばずに直接 setEditing する。
    setEditing((prev) => {
      const next = new Map(prev)
      next.delete(`${key}#${index}`)
      return next
    })
  }, [])
  const onSaveEditLineComment = useCallback((key: string, index: number, body: string) => {
    const trimmed = body.trim()
    if (!trimmed) {
      // 空保存 = 削除と同義。onDeleteLineComment 相当の処理を inline で実行。
      setLineComments((prev) => {
        const next = new Map(prev)
        const existing = next.get(key)
        if (!existing) return prev
        const updated = existing.filter((_, i) => i !== index)
        if (updated.length === 0) next.delete(key)
        else next.set(key, updated)
        return next
      })
      setEditing((prev) => {
        const next = new Map(prev)
        next.delete(`${key}#${index}`)
        return next
      })
      return
    }
    setLineComments((prev) => {
      const next = new Map(prev)
      const existing = next.get(key)
      if (!existing) return prev
      const updated = existing.slice()
      updated[index] = trimmed
      next.set(key, updated)
      return next
    })
    setEditing((prev) => {
      const next = new Map(prev)
      next.delete(`${key}#${index}`)
      return next
    })
  }, [])

  // 返却オブジェクトを useMemo 化することで、state が変わらない限り参照同一性が保たれる。
  // これにより GroupSection 等を React.memo 化したときに props 比較が cheap に効く。
  return useMemo(
    () => ({
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
    }),
    [
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
    ],
  )
}
