// Activity タブの Conversation カード末尾に置くスレッド返信フォーム。
// 「Comment ボタンで pending として threads に積む → SubmitBar の Comment / Submit で一括送信」
// という GitHub 流 pending モデルに同乗する (即時送信はしない)。
//
// draft は sessionStorage に `draft:activity-reply:<threadKey>` で永続化する。
//   - `draft:` prefix なので App の collectAllDrafts() が無変更で回収し、regen / comment-reply の
//     close-relaunch 後に restore.json → initialLineCommentDrafts → sessionStorage 書き戻し →
//     mount 時 read で復元が一周する。
//   - draft key はこの経路全体で opaque な round-trip 値でありどこでもパースされない。
//     行コメント draft key (`draft:<panelId>:<side>:<line>`) との衝突は起こらない:
//     panelId は `^[A-Za-z0-9 _-]*$` で `:` を含まず、仮に panelId が "activity-reply" でも
//     第 3 セグメントが行コメント側は asIs|toBe、本 key 側は group|file|line|review で排他のため。
//   - draft を component state だけにしないのは、返信で thread が resolved → active 群に再分類
//     されるとカードが再 mount され state が消えるため (sessionStorage なら書きかけが生き残る)。

import { useEffect, useRef, useState } from 'react'
import { readDraft, writeDraft, removeDraft } from '../lib/drafts'

export type ThreadReplyFormProps = {
  threadKey: string
  onSubmit: (body: string) => void
}

export function ThreadReplyForm({ threadKey, onSubmit }: ThreadReplyFormProps) {
  const draftKey = `draft:activity-reply:${threadKey}`
  const [body, setBody] = useState<string>(() => readDraft(draftKey))
  // threadKey が変わった再利用 mount で古い body が残らないよう、key 変化時は draft を読み直す
  const prevKeyRef = useRef(draftKey)
  useEffect(() => {
    if (prevKeyRef.current === draftKey) return
    prevKeyRef.current = draftKey
    setBody(readDraft(draftKey))
  }, [draftKey])

  // body 変化時に draft を sessionStorage に保存。空文字なら remove (CommentForm と同じ規約)。
  useEffect(() => {
    if (body === '') removeDraft(draftKey)
    else writeDraft(draftKey, body)
  }, [body, draftKey])

  function submit() {
    const trimmed = body.trim()
    if (!trimmed) return
    onSubmit(trimmed)
    setBody('')
    removeDraft(draftKey)
  }

  return (
    <div className="col-start-2 flex flex-col gap-1.5 mt-2 pt-2.5 border-t border-dashed border-border-soft">
      <textarea
        className="w-full min-h-[48px] resize-none overflow-y-auto field-sizing-content bg-background text-text border border-border rounded-[7px] px-2.5 py-2 font-sans text-xs leading-[1.5] outline-none transition-colors duration-[120ms] focus:border-accent"
        placeholder="スレッドに返信 (Comment で追加、Cmd/Ctrl+Enter)"
        aria-label="Reply to thread"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter で送信 (CommentForm と同じ規約)。
          // Esc は割り当てない: フォームは expand 中常設でキャンセル対象が無く、
          // カード collapse に流用すると誤爆するため。
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
      />
      {/* ボタンは常時表示 + 空のとき disabled (入力時だけ出すと「送る手段がある」こと自体に気付けない) */}
      <button
        type="button"
        className="self-end px-3 py-1.5 border border-border bg-transparent text-text rounded-[7px] cursor-pointer text-xs font-medium font-sans transition-colors duration-[120ms] enabled:hover:bg-surface-2 disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={body.trim() === ''}
        onClick={submit}
        title="コメントをこのスレッドに追加 (Claude への送信は右下の Comment / Submit でまとめて)"
      >
        Comment
      </button>
    </div>
  )
}
