// 左下 floating の「変更箇所ナビゲーター」。
// SubmitBar (右下) と対称配置で「全 diff 通しのグローバル navigation」であることを視覚的に示す。
//
// 設計:
//   - 全 panel をまたいで「次/前の変更箇所 (addition/deletion 連続塊)」へジャンプする
//   - DOM 走査ベース (`[data-chunk-idx]` 属性を持つ code-row を querySelectorAll)。
//     Panel.tsx が code-row に data-chunk-idx を付与している前提
//   - 同じ panel 内では chunkIdx 0..N-1 だが、panel をまたぐと別 panel の 0 とぶつかる。
//     その対策として「直前の row と同じ panel + 同じ chunkIdx ならスキップ」で「各 chunk の最初 row」を取る
//   - scrollY 変化を rAF throttle で listen し、現在位置 (i / N) をリアルタイム更新
//   - キーボード ↑↓ も常時 listen (input/textarea/contenteditable では default 動作を尊重)
//   - chunk が 0 件なら非表示 (diff が context のみのレアケース)

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'

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

type Props = {
  // 表示中のタブ。guide / diff で chunk 集合が変わるが、タブ切替は wrapper の class 変更のみで
  // childList mutation を起こさないため、MutationObserver では検知できない。prop で受けて再 collect する。
  activeTab: 'guide' | 'diff'
}

export function ChunkNavigator({ activeTab }: Props) {
  // 表示用 state: 全 chunk 数と current index (1-based 表示にするが state は 0-based)。
  const [stats, setStats] = useState<{ total: number; current: number }>({ total: 0, current: -1 })
  // rows のキャッシュ。scroll 中は collect しない (重い)、layout 変化時のみ再構築。
  const rowsCacheRef = useRef<HTMLElement[]>([])
  // 再 collect が必要かフラグ。MutationObserver で「panel-block 構造が変わった」時に立つ。
  const dirtyRef = useRef(true)

  const refreshRows = useCallback(() => {
    rowsCacheRef.current = collectGlobalChunkRows()
    dirtyRef.current = false
  }, [])

  const recompute = useCallback(() => {
    if (dirtyRef.current) refreshRows()
    const rows = rowsCacheRef.current
    const current = findCurrentGlobalChunkIdx(rows)
    setStats(prev => (prev.total === rows.length && prev.current === current ? prev : { total: rows.length, current }))
  }, [refreshRows])

  // 初回 / タブ切替時 + 100ms 後に再 compute (lazy highlight 完了後の chunk 数変化を取り込むため)。
  useEffect(() => {
    dirtyRef.current = true
    recompute()
    const t = setTimeout(recompute, 100)
    return () => clearTimeout(t)
  }, [recompute, activeTab])

  // scroll listen (rAF throttle で軽量化)。
  useEffect(() => {
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        recompute()
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
    }
  }, [recompute])

  // panel の collapse/expand で chunk row 集合が変わるので、MutationObserver で構造変化を監視。
  // attribute 変更ではなく childList 変更だけ追う (パフォーマンス考慮)。
  //
  // rAF + 50ms debounce を挟む。tab 切替時の 22 panel 一斉 attach で childList burst が
  // 起きると 1 callback で recompute() 内の querySelectorAll + N 個の getBoundingClientRect が
  // 同期実行され、数秒級の LoAF の主因になる。burst を 1 回にまとめることで <100ms に抑える。
  useEffect(() => {
    const root = document.querySelector('[data-app-root]') ?? document.body
    let raf = 0
    let timer = 0
    const flushRecompute = () => {
      timer = 0
      if (dirtyRef.current) recompute()
    }
    const mo = new MutationObserver(() => {
      dirtyRef.current = true
      // burst 中は 1 回にまとめる
      if (raf || timer) return
      raf = requestAnimationFrame(() => {
        raf = 0
        // rAF + 50ms 待ってから recompute (= burst の最後で 1 回)
        timer = window.setTimeout(flushRecompute, 50)
      })
    })
    mo.observe(root, { childList: true, subtree: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
      mo.disconnect()
    }
  }, [recompute])

  // ナビゲーション中の「向かっている先」。
  //   - 連打対応: smooth scroll の途中で findCurrentGlobalChunkIdx すると中間位置の chunk が
  //     返り、同じ target に何度も向かって進まなくなる。押下中は pendingTarget を基準に進める。
  //   - 到着補正: content-visibility: auto の section は近づくまで子のレイアウトが確定せず、
  //     ジャンプ前に測った座標が到着時にはずれていることがある。scrollend で実測し直して補正する。
  const pendingTargetRef = useRef<number | null>(null)
  // cv-auto の段階確定で複数回ずれるケースに備えつつ、無限補正ループは防ぐ上限。
  const correctionLeftRef = useRef(0)

  const scrollToRow = useCallback((el: HTMLElement) => {
    const top = el.getBoundingClientRect().top + window.scrollY - CHUNK_SCROLL_OFFSET_PX
    window.scrollTo({ top, behavior: 'smooth' })
  }, [])

  const navigate = useCallback((direction: -1 | 1) => {
    if (dirtyRef.current) refreshRows()
    const rows = rowsCacheRef.current
    if (rows.length === 0) return
    const base = pendingTargetRef.current ?? findCurrentGlobalChunkIdx(rows)
    const target = direction === 1 ? base + 1 : base === -1 ? -1 : base - 1
    if (target < 0 || target >= rows.length) return
    pendingTargetRef.current = target
    correctionLeftRef.current = 3
    scrollToRow(rows[target])
  }, [refreshRows, scrollToRow])

  // scrollend で到着検証。ずれていたら補正再スクロール、収まっていたら pending を解除。
  // ユーザーが wheel / touch で介入したら追跡をやめる (補正で引き戻さない)。
  useEffect(() => {
    function cancelPending() {
      pendingTargetRef.current = null
    }
    function onScrollEnd() {
      const t = pendingTargetRef.current
      if (t == null) return
      const el = rowsCacheRef.current[t]
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
    }
  }, [scrollToRow])

  // ↑↓ キーで navigate。input/textarea/contenteditable では default 動作を残す。
  useEffect(() => {
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
  }, [navigate])

  if (stats.total === 0) return null

  const display = stats.current === -1 ? `· / ${stats.total}` : `${stats.current + 1} / ${stats.total}`
  const hasPrev = stats.current > 0
  const hasNext = stats.current < stats.total - 1

  const BTN =
    'bg-transparent border border-border-soft text-text-dim w-[28px] h-[28px] inline-flex items-center justify-center cursor-pointer p-0 transition-colors duration-[120ms] enabled:hover:bg-surface-3 enabled:hover:text-text enabled:hover:border-border disabled:opacity-[0.35] disabled:cursor-not-allowed'

  return (
    // SubmitBar (fixed right-6 bottom-6) と対称に left-6 bottom-6。両者で「画面下隅 = グローバル操作」と認知させる。
    // shadow は意図的に付けない: 高輝度モニターで暗色 shadow の halo が滲んで見えるため、区切りは border のみ (SubmitBar も同じ方針)。
    <div
      className="fixed bottom-6 left-6 z-40 inline-flex items-center gap-2 px-2.5 py-2 bg-surface border border-border rounded-xl"
      role="toolbar"
      aria-label="Jump between changes"
    >
      <div className="inline-flex items-center gap-0">
        <button
          type="button"
          className={`${BTN} rounded-l-md rounded-r-none`}
          onClick={() => navigate(-1)}
          disabled={!hasPrev}
          title="前の変更箇所へ (↑ キー)"
          aria-label="Previous change"
        >
          <ChevronUp size={14} strokeWidth={1.6} aria-hidden />
        </button>
        <button
          type="button"
          className={`${BTN} border-l-0 rounded-r-md rounded-l-none`}
          onClick={() => navigate(1)}
          disabled={!hasNext}
          title="次の変更箇所へ (↓ キー)"
          aria-label="Next change"
        >
          <ChevronDown size={14} strokeWidth={1.6} aria-hidden />
        </button>
      </div>
      <span className="text-[11px] text-text-muted font-mono tabular-nums">
        {display} <span className="text-text-dim ml-1">changes</span>
      </span>
    </div>
  )
}
