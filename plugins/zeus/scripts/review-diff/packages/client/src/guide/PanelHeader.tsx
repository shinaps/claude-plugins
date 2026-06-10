// Panel の上部に出るヘッダ。
//   - intent (太字)
//   - asIs.file → toBe.file (片側だけなら片側、cross-file なら矢印で並べる)
//   - ファイルコメントボタン (onAddFileComment が渡された場合): 行ではなくファイル全体への
//     指摘 (設計方針・命名・分割など) を file scope thread として pending に積む
//   - onCollapse / onExpand のどちらかが渡されたら右端にボタンを表示。
//       - 通常表示 (expanded) では onCollapse → chevron up アイコン (Hide)
//       - collapsed 状態では onExpand + totalRowsHint → "Show N rows" ボタン
//     どちらの状態でも panel タイトル + ファイル名は維持され、行数は Show diff ボタンに集約。

import { useState } from 'react'
import { ChevronUp, ChevronDown, MessageSquare } from 'lucide-react'
import type { RenderedPanel, ThreadSnapshot } from '@zeus/review-diff-shared'

// ファイル単位コメントの handler 束。App が threads state と addFileComment を束ねて
// PanelBlock → Panel → PanelHeader へ 1 prop で drill する。
export type FileCommentHandlers = {
  getThread: (file: string) => ThreadSnapshot | null
  onAdd: (file: string, body: string) => void
}

export type PanelHeaderProps = {
  panel: RenderedPanel
  // 通常状態 (expanded) で渡される: chevron up の Hide ボタンを表示
  onCollapse?: () => void
  // collapsed 状態で渡される: 行数付き Show diff ボタンを表示
  onExpand?: () => void
  totalRowsHint?: number
  // ファイル単位コメント (pending thread 方式)。渡されない呼び出し元 (dev mock 等) ではボタン非表示。
  fileComments?: FileCommentHandlers
}

export function PanelHeader({ panel, onCollapse, onExpand, totalRowsHint, fileComments }: PanelHeaderProps) {
  const asIsFile = panel.asIs?.file
  const toBeFile = panel.toBe?.file
  // コメント対象は「変更後の姿」を優先 (rename なら新 path に紐づける方が後続レビューで追いやすい)
  const commentFile = toBeFile ?? asIsFile
  const fileThread = commentFile ? fileComments?.getThread(commentFile) ?? null : null
  const messageCount = fileThread?.messages.length ?? 0
  // 会話が既にあるならフォームを初期表示で開く (comment-reply 復帰時に返信へ気付けるように)
  const [formOpen, setFormOpen] = useState(() => messageCount > 0)
  const [draft, setDraft] = useState('')

  function submitDraft() {
    const body = draft.trim()
    if (!body || !commentFile || !fileComments) return
    fileComments.onAdd(commentFile, body)
    setDraft('')
  }

  return (
    // panel-header BEM 維持: 祖先 .panel-block 内で `position: sticky; top: 46px` させる規則が globals.css
    // にあり (panel ごとに自身のヘッダが viewport 上端に貼り付く挙動)。utility だけだと panel-block の
    // collapsed 用 border-bottom 解除も別途必要になるため scope を残す。
    // ファイルコメント form は header 内の縦展開 (sticky のままフォームが見え続ける)。
    <div
      className="panel-header flex flex-col px-3.5 py-2.5 bg-surface-2 border-b border-border-soft text-xs"
      data-panel-id={panel.panelId}
    >
      <div className="flex justify-between items-center gap-3">
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <div className="text-sm font-semibold text-text font-sans">{panel.intent}</div>
          <div className="flex items-center gap-1.5 text-2xs text-text-dim font-mono">
            {asIsFile && toBeFile && asIsFile !== toBeFile ? (
              <>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-del-fg">{asIsFile}</span>
                <span className="text-text-dim opacity-70" aria-hidden>→</span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-add-fg">{toBeFile}</span>
              </>
            ) : (
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{toBeFile ?? asIsFile ?? '(no file)'}</span>
            )}
          </div>
        </div>
        {fileComments && commentFile ? (
          <button
            type="button"
            className={`relative bg-transparent border border-border-soft w-[26px] h-[26px] rounded-[5px] inline-flex items-center justify-center cursor-pointer p-0 shrink-0 transition-colors duration-[120ms] hover:bg-surface-3 hover:text-text hover:border-border ${formOpen || messageCount > 0 ? 'text-text' : 'text-text-dim'}`}
            onClick={() => setFormOpen(o => !o)}
            aria-expanded={formOpen}
            aria-label="Comment on this file"
            title={`このファイル全体にコメント (${commentFile})`}
          >
            <MessageSquare size={14} strokeWidth={1.5} aria-hidden />
            {messageCount > 0 ? (
              <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-accent text-background text-3xs font-semibold inline-flex items-center justify-center leading-none">
                {messageCount}
              </span>
            ) : null}
          </button>
        ) : null}
        {onExpand ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-surface border border-border text-text-dim rounded-[5px] cursor-pointer font-sans text-xs font-medium shrink-0 transition-colors duration-[120ms] hover:bg-surface-3 hover:text-text hover:border-border"
            onClick={onExpand}
            title="Show diff"
            aria-label="Show this panel's diff"
          >
            {typeof totalRowsHint === 'number' ? (
              <span className="font-mono tabular-nums text-text-dim mr-0.5">{totalRowsHint.toLocaleString()} rows</span>
            ) : null}
            <span>Show diff</span>
            <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
          </button>
        ) : null}
        {onCollapse ? (
          <button
            type="button"
            className="bg-transparent border border-border-soft text-text-dim w-[26px] h-[26px] rounded-[5px] inline-flex items-center justify-center cursor-pointer p-0 shrink-0 transition-colors duration-[120ms] hover:bg-surface-3 hover:text-text hover:border-border"
            onClick={onCollapse}
            title="Hide diff"
            aria-label="Hide this panel"
          >
            <ChevronUp size={14} strokeWidth={1.5} aria-hidden />
          </button>
        ) : null}
      </div>
      {formOpen && fileComments && commentFile ? (
        <div className="flex flex-col gap-1.5 mt-2.5 pt-2.5 border-t border-border-soft">
          {fileThread && fileThread.messages.length > 0 ? (
            /* 高さ制限なしの全文表示 (group スレッドの会話欄と同じ方針) */
            <div className="flex flex-col gap-3 rounded-[7px] border border-border-soft bg-surface px-2.5 py-2">
              {/* 最後の message が Claude の返信なら新着としてパルスで注目喚起する (review スレッドと同じ視覚言語) */}
              {fileThread.messages.map((m, i) => (
                <div
                  key={m.id}
                  className={`flex flex-col gap-0.5 px-1 -mx-1${
                    m.author === 'agent' && i === fileThread.messages.length - 1 ? ' thread-new-message' : ''
                  }`}
                >
                  <span className={`text-3xs font-semibold tracking-[0.05em] uppercase ${m.author === 'agent' ? 'text-accent' : 'text-text-dim'}`}>
                    {m.author === 'agent' ? 'Claude' : 'You'}
                  </span>
                  <p className="m-0 text-sm leading-[1.55] text-text whitespace-pre-wrap break-words font-sans">{m.body}</p>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            className="w-full min-h-[48px] resize-none overflow-y-auto field-sizing-content bg-background text-text border border-border rounded-[7px] px-2.5 py-2 font-sans text-xs leading-[1.5] outline-none transition-colors duration-[120ms] focus:border-accent"
            placeholder={`${commentFile} 全体へのコメント (Comment でスレッドに追加)`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter で送信、Esc で閉じる (CommentForm と同じ規約)
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitDraft()
              if (e.key === 'Escape') setFormOpen(false)
            }}
          />
          <button
            type="button"
            className="self-end px-3 py-1.5 border border-border bg-transparent text-text rounded-[7px] cursor-pointer text-xs font-medium font-sans transition-colors duration-[120ms] enabled:hover:bg-surface-2 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={draft.trim() === ''}
            onClick={submitDraft}
            title="コメントをこのファイルのスレッドに追加 (Claude への送信は右下の Comment / Submit でまとめて)"
          >
            Comment
          </button>
        </div>
      ) : null}
    </div>
  )
}
