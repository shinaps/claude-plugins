// 右下 floating Submit Review バー (v4.12.0)。
//
// 設計判断:
//   - SubmitModal を廃止し、Submit ボタンの 2-click confirm パターンで誤クリック保護を入れる
//     (GitHub の "Confirm sign off" と同じ語彙)。1 回目クリックでラベルが "Click again to confirm"
//     に変わり、2 秒経過で元に戻る。2 回連続クリックで実 submit。
//   - 全 group decision が確定するまで disabled。残り group 数を tooltip に出すことで「あと何やれば
//     いいか」が明示される。
//   - ボタン上のサマリ表示 (N approved, M request-changes) で confirm banner の役割を果たす
//     (モーダル要らずの中庸案)。

import { useCallback, useEffect, useState } from 'react'

type Props = {
  approvedCount: number
  rcCount: number
  totalGroups: number
  onSubmit: () => void
  submitting: boolean
}

export function SubmitBar({ approvedCount, rcCount, totalGroups, onSubmit, submitting }: Props) {
  const [confirming, setConfirming] = useState(false)
  const decided = approvedCount + rcCount
  const ready = decided === totalGroups && !submitting

  // 1 回目のクリック後 2 秒で confirming 状態を自動解除 (誤クリック保護)。
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 2000)
    return () => clearTimeout(t)
  }, [confirming])

  // fetch error 等で submitting→null 復帰した時に、confirming=true がそのまま残ると
  // 次の 1 クリックで即 submit が走る (誤クリック保護が破れる)。submitting が立ったら必ずリセット。
  useEffect(() => {
    if (submitting) setConfirming(false)
  }, [submitting])

  const handleClick = useCallback(() => {
    if (!ready) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    // 2 段目クリック発火と同時に confirming を倒すことで、submit が fetch error で空振った場合に
    // 再クリックでも「1 段目 → 2 段目」を確実に経由させる (誤クリック保護が空振り時も持続)。
    // submitting=true への状態遷移を待つ方法だと、App 側の submit() が catch で submitted を
    // 立てない設計のため、submitting prop は false のままになり useEffect が発火しない罠がある。
    setConfirming(false)
    onSubmit()
  }, [ready, confirming, onSubmit])

  const summary = ready
    ? `${approvedCount} approved · ${rcCount} request-changes`
    : `${decided} / ${totalGroups} groups decided`

  return (
    <div className="submit-bar" role="toolbar" aria-label="Submit review">
      <span className="submit-bar-summary">{summary}</span>
      <button
        type="button"
        className={`btn-submit${confirming ? ' is-confirming' : ''}`}
        disabled={!ready}
        onClick={handleClick}
        title={
          ready
            ? confirming
              ? 'Click again within 2s to confirm submit'
              : 'Submit review'
            : `Decide remaining ${totalGroups - decided} group(s) first`
        }
      >
        {confirming ? 'Click again to confirm' : 'Submit Review'}
      </button>
    </div>
  )
}
