// 1 Panel = 1 CSS Grid (div ベース) でレンダリングするコンポーネント (split only)。
//
// 設計判断 (旧 <table> 構造 / 旧 unified mode 廃止):
//   - 旧 <table> 構造では「左右独立横スクロール + 50/50 + 行高同期」が CSS 仕様上同時充足
//     不可能だった (table cell は per-cell scroll しか出来ず、列方向の cell 群を 1 つの scroll
//     viewport に束ねる box が CSS table model に存在しない)。
//     対症療法 (table-layout fixed/auto、useLayoutEffect で table.style.width 実測など 4 回試行)
//     はすべて根本的に解決不能だったため、DOM 構造そのものを div + CSS Grid に置換した。
//   - panel-grid を 2 列 (asIs side + toBe side) で構成。各 side は独立した overflow-x:auto
//     コンテナで、その中で gutter + code を縦に積む。
//     これにより「左右独立 1 スクロールバー」+「per-side blowout 防止 (minmax(0, 1fr))」を構造的に達成。
//   - 行高同期: ResizeObserver で各 side の同一インデックス .code-row の offsetHeight max を
//     min-height として書き戻す JS 同期方式。
//     subgrid は同一 scroll container 内でしか機能しないため per-side scroll と排他。
//   - unified mode (単一カラム) は撤去済み。split mode 一本化で UI 学習コストを下げ、
//     mode toggle に必要だった localStorage / mode toggle button / comment-side-badge も削減できた。
//   - AC-6 (panel 跨ぎコメント不可): panelContainerRef.contains(cell) で構造的に担保。
//     セレクタは `closest('[data-side][data-line-number]')` に統一 (td/div どちらでも動く)。
//   - LineCommentHandlers は panelId 単位で thread を管理する。
//   - sortAnchorKeys: 範囲 → 単一の順、で並べる (旧 DiffTable と同じ UX)。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, SquareArrowOutUpRight } from 'lucide-react'
import type { RenderedPanel, SideBySideRow, Side } from '@zeus/review-diff-shared'
import { sideToAttr, attrToSide } from '@zeus/review-diff-shared'
import { parseLineCommentKey, lineCommentKey } from './state'
import { getToken } from './state'
import type { LineCommentHandlers } from './useLineComments'

// v5: window 経由で editorAvailable と editor-open Toast コールバックを受け渡す。
// prop drilling を避けるための簡易チャネル (App → Panel が深いため)。
//   - __reviewDiffEditorAvailable : boolean、設定された editor preset があれば true
//   - __reviewDiffShowToast       : (msg: string) => void、Toast 表示
//   - __reviewDiffThreads         : 永続化済みスレッド (payload.initialThreads)、user/agent message を全表示
//
// CR-3: editor command 自体は server 側のみで保持される。クライアントは boolean だけ知る。
import type { ThreadSnapshot } from '@zeus/review-diff-shared'
declare global {
  interface Window {
    __reviewDiffEditorAvailable?: boolean
    __reviewDiffShowToast?: (msg: string) => void
    __reviewDiffThreads?: Record<string, ThreadSnapshot>
  }
}

// v5: line scope の lineCommentKey から threadKey (= "line:<panelId>:<side>:<line>[:<endLine>]") を作る。
// payload.initialThreads の key と一致する形式。
function lineKeyToThreadKey(panelId: string, side: 'asIs' | 'toBe', line: number, endLine?: number): string {
  const range = endLine != null && endLine !== line ? `${line}:${endLine}` : `${line}`
  return `line:${panelId}:${side}:${range}`
}
import { PanelHeader } from './PanelHeader'
import { CommentForm } from './CommentForm'
import { createShiki } from './shiki-bundle'

const SHIKI = createShiki()
const CLICK_THRESHOLD_MS = 200

type FlatRow = {
  row: SideBySideRow
  segmentIndex: number
  rowIndex: number
  isFirstOfSegment: boolean
  // 連続する addition / deletion ブロックを 1 chunk とした index。context / empty 行は -1。
  // 「次の変更箇所」グローバル navigator が `[data-chunk-idx]` を querySelectorAll で集めて
  // panel をまたぐ全 chunk リストを構築する anchor として使う。
  chunkIdx: number
}

// chunk 検出: addition / deletion が連続する塊を 1 chunk としてまとめる。
// context や empty が挟まれば chunk 境界。chunkIdx は panel scope (各 panel で 0 から)。
// グローバル navigator は panel をまたいで「最初の chunk row」を順に並べることで全体 navigation を実現する。
function flattenWithChunks(panel: RenderedPanel): FlatRow[] {
  const flat: FlatRow[] = []
  panel.segments.forEach((seg, si) => {
    seg.rows.forEach((row, ri) => {
      flat.push({ row, segmentIndex: si, rowIndex: ri, isFirstOfSegment: ri === 0 && si > 0, chunkIdx: -1 })
    })
  })
  let chunkIdx = -1
  let inChunk = false
  for (const r of flat) {
    const isChange = r.row.asIs.type === 'deletion' || r.row.toBe.type === 'addition'
    if (isChange) {
      if (!inChunk) { chunkIdx++; inChunk = true }
      r.chunkIdx = chunkIdx
    } else {
      inChunk = false
    }
  }
  return flat
}

function highlightCode(raw: string, lang: string): string {
  try {
    const html = SHIKI.codeToHtml(raw, { lang, theme: 'github-dark' })
    const m = html.match(/<code[^>]*>([\s\S]*?)<\/code>/)
    return (m ? m[1] : escapeHtml(raw)).replace(/\n$/, '')
  } catch {
    return escapeHtml(raw)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

type DragState = {
  side: Side
  startNumber: number
  currentNumber: number
  startedAt: number
} | null

export type PanelProps = {
  panel: RenderedPanel
  highlight?: boolean
  // PanelHeader 右に Hide diff ボタンを出すための callback。
  // PanelBlock 側で「userOverride='collapse' 状態に切替」をハンドル。
  onCollapse?: () => void
} & LineCommentHandlers

export const Panel = memo(function Panel({
  panel,
  highlight = true,
  onCollapse,
  ...handlers
}: PanelProps) {
  const [drag, setDrag] = useState<DragState>(null)
  const dragRef = useRef<DragState>(null)
  // 旧 panelTableRef → panelContainerRef。div ベースに変わったので HTMLDivElement で受ける。
  // resolveLineAtPoint の AC-6 scope check (別 panel の cell を弾く) で使用。
  const panelContainerRef = useRef<HTMLDivElement>(null)

  // chunk = 連続する addition/deletion 塊。SplitBody に flat を渡すために計算する。
  // ナビゲーション本体は ChunkNavigator (左下 floating) が document 全体を querySelectorAll で
  // 走査して panel をまたいで動くので、ここでは「chunkIdx を code-row に乗せる」だけが責務。
  const flat = useMemo(() => flattenWithChunks(panel), [panel])

  // 行高同期: per-side scroll container が分かれた結果、左右で行高がズレる
  // (例: 左 side のみ wrap して高さが伸びるケース)。subgrid なら親 grid 内で自動的に揃うが、
  // 本実装では左右が別 scroll container なので subgrid が使えない。
  // ResizeObserver で各 .code-row を観測し、両 side の同一インデックス行の offsetHeight max を
  // min-height として書き戻して同期する。requestAnimationFrame で coalesce してレイアウト
  // スラッシングを防ぐ。
  useLayoutEffect(() => {
    const container = panelContainerRef.current
    if (!container) return
    let raf = 0
    const sync = () => {
      raf = 0
      const leftRows = container.querySelectorAll<HTMLElement>('.panel-side-asis .code-row')
      const rightRows = container.querySelectorAll<HTMLElement>('.panel-side-tobe .code-row')
      const n = Math.min(leftRows.length, rightRows.length)
      if (n === 0) return
      // パフォーマンス最適化: display:none / content-visibility:hidden 中は offsetHeight=0 になり
      // 全 row に minHeight=0 を書く副作用を避けるため、最初の 1 行だけ probe して skip 判定。
      // ResizeObserver は display:none 復帰時に「全 row が 0→実サイズ」の遷移で一斉発火するため、
      // 非表示中の sync 呼出をスキップすれば LoAF で計測された forced-layout 3.1 秒級の主犯を抑制できる。
      if (leftRows[0].offsetHeight === 0 && rightRows[0].offsetHeight === 0) return

      // パフォーマンス最適化: read / write を 3-pass に厳密分離して forced sync layout を
      // N 回 → 1 回に削減する。元実装は loop 内で `offsetHeight` 直後に `style.minHeight` を書いていたため、
      // 各 row で layout が強制フラッシュされ N 行 = N 回の reflow になっていた (28 panel × 数千 row = 6 秒)。
      //   Pass 1: 全 row の minHeight を '' にして natural サイズに戻す (layout 無効化のみ)
      //   Pass 2: 全 row の getBoundingClientRect().height を一括 read (1 回だけ layout flush)
      //   Pass 3: 全 row に新しい minHeight を一括 write (layout 無効化のみ)
      //
      // height 計測に getBoundingClientRect().height + Math.ceil を使う理由 (sub-pixel 蓄積ずれ修正):
      //   offsetHeight は integer (Chrome は floor)。Shiki の font metrics で asis=17.00 / tobe=17.04 の
      //   ような sub-pixel 差が出ると、offsetHeight は両方 17 → min-height: 17px → tobe は 17.04 の
      //   ままで揃わず、行ごとに +0.04 ずつ累積し 数百行で数 px のずれになる (実機 DevTools で確認済)。
      //   getBoundingClientRect().height は float、Math.ceil() で sub-pixel を吸収して大きい側に揃える。
      for (let i = 0; i < n; i++) {
        leftRows[i].style.minHeight = ''
        rightRows[i].style.minHeight = ''
      }
      const heights: number[] = new Array(n)
      for (let i = 0; i < n; i++) {
        const la = leftRows[i].getBoundingClientRect().height
        const lb = rightRows[i].getBoundingClientRect().height
        heights[i] = Math.ceil(Math.max(la, lb))
      }
      for (let i = 0; i < n; i++) {
        const h = heights[i]
        leftRows[i].style.minHeight = `${h}px`
        rightRows[i].style.minHeight = `${h}px`
      }
    }
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(sync)
    }
    sync()
    const ro = new ResizeObserver(schedule)
    container.querySelectorAll<HTMLElement>('.code-row').forEach((el) => ro.observe(el))
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      container.querySelectorAll<HTMLElement>('.code-row').forEach((el) => {
        el.style.minHeight = ''
      })
    }
  }, [panel.segments])

  // v5: panel-side の実 clientWidth を CSS variable --ps-width に書き出し、
  // .comment-row が `width: var(--ps-width)` で参照する。
  //
  // 背景: 旧実装の `.comment-row` width は `calc((100vw - --nav-width - 48px) / 2 - 1px)` の
  // viewport ベースで、実際の panel-side clientWidth と +16px ほどズレていた (= .group-section の
  // gap 32px が viewport calc に含まれていない等のため)。これにより comment-row が sticky parent
  // (.panel-side-inner) の右端からはみ出し、scrollLeft = max 付近で「containing block 右端を超えない」
  // sticky 制約に押されて 16px シフトしていた (= ユーザー指摘の「右端で少し動く」ジッター)。
  //
  // 解決: ResizeObserver で .panel-side 自身の clientWidth を観測し、要素 inline style として
  // CSS variable をセットする。viewport / nav width / scrollbar gutter / grid gap などの影響を
  // 全て吸収できる (実 clientWidth は計算誤差ゼロ)。
  useLayoutEffect(() => {
    const container = panelContainerRef.current
    if (!container) return
    const sides = container.querySelectorAll<HTMLElement>('.panel-side')
    const update = (el: HTMLElement) => {
      const w = el.clientWidth
      const prev = el.style.getPropertyValue('--ps-width')
      const next = `${w}px`
      // 同値 skip (App.tsx L460-477 と同じパターン、不要な reflow を抑止)
      if (prev === next) return
      el.style.setProperty('--ps-width', next)
    }
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) update(entry.target as HTMLElement)
    })
    sides.forEach((el) => {
      update(el)
      ro.observe(el)
    })
    return () => ro.disconnect()
  }, [])

  // 左右スクロール同期: per-side が独立 overflow-x:auto なので、片側を横スクロールすると
  // 反対側は動かない。ユーザー要望で「赤と緑のスクロールが同期」= 1 panel 内では
  // asIs / toBe の scrollLeft が常に一致するべき。双方向 mirror で sync する。
  //
  // パフォーマンス最適化: 旧実装は `syncing` フラグで再帰防止していたが、連続スクロール時に
  // 「フラグが立っている間の event が drop される」(rAF 解除まで 16ms)。その間ユーザーが
  // スクロールし続けると mirror 側は止まり、解除後に「累積分が一気に飛ぶ」カクカク現象が出ていた。
  // 新実装: scroll event は drop せず latest scrollLeft を rAF にバッチ保留 → frame 単位で apply。
  // 再帰防止は「dst が src と同値なら skip」で取る (sync 直後の反対側 scroll event は no-op)。
  useLayoutEffect(() => {
    const container = panelContainerRef.current
    if (!container) return
    const asis = container.querySelector<HTMLElement>('.panel-side-asis')
    const tobe = container.querySelector<HTMLElement>('.panel-side-tobe')
    if (!asis || !tobe) return
    let rafId = 0
    let pendingFrom: HTMLElement | null = null
    const flush = () => {
      rafId = 0
      const src = pendingFrom
      pendingFrom = null
      if (!src) return
      const dst = src === asis ? tobe : asis
      if (Math.abs(dst.scrollLeft - src.scrollLeft) > 0.5) {
        dst.scrollLeft = src.scrollLeft
      }
    }
    const handler = (src: HTMLElement) => () => {
      pendingFrom = src
      if (rafId) return
      rafId = requestAnimationFrame(flush)
    }
    const onAsis = handler(asis)
    const onTobe = handler(tobe)
    asis.addEventListener('scroll', onAsis, { passive: true })
    tobe.addEventListener('scroll', onTobe, { passive: true })
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      asis.removeEventListener('scroll', onAsis)
      tobe.removeEventListener('scroll', onTobe)
    }
  }, [])

  const setDragBoth = useCallback((next: DragState) => {
    dragRef.current = next
    setDrag(next)
  }, [])

  // ドラッグ中 Escape キャンセル + window pointerup 保険 (cross-panel drag は完全に弾く)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setDragBoth(null)
    }
    function onWindowPointerUp(e: PointerEvent) {
      const cur = dragRef.current
      if (!cur) return
      const endNumber = resolveLineAtPoint(e.clientX, e.clientY, cur.side) ?? cur.currentNumber
      const lo = Math.min(cur.startNumber, endNumber)
      const hi = Math.max(cur.startNumber, endNumber)
      const elapsed = performance.now() - cur.startedAt
      const isSingle = lo === hi && elapsed < CLICK_THRESHOLD_MS
      if (isSingle || lo === hi) {
        handlers.onOpenLineForm(panel.panelId, { side: cur.side, number: lo })
      } else {
        handlers.onOpenLineForm(panel.panelId, { side: cur.side, number: lo, endNumber: hi })
      }
      setDragBoth(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerup', onWindowPointerUp)
    window.addEventListener('pointercancel', onWindowPointerUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerup', onWindowPointerUp)
      window.removeEventListener('pointercancel', onWindowPointerUp)
    }
  }, [setDragBoth, handlers, panel.panelId])

  // ドラッグ中の line-snap インジケータ (GitHub PR 風)。
  // 仕様: カーソルが横切っている行の gutter 上 (= 普段 + ボタンが出る位置) に `+` をスナップ表示。
  // 自由追従ではなく「いま hover している行の gutter center」に「いつもの + ボタン」と同じ場所で
  // 出すことで「ドラッグして範囲選択中」のリアルタイム選択フィードバックになる。
  // 実装: pointermove で cursor 直下の cell-ln を elementFromPoint → その cell の rect で位置決定。
  const [dragIndicator, setDragIndicator] = useState<{ left: number; top: number } | null>(null)
  useEffect(() => {
    if (!drag) {
      setDragIndicator(null)
      document.body.classList.remove('is-dragging-line-range')
      return
    }
    // drag indicator は **drag 開始 side** にロックする。
    // 反対 side のパネルや空白領域 (summary / 中央コラム) にカーソルが移動しても、
    // X は開始 side のアンカーで固定、Y だけカーソルに追従して開始 side の行に snap する。
    // (resolveLineAtPoint と同じ side ロックポリシー: 範囲選択も開始 side 内で完結する)
    const sideAttr = sideToAttr(drag.side)
    const cellLns = Array.from(
      panelContainerRef.current?.querySelectorAll<HTMLElement>(`.cell-ln[data-side="${sideAttr}"]`) ?? []
    )
    // anchorX: drag 開始 side の最初の cell-ln から trigger ボタン中心を実測。
    // ハードコード (旧: lnRect.left + 9) だと button 幅変更で drag 中だけズレるため動的測定。
    // is-dragging-line-range クラス付与前に測ること: クラスが付くと trigger は display:none される。
    let anchorX = 0
    if (cellLns.length > 0) {
      const firstLn = cellLns[0]
      const lnRect = firstLn.getBoundingClientRect()
      let triggerCenterX = 9 // フォールバック (button 未マウントの極稀ケース)
      const sampleTrigger = firstLn.querySelector<HTMLElement>('.line-comment-trigger')
      if (sampleTrigger) {
        const tr = sampleTrigger.getBoundingClientRect()
        triggerCenterX = (tr.left - lnRect.left) + tr.width / 2
      }
      anchorX = lnRect.left + triggerCenterX
    }
    document.body.classList.add('is-dragging-line-range')
    function onMove(e: PointerEvent) {
      if (cellLns.length === 0) return
      // hot-path: anchorX 縦線上で elementsFromPoint。drag 開始 side の cell-ln 縦列に
      // 必ず当たるので画面上どこでカーソルがあっても Y で snap できる。
      // 高速 (stacked element 数 = せいぜい 5-10 個) で 99% のケースを捌く。
      let ln: HTMLElement | null = null
      const els = document.elementsFromPoint(anchorX, e.clientY)
      for (const el of els) {
        if (el instanceof HTMLElement && el.classList.contains('cell-ln') && el.dataset.side === sideAttr) {
          ln = el
          break
        }
      }
      // cold-path: 画面外 (Y が panel 上下端の外) や行間ギャップで miss したとき、
      // cell-ln 群を線形探索して cursor Y に最も近い行を選ぶ (panel 端で clamp する効果)。
      if (!ln) {
        let closest = cellLns[0]
        let closestDist = Infinity
        for (const candidate of cellLns) {
          const r = candidate.getBoundingClientRect()
          const center = r.top + r.height / 2
          const dist = Math.abs(e.clientY - center)
          if (dist < closestDist) {
            closestDist = dist
            closest = candidate
          }
        }
        ln = closest
      }
      const lnRect = ln.getBoundingClientRect()
      setDragIndicator({
        left: anchorX,
        top: lnRect.top + lnRect.height / 2,
      })
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.body.classList.remove('is-dragging-line-range')
    }
  }, [drag])

  function isInDragRange(side: Side, lineNumber: number | undefined): boolean {
    if (lineNumber == null) return false
    // drag 中: drag.startNumber..currentNumber を accent ハイライト
    if (drag && drag.side === side) {
      const lo = Math.min(drag.startNumber, drag.currentNumber)
      const hi = Math.max(drag.startNumber, drag.currentNumber)
      if (lineNumber >= lo && lineNumber <= hi) return true
    }
    // form open 中: activeForm が指す行も同じ accent ハイライトを継続。
    // ユーザー要望: textarea が表示されてる間は「どの行に対するコメントか」が視線で追えるよう、
    // 選択行 (単一行 or 範囲) の line-selected を維持する。
    if (handlers.activeForm) {
      const parsed = parseLineCommentKey(handlers.activeForm)
      if (parsed.panelId === panel.panelId && parsed.side === side) {
        const lo = Math.min(parsed.number, parsed.endNumber ?? parsed.number)
        const hi = Math.max(parsed.number, parsed.endNumber ?? parsed.number)
        if (lineNumber >= lo && lineNumber <= hi) return true
      }
    }
    return false
  }

  // カーソル位置 → 対象行 (panel scoped)。別 panel の cell はここで null に落ちる (AC-6)。
  // セレクタは td でも div でも動くように `[data-side][data-line-number]` で統一。
  function resolveLineAtPoint(
    clientX: number, clientY: number, expectSide: Side,
  ): number | null {
    // hot-path: cursor 直下に expectSide の cell があれば即返却。
    // panel 内で expectSide 上をドラッグしている通常ケースをこの分岐で 99% 捌く。
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    if (el) {
      const cell = el.closest('[data-side][data-line-number]') as HTMLElement | null
      // panelContainerRef.contains で AC-6 構造的担保: 別 panel の cell は無視
      if (cell && (!panelContainerRef.current || panelContainerRef.current.contains(cell))) {
        const sideAttr = cell.dataset.side
        const side = sideAttr ? attrToSide(sideAttr) : null
        if (side === expectSide) {
          const num = cell.dataset.lineNumber
          const n = num ? Number(num) : NaN
          if (Number.isFinite(n)) return n
        }
      }
    }
    // cold-path: cursor が panel 外 / 反対 side / 中央コラム / panel 上下端の外側にいるとき、
    // expectSide の cell-ln 群を線形探索して cursor Y に最も近い行を選ぶ (clamp 効果)。
    // drag indicator の onMove と同じ snap ポリシーで、行ハイライトも同じ行に追従する。
    if (!panelContainerRef.current) return null
    const sideAttr = sideToAttr(expectSide)
    const cellLns = panelContainerRef.current.querySelectorAll<HTMLElement>(
      `.cell-ln[data-side="${sideAttr}"]`,
    )
    let closestNum: number | null = null
    let closestDist = Infinity
    for (const ln of cellLns) {
      const num = ln.dataset.lineNumber
      if (!num) continue
      const n = Number(num)
      if (!Number.isFinite(n)) continue
      const r = ln.getBoundingClientRect()
      const center = r.top + r.height / 2
      const dist = Math.abs(clientY - center)
      if (dist < closestDist) {
        closestDist = dist
        closestNum = n
      }
    }
    return closestNum
  }

  function handlePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    side: Side,
    lineNumber: number,
  ) {
    if (e.button !== 0) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
    setDragBoth({
      side, startNumber: lineNumber, currentNumber: lineNumber,
      startedAt: performance.now(),
    })
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const cur = dragRef.current
    if (!cur) return
    const next = resolveLineAtPoint(e.clientX, e.clientY, cur.side)
    if (next == null || next === cur.currentNumber) return
    setDragBoth({ ...cur, currentNumber: next })
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const cur = dragRef.current
    if (!cur) return
    if (e.type === 'pointerup' && e.button > 0) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* noop */ }
    const endNumber = resolveLineAtPoint(e.clientX, e.clientY, cur.side) ?? cur.currentNumber
    const lo = Math.min(cur.startNumber, endNumber)
    const hi = Math.max(cur.startNumber, endNumber)
    const elapsed = performance.now() - cur.startedAt
    const isSingle = lo === hi && elapsed < CLICK_THRESHOLD_MS
    if (isSingle || lo === hi) {
      handlers.onOpenLineForm(panel.panelId, { side: cur.side, number: lo })
    } else {
      handlers.onOpenLineForm(panel.panelId, { side: cur.side, number: lo, endNumber: hi })
    }
    setDragBoth(null)
  }

  // panelId に紐付くコメント key を (side, anchor) で逆引き
  const commentKeysByAnchor = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const key of handlers.lineComments.keys()) {
      const parsed = parseLineCommentKey(key)
      if (parsed.panelId !== panel.panelId) continue
      const anchor = parsed.endNumber ?? parsed.number
      const mapKey = `${parsed.side}\x1f${anchor}`
      const arr = map.get(mapKey) ?? []
      arr.push(key)
      map.set(mapKey, arr)
    }
    if (handlers.activeForm) {
      const parsed = parseLineCommentKey(handlers.activeForm)
      if (parsed.panelId === panel.panelId) {
        const anchor = parsed.endNumber ?? parsed.number
        const mapKey = `${parsed.side}\x1f${anchor}`
        const arr = map.get(mapKey) ?? []
        if (!arr.includes(handlers.activeForm)) arr.push(handlers.activeForm)
        map.set(mapKey, arr)
      }
    }
    // v5: 永続化された thread (= 前回 submit + Claude 応答) の anchor も含めて CommentRow を render する
    const threads = typeof window !== 'undefined' ? window.__reviewDiffThreads : undefined
    if (threads) {
      for (const snap of Object.values(threads)) {
        if (snap.scope.type !== 'line') continue
        if (snap.scope.panelId !== panel.panelId) continue
        const lk = lineCommentKey(snap.scope.panelId, snap.scope.side, snap.scope.line, snap.scope.endLine)
        const anchor = snap.scope.endLine ?? snap.scope.line
        const mapKey = `${snap.scope.side}\x1f${anchor}`
        const arr = map.get(mapKey) ?? []
        if (!arr.includes(lk)) arr.push(lk)
        map.set(mapKey, arr)
      }
    }
    return map
  }, [handlers.lineComments, handlers.activeForm, panel.panelId])

  return (
    <div
      className="font-mono text-xs bg-surface"
      data-panel-id={panel.panelId}
      ref={panelContainerRef}
    >
      <PanelHeader panel={panel} onCollapse={onCollapse} />
      {panel.sourcesUnavailable ? (
        <SourcesUnavailableBanner info={panel.sourcesUnavailable} />
      ) : null}
      <SplitBody
        panel={panel}
        flat={flat}
        highlight={highlight}
        commentKeysByAnchor={commentKeysByAnchor}
        handlers={handlers}
        isInDragRange={isInDragRange}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
      {/* ドラッグ中の line-snap インジケータ。`+` を hover 行の gutter 中央にスナップ表示し、
          普段の + ボタンと同じ場所で「いま範囲選択中の行」を視認化。
          perf-fix: panel-block に content-visibility: auto を当てたことで暗黙的に
          contain: paint が効き、position: fixed の containing block が panel-block に redirect されて
          中心に固定されるデグレが発生していた。createPortal で document.body 直下に逃がして
          viewport 座標で動く本来の挙動に戻す。 */}
      {dragIndicator
        ? createPortal(
            <div
              className="drag-cursor-indicator"
              aria-hidden="true"
              style={{ left: dragIndicator.left, top: dragIndicator.top }}
            >
              <Plus className="w-3 h-3" strokeWidth={3} aria-hidden="true" />
            </div>,
            document.body,
          )
        : null}
    </div>
  )
})

type RowHandlerProps = {
  isInDragRange: (side: Side, lineNumber: number | undefined) => boolean
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, side: Side, lineNumber: number) => void
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
}

type BodyProps = {
  panel: RenderedPanel
  // chunkIdx 付きで Panel から受け取る。↑↓ ジャンプの anchor として code-row に data-chunk-idx を撒く。
  flat: FlatRow[]
  highlight: boolean
  commentKeysByAnchor: Map<string, string[]>
  handlers: LineCommentHandlers
} & RowHandlerProps

// split mode body: 親 grid を 2 列に分け、各列を独立 overflow-x:auto コンテナにする。
// 各 side 内では「コードセル + その下に該当 side のコメントスレッド」を縦に積む。
// asIs コメントは左 side、toBe コメントは右 side に出る (構造上左右に紐づくので自然)。
function SplitBody({
  panel, flat, highlight, commentKeysByAnchor, handlers, ...rowProps
}: BodyProps) {
  return (
    // panel-body-split: split mode の親 2 列 grid。border-soft 色 + gap: 1px で列境界を表現。
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] bg-border-soft gap-px">
      {/*
        panel-side BEM 維持: drag-select.test.tsx が `querySelector('.cell-ln[data-side=...]')` で
        参照する側ラベル + per-side ::-webkit-scrollbar カスタム + asis/tobe scoped の line-comment-trigger
        点灯 rule + Panel.tsx 自身が `querySelector('.panel-side-asis .code-row')` で row 取得する
        contract。utility 化不可。
      */}
      <div className="panel-side panel-side-asis" data-side-container="asis">
        {/* panel-side-inner も BEM 維持: width: max-content + min-width: 100% の uniform-width row 要件 +
            sticky cell-ln の containing block が壊れない構造前提。 */}
        <div className="panel-side-inner">
          {flat.map(({ row, segmentIndex, rowIndex, isFirstOfSegment, chunkIdx }) => (
            <SideRow
              key={`asis-${segmentIndex}-${rowIndex}`}
              side="asIs"
              row={row}
              panel={panel}
              highlight={highlight}
              isFirstOfSegment={isFirstOfSegment}
              chunkIdx={chunkIdx}
              commentKeysByAnchor={commentKeysByAnchor}
              handlers={handlers}
              {...rowProps}
            />
          ))}
        </div>
      </div>
      <div className="panel-side panel-side-tobe" data-side-container="tobe">
        <div className="panel-side-inner">
          {flat.map(({ row, segmentIndex, rowIndex, isFirstOfSegment, chunkIdx }) => (
            <SideRow
              key={`tobe-${segmentIndex}-${rowIndex}`}
              side="toBe"
              row={row}
              panel={panel}
              highlight={highlight}
              isFirstOfSegment={isFirstOfSegment}
              chunkIdx={chunkIdx}
              commentKeysByAnchor={commentKeysByAnchor}
              handlers={handlers}
              {...rowProps}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// split mode 内の 1 side 1 行 + (その side の) コメント。
// 行高同期 (ResizeObserver) のために .code-row class を必ず付ける。
// chunkIdx: -1 なら context、>=0 なら chunk 内 row。code-row に data-chunk-idx として出して
// PanelHeader の prev/next ボタン + ↑↓ キーが querySelector で参照する anchor になる。
function SideRow({
  side, row, panel, highlight, isFirstOfSegment, chunkIdx,
  commentKeysByAnchor, handlers,
  isInDragRange, onPointerDown, onPointerMove, onPointerUp,
}: {
  side: Side
  row: SideBySideRow
  panel: RenderedPanel
  highlight: boolean
  isFirstOfSegment: boolean
  chunkIdx: number
  commentKeysByAnchor: Map<string, string[]>
  handlers: LineCommentHandlers
} & RowHandlerProps) {
  const lang = side === 'asIs' ? (panel.asIsLanguage ?? 'plaintext') : (panel.toBeLanguage ?? 'plaintext')
  const cell = side === 'asIs' ? row.asIs : row.toBe
  const html = useMemo(
    () => highlight ? highlightCode(cell.raw, lang) : escapeHtml(cell.raw),
    [highlight, cell.raw, lang],
  )

  const anchorKeys = cell.line != null
    ? (commentKeysByAnchor.get(`${side}\x1f${cell.line}`) ?? [])
    : []

  const inRange = isInDragRange(side, cell.line)
  const selectedClass = inRange ? ' line-selected' : ''
  const sideClass = side === 'asIs' ? 'asis' : 'tobe'

  function gutterPointerProps(lineNumber: number | undefined) {
    if (lineNumber == null) return {}
    return {
      'data-side': sideToAttr(side),
      'data-line-number': String(lineNumber),
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) =>
        onPointerDown(e, side, lineNumber),
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    }
  }
  function codeDataAttrs(lineNumber: number | undefined) {
    if (lineNumber == null) return {}
    return {
      'data-side': sideToAttr(side),
      'data-line-number': String(lineNumber),
    }
  }

  return (
    <>
      {isFirstOfSegment ? (
        <div className="h-0 border-t border-dashed border-border-soft my-1" aria-hidden="true" />
      ) : null}
      {/*
        以下の BEM は全て維持必須:
          - code-row / code-row-${sideClass} / code-row-${type} / line-selected
              → drag-select.test.tsx の closest('.code-row') と toHaveClass('line-selected') 依存 +
                addition/deletion/empty の row bg 動的合成 (globals.css の @layer components)
          - cell-ln / cell-ln-${sideClass} / cell-ln-${type}
              → test の querySelector('.cell-ln[data-side=...]') 依存 + sticky gutter + add/del 色合成
          - cell-code / cell-code-${sideClass} / cell-code-${type}
              → test の querySelector('.cell-code[data-side=...]') 依存 + Shiki pre 透過化セレクタ
        変更時はテストが落ちる + 動的合成が壊れるため、ここは BEM 文字列を直接編集してはならない。
      */}
      <div
        className={`code-row code-row-${sideClass} code-row-${cell.type}${selectedClass}`}
        {...(chunkIdx >= 0 ? { 'data-chunk-idx': String(chunkIdx) } : {})}
      >
        <div
          className={`cell-ln cell-ln-${sideClass} cell-ln-${cell.type}`}
          {...gutterPointerProps(cell.line)}
        >
          {cell.line ?? ''}
          {cell.line != null ? (
            <LineTrigger
              panelId={panel.panelId}
              side={side}
              lineNumber={cell.line}
              onOpenLineForm={handlers.onOpenLineForm}
            />
          ) : null}
          {/* v5: editor link trigger. toBe + addition 行のみ表示。
              editorAvailable は window 経由 (CR-3: command 自体は server 側のみ)。
              hover 時に gutter 右端に lucide-react の SquareArrowOutUpRight アイコンが
              fade-in する (CSS は globals.css 側に置く: Tailwind v4 cascade で opacity utility が
              :hover ルールに勝ってしまうため tsx 側に opacity-* を書かない)。 */}
          {cell.line != null && side === 'toBe' && cell.type === 'addition'
            && getEditorTarget(panel, side)
            && (typeof window !== 'undefined' && window.__reviewDiffEditorAvailable) ? (
              <EditorLinkTrigger
                file={getEditorTarget(panel, side) as string}
                line={cell.line}
              />
          ) : null}
        </div>
        <div
          className={`cell-code cell-code-${sideClass} cell-code-${cell.type}`}
          {...codeDataAttrs(cell.line)}
        >
          <pre dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
      {anchorKeys.length > 0
        ? sortAnchorKeys(anchorKeys).map((key) => (
            <CommentRow
              key={key}
              lineKey={key}
              panel={panel}
              handlers={handlers}
            />
          ))
        : null}
    </>
  )
}

function sortAnchorKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const pa = parseLineCommentKey(a)
    const pb = parseLineCommentKey(b)
    const ra = pa.endNumber != null ? 0 : 1
    const rb = pb.endNumber != null ? 0 : 1
    if (ra !== rb) return ra - rb
    return pa.number - pb.number
  })
}

// v5: panel から開く対象ファイル名を解決する。toBe 側は panel.toBe.file、asIs 側は panel.asIs.file。
function getEditorTarget(panel: RenderedPanel, side: Side): string | null {
  if (side === 'toBe') return panel.toBe?.file ?? null
  return panel.asIs?.file ?? null
}

// EditorLinkTrigger: 行右隣の余白に hover で出るリンクアイコン。click で:
//   1. clipboard に `file:line` をコピー (フォールバック保証)
//   2. POST /editor-open で server 経由で deep-link 起動 (editor preset 必須)
//   3. Toast 表示 (window.__reviewDiffShowToast)
//
// 配置: 行番号と重ならないよう、cell-ln の **外側右** (right-[-18px]) に押し出し、code 行の左頭に被せる。
// クリック競合対策: pointerdown/pointerup を stopPropagation して、gutter の drag-select / line-form
// 開始イベントに到達させない (= クリックでコメントフォームが開く問題の修正)。
// hover/focus-visible の opacity / transition は globals.css 側に書く (Tailwind v4 cascade 制約)。
function EditorLinkTrigger({ file, line }: { file: string; line: number }) {
  async function onClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const fileLine = `${file}:${line}`
    const toast = typeof window !== 'undefined' ? window.__reviewDiffShowToast : undefined
    // W-3 fix: clipboard 成否で Toast 文面を変える (失敗時に "Copied" を出すと虚偽通知になる)
    let copied = false
    try {
      await navigator.clipboard.writeText(fileLine)
      copied = true
    } catch {
      /* clipboard 拒否時 (https 必須 / permission policy 等) は copied=false のまま */
    }
    toast?.(copied ? `Copied ${fileLine}` : `Opening ${fileLine}`)
    try {
      await fetch(`/editor-open?token=${encodeURIComponent(getToken())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file, line }),
      })
    } catch {
      /* server が落ちていたり editor preset 未設定でも、clipboard コピーで人間が手動 cd できる */
    }
  }
  // pointerdown/up: gutter pointerProps の drag-select 開始ハンドラに到達させない。
  function stop(e: React.PointerEvent<HTMLButtonElement>) {
    e.stopPropagation()
  }
  return (
    <button
      type="button"
      className="editor-link-trigger absolute right-[-18px] top-1/2 -translate-y-1/2 w-4 h-4 p-0 inline-flex items-center justify-center border-0 rounded-[4px] bg-surface text-text cursor-pointer z-[3] shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
      aria-label="Open file in editor"
      title="Open in editor (copies file:line to clipboard)"
      tabIndex={0}
      onPointerDown={stop}
      onPointerUp={stop}
      onClick={onClick}
    >
      <SquareArrowOutUpRight className="w-3 h-3" strokeWidth={2.5} aria-hidden="true" />
    </button>
  )
}

function LineTrigger({
  panelId, side, lineNumber, onOpenLineForm,
}: {
  panelId: string
  side: Side
  lineNumber: number
  onOpenLineForm: LineCommentHandlers['onOpenLineForm']
}) {
  // line-comment-trigger BEM 維持: row hover scoped selector (panel-side-asis .code-row:hover .cell-ln-asis
  // .line-comment-trigger { opacity }) と body.is-dragging-line-range で display:none させる JS contract +
  // hover/focus-visible 状態の transform: scale 効果が globals.css に集約されているため。
  // 静的見た目 (絶対位置 / 形状) は utility で表現。
  //
  // opacity / transition は utility に書かない: Tailwind v4 cascade で utilities が components より
  // 優先されるため、utility に opacity-0 を書くと globals.css 側の :hover { opacity: 0.85 } が常に負ける
  // (= ホバーしても + が出ないバグ)。base opacity:0 と transition は globals.css の .line-comment-trigger
  // に書いてあるので、ここでは形だけ utility で済ませる。
  return (
    <button
      type="button"
      className="line-comment-trigger absolute left-0.5 top-1/2 -translate-y-1/2 w-4 h-4 p-0 inline-flex items-center justify-center border-0 rounded-[4px] bg-accent text-white cursor-pointer z-[2] shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
      aria-label="Add comment to this line"
      title="Add comment / drag to select range"
      onClick={(e) => {
        // キーボード Enter のみ form を開く (マウスは pointerdown/up 経由)
        if (e.detail === 0) onOpenLineForm(panelId, { side, number: lineNumber })
      }}
    >
      <Plus className="w-3 h-3" strokeWidth={3} aria-hidden="true" />
    </button>
  )
}

function CommentRow({
  lineKey, panel, handlers,
}: {
  lineKey: string
  panel: RenderedPanel
  handlers: LineCommentHandlers
}): React.ReactElement | null {
  const parsed = parseLineCommentKey(lineKey)
  const savedList = handlers.lineComments.get(lineKey)
  const hasSaved = !!savedList && savedList.length > 0
  const formOpen = handlers.activeForm === lineKey
  // v5: 永続化された thread (= 前回 submit + Claude 応答) を取得して全 message を時系列で表示する
  const threadKey = lineKeyToThreadKey(panel.panelId, parsed.side, parsed.number, parsed.endNumber)
  const persistedThread = (typeof window !== 'undefined' ? window.__reviewDiffThreads : undefined)?.[threadKey]
  const persistedMessages = persistedThread?.messages ?? []
  const hasPersisted = persistedMessages.length > 0
  if (!hasSaved && !formOpen && !hasPersisted) return null

  const label =
    parsed.endNumber != null && parsed.endNumber !== parsed.number
      ? `行 ${parsed.number}-${parsed.endNumber}`
      : `行 ${parsed.number}`

  // word-wrap (overflow-wrap: anywhere) で panel 幅を超える長文 message を強制改行する。
  // 親の comment-row は width calc で固定 (CSS)、その中の messages を breakable に。
  // overflow-hidden + min-w-0 + max-w-full で「panel-side の overflow-x: auto に flex item が
  // 横スクロールを生まないよう」固定する (CommentForm の textarea や長文 message が起点だった)。
  const thread = (
    <div
      className="flex flex-col gap-2 pl-14 pr-4 py-2.5 font-sans text-[13px] leading-[1.5] min-w-0 max-w-full overflow-hidden"
      data-side={sideToAttr(parsed.side)}
    >
      <div className="font-mono text-[11px] text-text-dim tracking-[0.04em] uppercase">{label}</div>
      {/* v5: persistedMessages を user / agent 別バブルで時系列順に表示 */}
      {persistedMessages.map((msg) => (
        <div
          key={msg.id}
          className={
            msg.author === 'agent'
              ? 'thread-message thread-message-agent border-l-[3px] border-accent bg-surface-2 rounded-r-md px-3 py-2 min-w-0 max-w-full [overflow-wrap:anywhere] [word-break:break-word]'
              : 'thread-message thread-message-user border-l-[3px] border-border bg-surface rounded-r-md px-3 py-2 min-w-0 max-w-full [overflow-wrap:anywhere] [word-break:break-word]'
          }
        >
          <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1">
            {msg.author === 'agent' ? 'Claude' : 'You'}
          </div>
          <div className="whitespace-pre-wrap">{msg.body}</div>
        </div>
      ))}
      {/* 本セッションで追加された saved comments (= 次の submit に乗る draft) */}
      {savedList?.map((body, i) => (
        <SavedComment
          key={`${lineKey}-${i}`}
          lineKey={lineKey}
          index={i}
          body={body}
          editingBody={handlers.editing.get(`${lineKey}#${i}`)}
          onStartEdit={handlers.onStartEditLineComment}
          onCancelEdit={handlers.onCancelEditLineComment}
          onSaveEdit={handlers.onSaveEditLineComment}
          onDelete={handlers.onDeleteLineComment}
        />
      ))}
      {formOpen ? (
        <CommentForm
          panelId={panel.panelId}
          side={parsed.side}
          number={parsed.number}
          endNumber={parsed.endNumber}
          onSave={(body) =>
            handlers.onAddLineComment(
              panel.panelId,
              { side: parsed.side, number: parsed.number, endNumber: parsed.endNumber },
              body,
            )
          }
          onCancel={handlers.onCloseLineForm}
        />
      ) : null}
      {/* v5: 既存スレッドがあるが入力欄が閉じている場合、Reply ボタンを 1 つ置く (= 自然に返信を続けられる) */}
      {hasPersisted && !formOpen ? (
        <button
          type="button"
          className="self-start mt-1 px-2.5 py-1 text-[11.5px] text-text-muted border border-border rounded-md hover:bg-surface-2 cursor-pointer"
          onClick={() => handlers.onOpenLineForm(panel.panelId, { side: parsed.side, number: parsed.number, endNumber: parsed.endNumber })}
        >
          Reply
        </button>
      ) : null}
    </div>
  )

  // v5: comment-row は CSS で position: sticky left: 0 で panel-side の visible 左端に固定。
  // (= globals.css の .comment-row、panel-block / group-section の content-visibility 撤去とセット)
  return (
    <div className="comment-row" data-comment-side={sideToAttr(parsed.side)}>
      <div className="p-0">{thread}</div>
    </div>
  )
}

// I-4: panel source unavailable のバナー。kind に応じて文言を変える。
function SourcesUnavailableBanner({ info }: { info: NonNullable<RenderedPanel['sourcesUnavailable']> }) {
  const text = info.kind === 'pr-fetch-failed'
    ? 'Source unavailable: PR base/head fetch failed (gh CLI auth or PR closed?).'
    : 'Source unavailable: panel file not found in working tree (AI may have mis-typed the file path in summary.json).'
  const sides: string[] = []
  if (info.asIs) sides.push('asIs')
  if (info.toBe) sides.push('toBe')
  const detail = sides.length > 0 ? ` Affected side: ${sides.join(' + ')}.` : ''
  return (
    // sources-unavailable-banner BEM 維持: [data-kind="unknown-file"] の attribute selector で色切替する rule が
    // globals.css にあるため。base 色 (赤系) のみ utility で表現し、yellow への切替は selector に任せる。
    <div
      className="sources-unavailable-banner flex items-center gap-2.5 px-3.5 py-2.5 bg-[rgba(248,113,113,0.08)] border-b border-[rgba(248,113,113,0.25)] text-text text-xs leading-[1.5]"
      role="status"
      data-kind={info.kind}
    >
      <span className="text-sm shrink-0" aria-hidden="true">⚠</span>
      <span className="text-text-muted">{text}{detail}</span>
    </div>
  )
}

function SavedComment({
  lineKey, index, body, editingBody,
  onStartEdit, onCancelEdit, onSaveEdit, onDelete,
}: {
  lineKey: string
  index: number
  body: string
  editingBody: string | undefined
  onStartEdit: (key: string, index: number, body: string) => void
  onCancelEdit: (key: string, index: number) => void
  onSaveEdit: (key: string, index: number, body: string) => void
  onDelete: (key: string, index: number) => void
}) {
  const isEditing = editingBody !== undefined
  const [draft, setDraft] = useState(editingBody ?? body)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (isEditing) {
      setDraft(editingBody ?? body)
      ref.current?.focus()
    }
  }, [isEditing, editingBody, body])

  // comment-bubble BEM 維持: `:hover .comment-actions { opacity: 1 }` 起動の scope selector が
  // globals.css にある + is-editing は外側からの状態指定 hook 用に残す (現在は padding 切替に使用)。
  if (isEditing) {
    return (
      <div className="comment-bubble is-editing relative bg-surface border border-border-soft rounded-lg px-3 py-2.5 text-text text-[13px]">
        <textarea
          ref={ref}
          className="w-full min-h-[70px] resize-none overflow-y-auto field-sizing-content bg-background text-text border border-border rounded-md px-2.5 py-2 font-sans text-[13px] leading-[1.5] outline-none transition-colors duration-100 focus:border-accent"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              onSaveEdit(lineKey, index, draft)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancelEdit(lineKey, index)
            }
          }}
        />
        <div className="flex justify-end gap-1.5 mt-2">
          <button
            type="button"
            className="px-3 py-1 border border-border rounded-md text-xs font-medium font-sans cursor-pointer bg-transparent text-text-muted hover:bg-surface-3 hover:text-text transition-colors duration-100"
            onClick={() => onCancelEdit(lineKey, index)}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="px-3 py-1 border border-accent bg-accent rounded-md text-xs font-medium font-sans cursor-pointer text-white hover:brightness-[1.08] transition-[filter,background] duration-100"
            onClick={() => onSaveEdit(lineKey, index, draft)}
          >
            保存
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="comment-bubble relative bg-surface border border-border-soft rounded-lg px-4 py-3 text-text text-[13px]">
      <div className="whitespace-pre-wrap break-words">{body}</div>
      {/* comment-actions BEM 維持: comment-bubble:hover/focus-within で opacity を 1 に切り替える
          scope selector が globals.css にあるため。base の opacity:0 と placement は utility で表現。 */}
      <div className="comment-actions absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-100">
        <button
          type="button"
          className="bg-transparent border border-border text-text-muted text-[11px] px-2 py-0.5 rounded-[5px] cursor-pointer font-sans transition-colors duration-100 hover:bg-surface-3 hover:text-text"
          onClick={() => onStartEdit(lineKey, index, body)}
        >
          編集
        </button>
        <button
          type="button"
          className="bg-transparent border border-border text-text-muted text-[11px] px-2 py-0.5 rounded-[5px] cursor-pointer font-sans transition-colors duration-100 hover:text-danger hover:border-[rgba(248,113,113,0.4)]"
          onClick={() => {
            if (confirm('このコメントを削除しますか？')) onDelete(lineKey, index)
          }}
        >
          削除
        </button>
      </div>
    </div>
  )
}
