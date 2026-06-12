// 行コメントスレッドの表示 (CommentRow / SavedComment) と anchor key ヘルパー。
// SplitBody (Panel.tsx) と UnifiedBody の両方がコメント表示を共有するため、
// Panel.tsx から独立させている (Panel → UnifiedBody → Panel の循環 import 回避)。

import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { RenderedPanel, Side, ThreadSnapshot } from '@show-me/diff-shared'
import { sideToAttr } from '@show-me/diff-shared'
import { parseLineCommentKey } from '../lib/state'
import { CommentForm } from './CommentForm'
import type { LineCommentHandlers } from './useLineComments'

// v5: line scope の lineCommentKey から threadKey (= "line:<panelId>:<side>:<line>[:<endLine>]") を作る。
// payload.initialThreads の key と一致する形式。
export function lineKeyToThreadKey(panelId: string, side: 'asIs' | 'toBe', line: number, endLine?: number): string {
  const range = endLine != null && endLine !== line ? `${line}:${endLine}` : `${line}`
  return `line:${panelId}:${side}:${range}`
}

// (side, anchor) → コメント key 配列の逆引き Map のキー。
// producer (buildCommentKeysByAnchor) と consumer (SideRow / UnifiedBody の lookup) が同じ形式で
// 組む必要があるため関数に固定する。anchor は range コメントなら終端行 (= CommentRow を出す行)。
export function anchorMapKey(side: Side, anchor: number): string {
  return `${side}\x1f${anchor}`
}

// map[mapKey] の配列に commentKey を重複なしで追記する。
export function appendCommentKey(map: Map<string, string[]>, mapKey: string, commentKey: string): void {
  const commentKeys = map.get(mapKey) ?? []
  if (!commentKeys.includes(commentKey)) {
    commentKeys.push(commentKey)
    map.set(mapKey, commentKeys)
  }
}

export function sortAnchorKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const pa = parseLineCommentKey(a)
    const pb = parseLineCommentKey(b)
    const ra = pa.endNumber != null ? 0 : 1
    const rb = pb.endNumber != null ? 0 : 1
    if (ra !== rb) return ra - rb
    return pa.number - pb.number
  })
}

export function CommentRow({
  lineKey, panel, handlers,
}: {
  lineKey: string
  panel: RenderedPanel
  handlers: LineCommentHandlers
}): React.ReactElement | null {
  const parsed = parseLineCommentKey(lineKey)
  const savedList = handlers.lineComments.get(lineKey)
  const hasSaved = !!savedList && savedList.length > 0
  const formOpen = handlers.activeForm === lineKey
  // v5: 永続化された thread (= 前回 submit + Claude 応答) を取得して全 message を時系列で表示する
  const threadKey = lineKeyToThreadKey(panel.panelId, parsed.side, parsed.number, parsed.endNumber)
  const persistedThread = (typeof window !== 'undefined' ? window.__reviewDiffThreads : undefined)?.[threadKey]
  const persistedMessages = persistedThread?.messages ?? []
  const hasPersisted = persistedMessages.length > 0

  // Guide / Diff タブが同時 mount されるため、lineKey 由来の固定 id だと document 内で重複する
  const bodyId = useId()
  // 復元時の自動初期値: 最新の persisted message が user (= 自分が書いて返答待ち) の行は
  // ノイズなので閉じ、agent の返答が付いた行は読む必要があるので開く。
  // savedList 非空なら無条件で開く: タブ初訪問や表示モード切替の再 mount で、本セッション中に
  // 書いたばかりの pending コメントが閉じて見えるのを防ぐ。close-relaunch 復元時は pending が
  // thread へ合成済みで savedList は常に空なので、この条件が復元時の判定を変えることはない。
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    !hasSaved &&
    persistedMessages.length > 0 &&
    persistedMessages[persistedMessages.length - 1].author === 'user',
  )
  // 折りたたみ中の行で入力 (+ trigger) が始まったら state も展開へ倒す。derived 値ではなく
  // state を書き換えるのは、保存でフォームが閉じた後もスレッドを開いたままにするため。
  useEffect(() => {
    if (formOpen) setCollapsed(false)
  }, [formOpen])

  if (!hasSaved && !formOpen && !hasPersisted) return null

  const label =
    parsed.endNumber != null && parsed.endNumber !== parsed.number
      ? `行 ${parsed.number}-${parsed.endNumber}`
      : `行 ${parsed.number}`

  const messageCount = persistedMessages.length + (savedList?.length ?? 0)
  // メッセージが 1 件も無い (フォームだけ開いた直後の) 行に折りたたみは意味が無いので
  // トグルを出さず従来の label のみ表示する
  const collapsible = messageCount > 0
  // formOpen 中は collapsed state の値によらず body を出す: useEffect での展開は paint 後の
  // ため、条件に入れないと + クリック直後にフォームの無いヘッダだけが 1 frame 見える
  const bodyVisible = !collapsed || formOpen

  // word-wrap (overflow-wrap: anywhere) で panel 幅を超える長文 message を強制改行する。
  // 親の comment-row は width calc で固定 (CSS)、その中の messages を breakable に。
  // overflow-hidden + min-w-0 + max-w-full で「panel-side の overflow-x: auto に flex item が
  // 横スクロールを生まないよう」固定する (CommentForm の textarea や長文 message が起点だった)。
  const thread = (
    <div
      className="flex flex-col gap-2 pl-14 pr-4 py-2.5 font-sans text-sm leading-[1.5] min-w-0 max-w-full overflow-hidden"
      data-side={sideToAttr(parsed.side)}
    >
      {collapsible ? (
        <button
          type="button"
          className="flex items-center gap-2 w-full text-left bg-transparent border-0 p-0 min-h-6 pointer-coarse:min-h-11 cursor-pointer text-text-dim hover:text-text transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-accent-soft focus-visible:outline-offset-1"
          aria-expanded={bodyVisible}
          aria-controls={bodyId}
          onClick={() => {
            // formOpen 中は body が強制表示されるため、collapsed だけ反転すると見た目と
            // state が乖離し、フォームを閉じた瞬間に行が折りたたまれる。入力中は no-op にする
            if (formOpen) return
            setCollapsed((c) => !c)
          }}
        >
          {bodyVisible
            ? <ChevronUp className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
            : <ChevronDown className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />}
          <span className="font-mono text-2xs tracking-[0.04em] uppercase">{label}</span>
          <span className="font-mono text-2xs">{messageCount} {messageCount === 1 ? 'msg' : 'msgs'}</span>
          <span className="sr-only">{bodyVisible ? 'Collapse comment thread' : 'Expand comment thread'}</span>
        </button>
      ) : (
        <div className="font-mono text-2xs text-text-dim tracking-[0.04em] uppercase">{label}</div>
      )}
      {bodyVisible ? (
        <div id={bodyId} className="flex flex-col gap-2">
        {/* v5: persistedMessages を user / agent 別バブルで時系列順に表示 */}
        {persistedMessages.map((msg) => (
          <div
            key={msg.id}
            className={
              msg.author === 'agent'
                ? 'thread-message thread-message-agent border-l-[3px] border-accent bg-surface-2 rounded-r-md px-3 py-2 min-w-0 max-w-full [overflow-wrap:anywhere] [word-break:break-word]'
                : 'thread-message thread-message-user border-l-[3px] border-border bg-surface rounded-r-md px-3 py-2 min-w-0 max-w-full [overflow-wrap:anywhere] [word-break:break-word]'
            }
          >
            <div className="text-3xs uppercase tracking-wider text-text-dim mb-1">
              {msg.author === 'agent' ? 'Claude' : 'You'}
            </div>
            <div className="whitespace-pre-wrap">{msg.body}</div>
          </div>
        ))}
        {/* 本セッションで追加された saved comments (= 次の submit に乗る draft) */}
        {savedList?.map((body, i) => (
          <SavedComment
            key={`${lineKey}-${i}`}
            lineKey={lineKey}
            index={i}
            body={body}
            editingBody={handlers.editing.get(`${lineKey}#${i}`)}
            onStartEdit={handlers.onStartEditLineComment}
            onCancelEdit={handlers.onCancelEditLineComment}
            onSaveEdit={handlers.onSaveEditLineComment}
            onDelete={handlers.onDeleteLineComment}
          />
        ))}
        {formOpen ? (
          <CommentForm
            panelId={panel.panelId}
            side={parsed.side}
            number={parsed.number}
            endNumber={parsed.endNumber}
            onSave={(body) =>
              handlers.onAddLineComment(
                panel.panelId,
                { side: parsed.side, number: parsed.number, endNumber: parsed.endNumber },
                body,
              )
            }
            onCancel={handlers.onCloseLineForm}
          />
        ) : null}
        {/* v5: 既存スレッドがあるが入力欄が閉じている場合、Reply ボタンを 1 つ置く (= 自然に返信を続けられる) */}
        {hasPersisted && !formOpen ? (
          <button
            type="button"
            className="self-start mt-1 px-2.5 py-1 text-xs text-text-muted border border-border rounded-md hover:bg-surface-2 cursor-pointer"
            onClick={() => handlers.onOpenLineForm(panel.panelId, { side: parsed.side, number: parsed.number, endNumber: parsed.endNumber })}
          >
            Reply
          </button>
        ) : null}
        </div>
      ) : null}
    </div>
  )

  // in-flow (= code-row 直後の通常フロー) で描画する。縦方向はコードと一体でスクロールし、
  // 行間に高さも確保される (= コードに「埋め込まれた」見え方)。
  // 横方向は transform: translateX(var(--ps-scroll-x)) で panel-side の visible 左端に固定
  // (globals.css .comment-row、変数は Panel / UnifiedBody の横スクロールハンドラが panel-side に書く)。
  // position: fixed + portal にしない理由: フローから抜けるとコメントが行間に空間を確保できず
  // 下の行に被さる上、スクロール追従が rAF 1 frame 遅れて「ふわふわ浮いて見える」ため。
  return (
    <div className="comment-row" data-comment-side={sideToAttr(parsed.side)}>
      <div className="p-0">{thread}</div>
    </div>
  )
}

function SavedComment({
  lineKey, index, body, editingBody,
  onStartEdit, onCancelEdit, onSaveEdit, onDelete,
}: {
  lineKey: string
  index: number
  body: string
  editingBody: string | undefined
  onStartEdit: (key: string, index: number, body: string) => void
  onCancelEdit: (key: string, index: number) => void
  onSaveEdit: (key: string, index: number, body: string) => void
  onDelete: (key: string, index: number) => void
}) {
  const isEditing = editingBody !== undefined
  const [draft, setDraft] = useState(editingBody ?? body)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (isEditing) {
      setDraft(editingBody ?? body)
      ref.current?.focus()
    }
  }, [isEditing, editingBody, body])

  // comment-bubble / is-editing / comment-actions は DOM 上でコメント要素と状態を識別するための
  // semantic class (テスト・devtools の selector 用。globals.css に対応 rule は無い)。
  if (isEditing) {
    return (
      <div className="comment-bubble is-editing bg-surface border border-border-soft rounded-lg px-3 py-2.5 text-text text-sm leading-normal">
        <textarea
          ref={ref}
          className="w-full min-h-[70px] resize-none overflow-y-auto field-sizing-content bg-background text-text border border-border rounded-md px-2.5 py-2 font-sans text-sm leading-[1.5] outline-none transition-colors duration-100 focus:border-accent"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              onSaveEdit(lineKey, index, draft)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancelEdit(lineKey, index)
            }
          }}
        />
        <div className="flex justify-end gap-1.5 mt-2">
          <button
            type="button"
            className="px-3 py-1 border border-border rounded-md text-xs font-medium font-sans cursor-pointer bg-transparent text-text-muted hover:bg-surface-3 hover:text-text transition-colors duration-100"
            onClick={() => onCancelEdit(lineKey, index)}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="px-3 py-1 border border-accent bg-accent rounded-md text-xs font-medium font-sans cursor-pointer text-white hover:brightness-[1.08] transition-[filter,background] duration-100"
            onClick={() => onSaveEdit(lineKey, index, draft)}
          >
            保存
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="comment-bubble bg-surface border border-border-soft rounded-lg px-4 py-3 text-text text-sm leading-normal">
      <div className="flex items-start gap-2">
        <div className="whitespace-pre-wrap break-words flex-1 min-w-0">{body}</div>
        {/* 編集・削除は常時表示: remote レビュー (モバイル) には hover が無く、hover で
            出すボタンは存在自体に気付けない (発見性)。overlay (absolute) にしない理由:
            常時可視のボタンが本文 1 行目に被るのを避け、flex で本文と領域を分離する。 */}
        <div className="comment-actions flex gap-1 shrink-0">
          <button
            type="button"
            className="bg-transparent border border-border text-text-muted text-2xs px-2 py-0.5 rounded-[5px] cursor-pointer font-sans transition-colors duration-100 hover:bg-surface-3 hover:text-text"
            onClick={() => onStartEdit(lineKey, index, body)}
          >
            編集
          </button>
          <button
            type="button"
            className="bg-transparent border border-border text-text-muted text-2xs px-2 py-0.5 rounded-[5px] cursor-pointer font-sans transition-colors duration-100 hover:text-danger hover:border-[rgba(248,113,113,0.4)]"
            onClick={() => {
              if (confirm('このコメントを削除しますか？')) onDelete(lineKey, index)
            }}
          >
            削除
          </button>
        </div>
      </div>
    </div>
  )
}
