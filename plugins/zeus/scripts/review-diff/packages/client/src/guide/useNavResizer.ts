// group nav リサイザーの pointerdown ハンドラ (CSS variable 直接書き込み + rAF batch)。
//
// React state を介さず container の `--nav-width` を直接更新する。drag のたびに App が
// 再 render されると panel ツリー全体の reconcile が走るため、レイアウトは CSS grid 側に
// 任せて style write だけで完結させる。

import { useCallback } from 'react'
import type { PointerEventHandler, RefObject } from 'react'

const NAV_WIDTH_MIN = 240
const NAV_WIDTH_MAX = 480

// clamp + 整数 px 化。rAF flush から分離してあるのは、happy-dom では pointer capture を伴う
// drag 全体を再現できないため、幅計算の境界条件だけでも単体テストで固定するため。
export function clampNavWidth(px: number): number {
  return Math.round(Math.max(NAV_WIDTH_MIN, Math.min(NAV_WIDTH_MAX, px)))
}

export function useNavResizer(
  containerRef: RefObject<HTMLDivElement | null>,
): PointerEventHandler<HTMLDivElement> {
  // containerRef は ref object で identity が安定しているため、返すハンドラも mount 中ずっと
  // 同一参照になり、GroupSection の memo を壊さない。
  return useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const resizer = e.currentTarget
    const pointerId = e.pointerId
    const container = containerRef.current
    if (!container) return
    const section = resizer.closest('.group-section') as HTMLElement | null
    if (!section) return

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    // パフォーマンス最適化: ドラッグ中だけ body に is-resizing-nav class を当て、
    // CSS 側で .group-section / .group-nav-wrapper に will-change: grid-template-columns を付与。
    // これにより Chrome が grid 再計算を独立 layer に隔離し、reflow コストが下がる。
    // ドラッグ終了時に class を外して will-change を消す (常時付けると memory コストが上がる)。
    document.body.classList.add('is-resizing-nav')
    resizer.classList.add('dragging')
    try { resizer.setPointerCapture(pointerId) } catch { /* noop */ }

    // パフォーマンス最適化: drag 開始時の section.left を 1 度だけキャッシュ。
    // ドラッグ中に getBoundingClientRect() を呼ぶと「直前の setProperty 後のスタイル更新」を
    // 完了させるための forced sync layout が rAF callback 内で発生し、frame budget を食い潰す。
    // 座標は drag 中変わらないので start でキャッシュすれば flush は純粋に style write だけになる。
    const cachedSectionLeft = section.getBoundingClientRect().left
    // バーは grid gap 内 (-right-3.5) に浮いているため、pointer 位置をそのまま nav 幅に
    // すると掴んだ瞬間に十数 px ジャンプする。掴み位置と nav 右端 (= wrapper 右端) の
    // 差分を引いて「掴んだ場所がそのまま付いてくる」挙動にする。
    const wrapper = resizer.parentElement
    const grabDelta = wrapper ? e.clientX - wrapper.getBoundingClientRect().right : 0
    let rafId: number | null = null
    let pendingClientX = 0
    let lastWrittenPx = -1
    function flush() {
      rafId = null
      if (!container) return
      const rounded = clampNavWidth(pendingClientX - cachedSectionLeft - grabDelta)
      // パフォーマンス最適化: 同じ px 値なら setProperty を skip (style recalc を起こさない)。
      // 1px 未満の微動でも cascade が走るのを防ぐ。
      if (rounded === lastWrittenPx) return
      lastWrittenPx = rounded
      container.style.setProperty('--nav-width', `${rounded}px`)
    }
    function onMove(ev: PointerEvent) {
      pendingClientX = ev.clientX
      if (rafId !== null) return
      rafId = requestAnimationFrame(flush)
    }
    function onUp() {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.body.classList.remove('is-resizing-nav')
      resizer.classList.remove('dragging')
      try { resizer.releasePointerCapture(pointerId) } catch { /* noop */ }
      resizer.removeEventListener('pointermove', onMove)
      resizer.removeEventListener('pointerup', onUp)
      resizer.removeEventListener('pointercancel', onUp)
    }
    resizer.addEventListener('pointermove', onMove)
    resizer.addEventListener('pointerup', onUp)
    resizer.addEventListener('pointercancel', onUp)
  }, [containerRef])
}
