// ↑↓ キーで「次/前の変更箇所 (addition/deletion 連続塊)」へ panel をまたいでジャンプする
// グローバルキーボードナビゲーション。
//
// 以前は左下 floating の ChunkNavigator (ボタン + N/M カウンタ) が同機能の画面 UI を持っていたが、
// fixed + z-40 の不透明な箱が GroupNav の decision ボタン (sticky でスクロールでは逃がせない
// 操作 UI) に被ってクリック不能になる構造問題があり、「キー操作の画面用ボタンでしかない」ため
// UI を廃止してキーボード機能だけを hook として残した。
//
// 設計:
//   - DOM 走査ベース (`[data-chunk-idx]` 属性を持つ code-row を querySelectorAll)。
//     Panel.tsx が code-row に data-chunk-idx を付与している前提
//   - 同じ panel 内では chunkIdx 0..N-1 だが、panel をまたぐと別 panel の 0 とぶつかる。
//     その対策として「直前の row と同じ panel + 同じ chunkIdx ならスキップ」で「各 chunk の最初 row」を取る
//   - rows はキー押下のたびに collect し直す (キャッシュしない)。UI 表示が無くなったことで
//     scroll 毎の再計算が不要になり、ユーザー操作起点の数 ms の走査コストだけで済むため、
//     旧実装の MutationObserver + dirty フラグの仕掛けは丸ごと不要になった
//   - キーボード ↑↓ は input/textarea/contenteditable では default 動作を尊重

import { useCallback, useEffect, useRef } from 'react'

// sticky tabbar (46px) + sticky panel-header (~46px) + 余白で、jump 先 chunk が panel-header の
// 真下に綺麗に貼り付くようにする。
const CHUNK_SCROLL_OFFSET_PX = 110
// findCurrentChunkIdx で current 判定の閾値に余裕を持たせる。
// strict `<` だと smooth scroll 完了直後に境界で false になり「2 回目以降押しても動かない」罠が出る。
const CHUNK_CURRENT_SLOP_PX = 32

// 表示中のタブから「各 chunk の最初の row」を panel をまたいで順序通りに集める。
// panel ごとに chunkIdx は 0 から振り直されるので、panelId + chunkIdx の組で重複検出する。
// .tab-pane:not(.tab-hidden) で絞る理由: 非アクティブタブは content-visibility: hidden で
// DOM に残ったまま keep-alive されるため、document 全体を走査すると Guide と Diff の
// chunk が合算されて件数が水増しされる。
function collectGlobalChunkRows(): HTMLElement[] {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.tab-pane:not(.tab-hidden) .panel-side-asis [data-chunk-idx]',
    ),
  )
  const out: HTMLElement[] = []
  let lastKey: string | null = null
  for (const row of rows) {
    const panelBlock = row.closest('[data-panel-id]') as HTMLElement | null
    const panelId = panelBlock?.dataset.panelId ?? ''
    const idx = row.dataset.chunkIdx ?? ''
    const key = `${panelId}\x1f${idx}`
    if (key === lastKey) continue
    lastKey = key
    out.push(row)
  }
  return out
}

function findCurrentGlobalChunkIdx(rows: HTMLElement[]): number {
  let current = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].getBoundingClientRect().top < CHUNK_SCROLL_OFFSET_PX + CHUNK_CURRENT_SLOP_PX) {
      current = i
    } else {
      break
    }
  }
  return current
}

// enabled: Guide / Diff タブ表示中のみ true。Activity タブでは ↑↓ を奪わない。
export function useChunkKeyNav(enabled: boolean): void {
  // ナビゲーション中の「向かっている先」。
  //   - 連打対応: smooth scroll の途中で findCurrentGlobalChunkIdx すると中間位置の chunk が
  //     返り、同じ target に何度も向かって進まなくなる。押下中は pendingTarget を基準に進める。
  //   - 到着補正: content-visibility: auto の section は近づくまで子のレイアウトが確定せず、
  //     ジャンプ前に測った座標が到着時にはずれていることがある。scrollend で実測し直して補正する。
  const pendingTargetRef = useRef<number | null>(null)
  // scrollend 補正がジャンプ時の rows を参照するための snapshot (navigate のたびに更新)。
  const rowsRef = useRef<HTMLElement[]>([])
  // cv-auto の段階確定で複数回ずれるケースに備えつつ、無限補正ループは防ぐ上限。
  const correctionLeftRef = useRef(0)

  const scrollToRow = useCallback((el: HTMLElement) => {
    const top = el.getBoundingClientRect().top + window.scrollY - CHUNK_SCROLL_OFFSET_PX
    window.scrollTo({ top, behavior: 'smooth' })
  }, [])

  const navigate = useCallback((direction: -1 | 1) => {
    const rows = collectGlobalChunkRows()
    rowsRef.current = rows
    if (rows.length === 0) return
    const base = pendingTargetRef.current ?? findCurrentGlobalChunkIdx(rows)
    const target = direction === 1 ? base + 1 : base === -1 ? -1 : base - 1
    if (target < 0 || target >= rows.length) return
    pendingTargetRef.current = target
    correctionLeftRef.current = 3
    scrollToRow(rows[target])
  }, [scrollToRow])

  // scrollend で到着検証。ずれていたら補正再スクロール、収まっていたら pending を解除。
  // ユーザーが wheel / touch で介入したら追跡をやめる (補正で引き戻さない)。
  useEffect(() => {
    if (!enabled) return
    function cancelPending() {
      pendingTargetRef.current = null
    }
    function onScrollEnd() {
      const t = pendingTargetRef.current
      if (t == null) return
      const el = rowsRef.current[t]
      if (!el) { pendingTargetRef.current = null; return }
      const top = el.getBoundingClientRect().top
      if (Math.abs(top - CHUNK_SCROLL_OFFSET_PX) > CHUNK_CURRENT_SLOP_PX && correctionLeftRef.current > 0) {
        correctionLeftRef.current -= 1
        scrollToRow(el)
      } else {
        pendingTargetRef.current = null
      }
    }
    window.addEventListener('scrollend', onScrollEnd)
    window.addEventListener('wheel', cancelPending, { passive: true })
    window.addEventListener('touchmove', cancelPending, { passive: true })
    return () => {
      window.removeEventListener('scrollend', onScrollEnd)
      window.removeEventListener('wheel', cancelPending)
      window.removeEventListener('touchmove', cancelPending)
      pendingTargetRef.current = null
    }
  }, [enabled, scrollToRow])

  // ↑↓ キーで navigate。input/textarea/contenteditable では default 動作を残す。
  useEffect(() => {
    if (!enabled) return
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        navigate(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        navigate(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, navigate])
}
