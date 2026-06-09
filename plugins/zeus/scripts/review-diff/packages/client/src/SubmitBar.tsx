// 右下 floating Submit Review バー。
//
// 設計判断 (v4.13.0):
//   - **1-click submit**: 旧 2-click confirm は誤クリック保護として入れていたが、ユーザーは
//     ボタンが目立つ場所 (fixed bottom-right) にあると認識しており、誤クリック実害は実運用で
//     観測されなかった。手数を減らすため即時 submit に倒す。
//   - **全 group decision 未確定でも submit 可能**: 「動作確認だけして OK」のような light レビューを
//     許容する。未判定 group は SKILL.md 側で「判定無しは undecided として扱う」(commit 対象外)。
//     summary に "N decided / M total" を出して状態は見せ続ける。
//   - サマリ表示で「何を submit しようとしているか」が一目で分かるよう (approved / RC / 未判定 の内訳)
//     見せ続ける。

type Props = {
  approvedCount: number
  rcCount: number
  totalGroups: number
  onSubmit: () => void
  submitting: boolean
}

export function SubmitBar({ approvedCount, rcCount, totalGroups, onSubmit, submitting }: Props) {
  const decided = approvedCount + rcCount
  const undecided = totalGroups - decided
  // submitting 中のみ disable。decision 全確定は要求しない (light レビューを許容する設計)。
  const ready = !submitting

  const summary = undecided === 0
    ? `${approvedCount} approved · ${rcCount} request-changes`
    : `${approvedCount} approved · ${rcCount} RC · ${undecided} undecided`

  return (
    <div
      className="fixed bottom-6 right-6 z-40 flex items-center gap-3 px-3.5 py-2.5 bg-surface border border-border rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.3)]"
      role="toolbar"
      aria-label="Submit review"
    >
      <span className="text-[11px] text-text-muted font-mono tabular-nums">{summary}</span>
      <button
        type="button"
        className="px-4 py-2 border border-border bg-accent text-background rounded-lg cursor-pointer text-[12.5px] font-semibold font-sans tracking-[0.01em] transition-[filter,background] duration-[120ms] enabled:hover:brightness-[1.08] disabled:bg-surface-3 disabled:text-text-dim disabled:cursor-not-allowed"
        disabled={!ready}
        onClick={() => { if (ready) onSubmit() }}
        title={ready ? 'Submit review' : 'Submitting...'}
      >
        Submit Review
      </button>
    </div>
  )
}
