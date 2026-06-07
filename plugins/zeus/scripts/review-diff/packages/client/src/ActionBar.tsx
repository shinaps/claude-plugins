// 右下の floating action bar (v4.7.0 panel model)。
// Mark all / Approve / Reject + 進捗カウンタ (panel 単位)。
// 二重送信防止と confirm ダイアログは App 側に集中させ、ここはコールバックを叩くだけにする。

type Props = {
  reviewedCount: number
  totalPanels: number
  onMarkAll: () => void
  onApprove: () => void
  onReject: () => void
}

export function ActionBar({ reviewedCount, totalPanels, onMarkAll, onApprove, onReject }: Props) {
  return (
    <div className="action-bar" role="toolbar" aria-label="Review actions">
      <span className="progress">
        {reviewedCount} / {totalPanels} reviewed
      </span>
      <button type="button" className="btn" onClick={onMarkAll}>
        Mark all reviewed
      </button>
      <button type="button" className="btn btn-reject" onClick={onReject}>
        Reject
      </button>
      <button type="button" className="btn btn-approve" onClick={onApprove}>
        Approve
      </button>
    </div>
  )
}
