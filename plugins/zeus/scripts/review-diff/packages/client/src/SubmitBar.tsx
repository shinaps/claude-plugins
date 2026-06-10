// 右下 floating Submit Review バー (v5 で 3 ボタン化)。
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
//   - **レイアウト**: 縦組み (textarea / summary + ボタン行)、幅は w-[460px] に広げて 3 ボタン収納。

import { useState } from 'react'
import type { ReviewKind, ThreadSnapshot } from '@zeus/review-diff-shared'

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
}

export function SubmitBar({ approvedCount, rcCount, totalGroups, onSubmit, submitting, reviewThread }: Props) {
  const decided = approvedCount + rcCount
  const undecided = totalGroups - decided
  const ready = !submitting
  const allDecided = undecided === 0

  const [note, setNote] = useState('')

  function fire(reviewKind: ReviewKind, fillMode?: 'approved' | 'request-changes') {
    if (!ready) return
    const trimmed = note.trim()
    onSubmit({ fillMode, note: trimmed || undefined, reviewKind })
  }

  const summary = allDecided
    ? `${approvedCount} approved · ${rcCount} request-changes`
    : `${approvedCount} ok · ${rcCount} rc · ${undecided} undecided`

  const BTN_BASE =
    'px-3 py-1.5 border rounded-md cursor-pointer text-xs font-semibold font-sans whitespace-nowrap transition-[filter,background] duration-[120ms] enabled:hover:brightness-[1.08] disabled:bg-surface-3 disabled:text-text-dim disabled:cursor-not-allowed disabled:border-border'

  // 未判定があるときの Approve / Request Changes は fillMode を渡す。Comment は fillMode なし。
  const rcLabel = allDecided ? 'Request Changes' : `Request Changes ${undecided}`
  const approveLabel = allDecided ? 'Approve' : `Approve ${undecided}`

  return (
    <div
      className="fixed bottom-6 right-6 z-40 flex flex-col gap-2 p-3 w-[460px] bg-surface border border-border rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.3)]"
      role="toolbar"
      aria-label="Submit review"
    >
      {/* レビュー全体スレッドの会話履歴 (過去の note + Claude の返信)。
          group / file の会話欄と同じ全文表示。スレッドが無ければ非表示。 */}
      {reviewThread && reviewThread.messages.length > 0 ? (
        <div className="flex flex-col gap-1.5 max-h-[40vh] overflow-y-auto rounded-md border border-border-soft bg-background px-2.5 py-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {reviewThread.messages.map((m) => (
            <div key={m.id} className="flex flex-col gap-0.5">
              <span className={`text-[10px] font-semibold tracking-[0.05em] uppercase ${m.author === 'agent' ? 'text-accent' : 'text-text-dim'}`}>
                {m.author === 'agent' ? 'Claude' : 'You'}
              </span>
              <p className="m-0 text-xs leading-[1.55] text-text whitespace-pre-wrap break-words font-sans">{m.body}</p>
            </div>
          ))}
        </div>
      ) : null}
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={reviewThread && reviewThread.messages.length > 0
          ? 'スレッドに返信 (送信時に追加されます)'
          : 'レビュー全体へのコメント (送信時にスレッドに追加)'}
        rows={2}
        className="w-full min-h-[44px] resize-none overflow-y-auto field-sizing-content bg-background text-text border border-border rounded-md px-2.5 py-1.5 font-sans text-xs leading-[1.5] outline-none transition-colors duration-100 focus:border-accent"
        aria-label="Review-wide comment"
      />
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-text-muted font-mono tabular-nums truncate mr-auto" title={summary}>
          {summary}
        </span>
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
          {rcLabel}
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
          {approveLabel}
        </button>
      </div>
    </div>
  )
}
