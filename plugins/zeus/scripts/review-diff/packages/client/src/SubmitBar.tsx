// 右下 floating Submit Review バー。
//
// 設計判断:
//   - **未判定がある時は 2 ボタン (Reject / Approve)**: 未判定のまま submit すると「動作確認 OK で
//     commit ゼロ」になるので、ユーザーが「approve として送ったのか reject として送ったのか」を
//     SKILL.md 側に伝えるために意思を明示させる。
//   - **全 group 判定済みなら 1 ボタン (Submit Review)**: 既に意思は明示されているので fillMode 不要。
//   - **1-click submit**: 旧 2-click confirm は撤廃。誤クリック実害は実運用で観測されなかった。
//   - **全体コメント textarea を常時表示**: ボタン押下時に書いた内容を SKILL.md 側に submitNote として
//     送る。「commit メッセージにこれを含めて」「全体的にこういう方向で見てほしい」等の自由文。
//   - **レイアウト**: 縦組み (textarea / summary + ボタン行)、幅は w-[400px] 固定で button 改行を防ぐ。
//     ボタンラベルは数字付きの短いラベル (Reject 6 / Approve 6) + tooltip で詳細補足。

import { useState } from 'react'

type Props = {
  approvedCount: number
  rcCount: number
  totalGroups: number
  // fillMode: 未判定 group をどちらに倒して submit するか。指定なしなら未判定はそのまま (null 落とし)。
  // note: 全体コメント (空文字なら省略)。SKILL.md 側で commit メッセージ生成等に活用。
  onSubmit: (opts?: { fillMode?: 'approved' | 'request-changes'; note?: string }) => void
  submitting: boolean
}

export function SubmitBar({ approvedCount, rcCount, totalGroups, onSubmit, submitting }: Props) {
  const decided = approvedCount + rcCount
  const undecided = totalGroups - decided
  const ready = !submitting
  const allDecided = undecided === 0

  // 全体コメント (submit に乗せる free-form text)。空文字なら送信時に省略される。
  const [note, setNote] = useState('')
  function fire(fillMode?: 'approved' | 'request-changes') {
    if (!ready) return
    const trimmed = note.trim()
    onSubmit({ fillMode, note: trimmed || undefined })
  }

  const summary = allDecided
    ? `${approvedCount} approved · ${rcCount} request-changes`
    : `${approvedCount} ok · ${rcCount} rc · ${undecided} undecided`

  // ボタン共通: 高さを揃えて改行されにくいよう padding を抑える + whitespace-nowrap で折り返し防止
  const BTN_BASE =
    'px-3 py-1.5 border rounded-md cursor-pointer text-xs font-semibold font-sans whitespace-nowrap transition-[filter,background] duration-[120ms] enabled:hover:brightness-[1.08] disabled:bg-surface-3 disabled:text-text-dim disabled:cursor-not-allowed disabled:border-border'

  return (
    // 縦組み: 上 textarea / 下 summary + buttons。w-[400px] でボタン折り返しを防ぐ。
    <div
      className="fixed bottom-6 right-6 z-40 flex flex-col gap-2 p-3 w-[400px] bg-surface border border-border rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.3)]"
      role="toolbar"
      aria-label="Submit review"
    >
      {/* field-sizing: content (Chrome 123+) で content 量に合わせて auto-resize、対応ブラウザでは scrollbar 出ず。
          overflow-y-auto は Safari/Firefox 非対応時の fallback (伸びないが scrollbar で読める)。
          長文ノートを書いても floating bar 全体が下から伸びる形に。 */}
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Submit に添える全体コメント (任意)"
        rows={2}
        className="w-full min-h-[44px] resize-none overflow-y-auto field-sizing-content bg-background text-text border border-border rounded-md px-2.5 py-1.5 font-sans text-xs leading-[1.5] outline-none transition-colors duration-100 focus:border-accent"
        aria-label="Optional submit note"
      />
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-text-muted font-mono tabular-nums truncate mr-auto" title={summary}>
          {summary}
        </span>
        {allDecided ? (
          <button
            type="button"
            className={`${BTN_BASE} bg-accent text-background border-border`}
            disabled={!ready}
            onClick={() => fire()}
            title={ready ? 'Submit review' : 'Submitting...'}
          >
            Submit Review
          </button>
        ) : (
          <>
            {/* Reject (ghost 赤): 未判定を全て request-changes に倒して submit */}
            <button
              type="button"
              className={`${BTN_BASE} bg-transparent text-del-fg border-[rgba(248,113,113,0.5)] enabled:hover:bg-[rgba(248,113,113,0.12)]`}
              disabled={!ready}
              onClick={() => fire('request-changes')}
              title={`${undecided} undecided group(s) を Request Changes として Submit`}
            >
              Reject {undecided}
            </button>
            {/* Approve (primary 緑系 accent): 未判定を全て approved に倒して submit */}
            <button
              type="button"
              className={`${BTN_BASE} bg-accent text-background border-border`}
              disabled={!ready}
              onClick={() => fire('approved')}
              title={`${undecided} undecided group(s) を Approve として Submit`}
            >
              Approve {undecided}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
