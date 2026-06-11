// Submit Review パネル (v5 で 3 ボタン化)。タブに応じて 2 つの表示形態を持つ。
//
// 設計判断:
//   - **3 ボタン構成 (Approve / Request Changes / Comment)**: GitHub PR review と同じく、review 全体の
//     決定として何を出すかを reviewKind として明示する。
//     * Approve N         : 未判定 group を approved に倒して submit、linear-stack commit ルートへ
//     * Request Changes N : 未判定 group を request-changes に倒して submit、reject ルートへ
//     * Comment           : decision='comment-reply' で送信、Claude が thread に返信して再起動
//   - **1-click submit**: 旧 2-click confirm は撤廃。誤クリック実害は実運用で観測されなかった。
//   - **全体コメント textarea を常時表示**: ボタン押下時に書いた内容を SKILL.md 側に submitNote として
//     送る。
//   - **variant 2 形態**:
//     * floating (Guide / Diff): 右下 floating パネル。コードに被さるためスレッドは折りたたみ可能
//     * sidebar (Activity)    : 右端から slide-in する full-height サイドバー。Activity は会話・
//       レポート面なので会話履歴を主役として広く見せる。普段は右端のハンドルだけ表示してトグル開閉

import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react'
import type { ReviewKind, ThreadSnapshot } from '@show-me/diff-shared'

type Props = {
  approvedCount: number
  rcCount: number
  totalGroups: number
  // v5: reviewKind + fillMode + note を渡す。
  // fillMode: 未判定 group をどちらに倒すか。Comment 時は未指定 (decision は変えない)。
  // reviewKind: review 全体の種別 ('approve' | 'request-changes' | 'comment')。
  onSubmit: (opts?: { fillMode?: 'approved' | 'request-changes'; note?: string; reviewKind?: ReviewKind }) => void
  submitting: boolean
  // レビュー全体スレッド (scope: review)。textarea がこの thread への入力で、
  // 過去の note と Claude の返信が会話履歴としてここに表示される。
  reviewThread?: ThreadSnapshot | null
  // 表示形態。Activity タブでは 'sidebar'、Guide / Diff では 'floating'。
  // App 側でタブ切替時に variant だけが変わり、component は mount されたままなので
  // note draft などの内部 state はタブをまたいで維持される。
  variant: 'floating' | 'sidebar'
  // sidebar の開閉。activity pane の margin (押し出しレイアウト) と連動させるため
  // 状態は App が持ち、ここは表示とトグル発火だけを担う。
  sidebarOpen: boolean
  onSidebarToggle: () => void
}

export function SubmitBar({ approvedCount, rcCount, totalGroups, onSubmit, submitting, reviewThread, variant, sidebarOpen, onSidebarToggle }: Props) {
  const decided = approvedCount + rcCount
  const undecided = totalGroups - decided
  const ready = !submitting
  const allDecided = undecided === 0

  const [note, setNote] = useState('')

  // floating ではスレッドを折りたたみ可能にする: fixed でコードに被さるため、
  // 会話履歴が常時展開だと下のコードが読めなくなる。
  // デフォルトは常に閉: 初期タブが Activity で、新着返信はそこで sidebar が自動オープンして
  // 既読になるため、Guide / Diff に移った時点で floating 側まで開いている必要はない。
  const messages = reviewThread?.messages ?? []
  const hasThread = messages.length > 0
  const lastIsAgent = hasThread && messages[messages.length - 1].author === 'agent'
  const [threadOpen, setThreadOpen] = useState(false)
  // 新着返信で自動オープンしたときだけ最終 message をハイライトする。
  // 一度閉じたら既読とみなし、手動で開き直してもハイライトは再生しない。
  const [highlightLast, setHighlightLast] = useState(() => lastIsAgent)

  const threadScrollRef = useRef<HTMLDivElement>(null)

  // 開いたときは常に最下部 (= 最新 message) を見せる。スレッドの関心は常に最新の
  // やり取りにあるため、開くたびに先頭から読み直させない。
  const threadVisible = variant === 'sidebar' ? sidebarOpen : threadOpen
  useLayoutEffect(() => {
    if (threadVisible && threadScrollRef.current) {
      threadScrollRef.current.scrollTop = threadScrollRef.current.scrollHeight
    }
  }, [threadVisible, variant])

  function toggleThread() {
    if (threadOpen) setHighlightLast(false)
    setThreadOpen(!threadOpen)
  }

  function toggleSidebar() {
    if (sidebarOpen) setHighlightLast(false)
    onSidebarToggle()
  }

  function fire(reviewKind: ReviewKind, fillMode?: 'approved' | 'request-changes') {
    if (!ready) return
    const trimmed = note.trim()
    onSubmit({ fillMode, note: trimmed || undefined, reviewKind })
  }

  // max-[768px]:py-2.5 はタッチターゲットを 44px 級に引き上げるモバイル補正
  const BTN_BASE =
    'px-3 py-1.5 max-[768px]:py-2.5 border rounded-md cursor-pointer text-xs font-semibold font-sans whitespace-nowrap transition-[filter,background] duration-[120ms] enabled:hover:brightness-[1.08] disabled:bg-surface-3 disabled:text-text-dim disabled:cursor-not-allowed disabled:border-border'

  const messageList = messages.map((m, i) => (
    <div
      key={m.id}
      className={`flex flex-col gap-0.5 px-1 -mx-1${
        highlightLast && i === messages.length - 1 ? ' thread-new-message' : ''
      }`}
    >
      <span className={`text-3xs font-semibold tracking-[0.05em] uppercase ${m.author === 'agent' ? 'text-accent' : 'text-text-dim'}`}>
        {m.author === 'agent' ? 'Claude' : 'You'}
      </span>
      <p className="m-0 text-sm leading-[1.55] text-text whitespace-pre-wrap break-words font-sans">{m.body}</p>
    </div>
  ))

  const noteTextarea = (
    <textarea
      value={note}
      onChange={(e) => setNote(e.target.value)}
      placeholder={hasThread
        ? 'スレッドに返信 (送信時に追加されます)'
        : 'レビュー全体へのコメント (送信時にスレッドに追加)'}
      rows={2}
      className="w-full min-h-[44px] resize-none overflow-y-auto field-sizing-content bg-background text-text border border-border rounded-md px-2.5 py-1.5 font-sans text-xs leading-[1.5] outline-none transition-colors duration-100 focus:border-accent"
      aria-label="Review-wide comment"
    />
  )

  // 集計テキスト (n ok · n rc · n undecided) や残数バッジは出さない:
  // 進捗は Guide タブの group 一覧側で見えており、ここでの数字は情報過多だった。
  // 未判定 group の扱いはボタンの tooltip で説明する。
  const buttonRow = (
    <div className="flex items-center justify-end gap-2">
      {/* GitHub PR review と同じ順: Comment → Request Changes → Approve */}
      {/* Comment (neutral): groupDecisions を変えず Claude に返信を促す */}
      <button
        type="button"
        className={`${BTN_BASE} bg-transparent text-text border-border enabled:hover:bg-surface-2`}
        disabled={!ready}
        onClick={() => fire('comment')}
        title="Comment review (Claude が全 open スレッドに自動返信して再起動)"
      >
        Comment
      </button>
      {/* Request Changes (ghost 赤) */}
      <button
        type="button"
        className={`${BTN_BASE} bg-transparent text-del-fg border-[rgba(248,113,113,0.5)] enabled:hover:bg-[rgba(248,113,113,0.12)]`}
        disabled={!ready}
        onClick={() => fire('request-changes', allDecided ? undefined : 'request-changes')}
        title={allDecided ? 'Submit as Request Changes' : `${undecided} undecided を Request Changes として Submit`}
      >
        Request Changes
      </button>
      {/* Approve (primary 緑 solid): group 側の decision ボタン (ghost 緑) と色相を揃える。
          accent (紫) ではなく add-fg 緑にするのは「approve = 緑」の色言語をレビュー UI 全体で統一するため */}
      <button
        type="button"
        className={`${BTN_BASE} bg-add-fg text-background border-border`}
        disabled={!ready}
        onClick={() => fire('approve', allDecided ? undefined : 'approved')}
        title={allDecided ? 'Submit as Approve' : `${undecided} undecided を Approve として Submit`}
      >
        Approve
      </button>
    </div>
  )

  if (variant === 'sidebar') {
    return (
      <>
        {/* 閉時のハンドル: 右端中央に薄く常駐。クリックでサイドバーが slide-in する */}
        {!sidebarOpen ? (
          <button
            type="button"
            onClick={toggleSidebar}
            className="fixed right-0 top-1/2 -translate-y-1/2 z-40 flex items-center justify-center w-[22px] h-[72px] bg-surface border border-r-0 border-border rounded-l-lg cursor-pointer text-text-dim transition-colors duration-[120ms] hover:text-text hover:bg-surface-2"
            title="レビューパネルを開く"
            aria-label="Open review panel"
            aria-expanded={false}
          >
            <ChevronLeft size={14} strokeWidth={1.6} aria-hidden />
          </button>
        ) : null}
        {/* slide-in/out を transform transition で行うため、aside は常時 mount しておく。
            fixed のままだが activity pane 側が mr-[420px] で同期して狭まるので、
            視覚上は「覆い被さる」のではなく「レイアウトを押し出す」開き方になる。
            shadow は意図的に付けない (floating 側と同じ方針)。 */}
        <aside
          className={`fixed top-[46px] right-0 bottom-0 z-40 flex flex-col gap-2 p-3 w-[420px] max-[768px]:w-full bg-surface border-l border-border transition-transform duration-200 ease-out ${
            sidebarOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
          role="complementary"
          aria-label="Submit review"
          aria-hidden={!sidebarOpen}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-2xs font-semibold font-sans text-text-dim tracking-[0.05em] uppercase mr-auto">
              {hasThread ? `Conversation · ${messages.length}` : 'Review'}
            </span>
            <button
              type="button"
              onClick={toggleSidebar}
              className="flex items-center justify-center w-[24px] h-[24px] bg-transparent border-0 rounded-md cursor-pointer text-text-dim transition-colors duration-100 hover:text-text hover:bg-surface-2"
              title="レビューパネルを閉じる"
              aria-label="Close review panel"
            >
              <ChevronRight size={14} strokeWidth={1.6} aria-hidden />
            </button>
          </div>
          {/* sidebar では会話履歴が主役なので折りたたまず flex-1 で広く見せる */}
          {hasThread ? (
            <div
              ref={sidebarOpen ? threadScrollRef : undefined}
              className="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto rounded-md border border-border-soft bg-background px-2.5 py-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
              {messageList}
            </div>
          ) : (
            <div className="flex-1" />
          )}
          {noteTextarea}
          {buttonRow}
        </aside>
      </>
    )
  }

  return (
    // shadow は意図的に付けない: 高輝度モニターで暗色 shadow の halo が滲んで見えるため、
    // 浮遊要素の区切りは border のみで表現する。
    // モバイルでは固定幅 460px が画面をほぼ覆い尽くすため、左右 12px の全幅 bottom sheet に切り替える
    <div
      className="fixed bottom-6 right-6 z-40 flex flex-col gap-2 p-3 w-[460px] max-[768px]:left-3 max-[768px]:right-3 max-[768px]:bottom-3 max-[768px]:w-auto bg-surface border border-border rounded-xl"
      role="toolbar"
      aria-label="Submit review"
    >
      {/* レビュー全体スレッドの会話履歴 (過去の note + Claude の返信)。
          group / file の会話欄と同じ全文表示。スレッドが無ければ非表示。 */}
      {hasThread ? (
        <button
          type="button"
          onClick={toggleThread}
          className="flex items-center gap-1.5 w-full px-1 py-0.5 bg-transparent border-0 rounded-md cursor-pointer text-2xs font-sans text-text-dim transition-colors duration-100 hover:text-text"
          aria-expanded={threadOpen}
          title={threadOpen ? 'スレッドを折りたたむ' : 'スレッドを展開する'}
        >
          <span className="mr-auto">Conversation · {messages.length}</span>
          {threadOpen
            ? <ChevronDown size={13} strokeWidth={1.6} aria-hidden />
            : <ChevronUp size={13} strokeWidth={1.6} aria-hidden />}
        </button>
      ) : null}
      {hasThread && threadOpen ? (
        <div
          ref={threadScrollRef}
          className="flex flex-col gap-3 max-h-[40vh] overflow-y-auto rounded-md border border-border-soft bg-background px-2.5 py-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          {messageList}
        </div>
      ) : null}
      {noteTextarea}
      {buttonRow}
    </div>
  )
}
