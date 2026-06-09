// v4.7.0 panel model 用の行コメント入力フォーム。
//
// 旧 DiffTable 内 NewCommentForm との違い:
//   - sessionStorage に draft を退避する (panelId + side + number で key 生成)
//   - panelId / side ('asIs'|'toBe') / number / endNumber を直接 props として受ける
//
// draft key 形式: `draft:${panelId}:${side}:${number}[:${endNumber}]`
//   panelId は zod 側で sanitize 済み (空白 → '-'、ASCII のみ) で ':' を含まないため、
//   ':' を区切り子に使っても安全。

import { useEffect, useRef, useState } from 'react'

export type CommentFormProps = {
  panelId: string
  side: 'asIs' | 'toBe'
  number: number
  endNumber?: number
  onSave: (body: string) => void
  onCancel: () => void
}

const DRAFT_PREFIX = 'draft:'

export function CommentForm(props: CommentFormProps) {
  const { panelId, side, number, endNumber, onSave, onCancel } = props
  const draftKey = buildDraftKey(panelId, side, number, endNumber)
  const [body, setBody] = useState<string>(() => readDraft(draftKey))
  const ref = useRef<HTMLTextAreaElement>(null)

  // マウント時に自動 focus + draft 既存ならカーソル末尾に
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const len = el.value.length
    el.setSelectionRange(len, len)
  }, [])

  // body 変化時に draft を sessionStorage に保存。空文字なら remove。
  useEffect(() => {
    if (body === '') removeDraft(draftKey)
    else writeDraft(draftKey, body)
  }, [body, draftKey])

  return (
    <form
      className="bg-surface border border-border-soft rounded-lg p-2.5 px-3 flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(body)
        removeDraft(draftKey)
      }}
    >
      <textarea
        ref={ref}
        className="w-full min-h-[70px] bg-background text-text border border-border rounded-md px-2.5 py-2 font-sans text-[13px] leading-[1.5] resize-y outline-none transition-colors duration-100 focus:border-accent"
        placeholder="コメントを書く (Cmd/Ctrl+Enter で保存、Esc でキャンセル)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            onSave(body)
            removeDraft(draftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            // Escape は「キャンセル」だが draft は意図的に保持する。
            // 「再度フォームを開いたら書きかけが復元される」が期待される挙動。
            onCancel()
          }
        }}
      />
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          className="px-3 py-1 border border-border rounded-md text-xs font-medium font-sans cursor-pointer bg-transparent text-text-muted hover:bg-surface-3 hover:text-text transition-colors duration-100"
          onClick={onCancel}
        >
          キャンセル
        </button>
        <button
          type="submit"
          className="px-3 py-1 border border-accent bg-accent rounded-md text-xs font-medium font-sans cursor-pointer text-white hover:brightness-[1.08] transition-[filter,background] duration-100"
        >
          保存
        </button>
      </div>
    </form>
  )
}

export function buildDraftKey(
  panelId: string,
  side: 'asIs' | 'toBe',
  number: number,
  endNumber?: number,
): string {
  if (endNumber != null && endNumber !== number) {
    return `${DRAFT_PREFIX}${panelId}:${side}:${number}:${endNumber}`
  }
  return `${DRAFT_PREFIX}${panelId}:${side}:${number}`
}

function readDraft(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? ''
  } catch { return '' }
}

function writeDraft(key: string, body: string): void {
  try { sessionStorage.setItem(key, body) } catch { /* storage unavailable */ }
}

function removeDraft(key: string): void {
  try { sessionStorage.removeItem(key) } catch { /* storage unavailable */ }
}
