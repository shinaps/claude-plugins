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
    <div
      className="fixed bottom-6 right-6 z-40 flex items-center gap-3 px-3.5 py-2.5 bg-surface border border-border rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.3)]"
      role="toolbar"
      aria-label="Submit review"
    >
      <span className="text-[11px] text-text-muted font-mono tabular-nums">{summary}</span>
      {/*
        btn-submit BEM を残す理由: `.btn-submit.is-confirming` の bg/color/animation を globals.css の
        @layer components に集約しているため。utility 側は base + disabled の見た目だけ表現する。
      */}
      <button
        type="button"
        className={`btn-submit px-4 py-2 border border-border bg-accent text-background rounded-lg cursor-pointer text-[12.5px] font-semibold font-sans tracking-[0.01em] transition-[filter,background] duration-[120ms] enabled:hover:brightness-[1.08] disabled:bg-surface-3 disabled:text-text-dim disabled:cursor-not-allowed${confirming ? ' is-confirming' : ''}`}
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
