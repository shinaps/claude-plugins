// 1 Panel = 1 CSS Grid (div ベース) でレンダリングするコンポーネント (v4.8.0 split only)。
//
// 設計判断 (v4.7.1 grid refactor → v4.8.0 unified mode 廃止):
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
//   - v4.8.0 で unified mode (単一カラム) を撤去。理由: split mode 一本化で UI 学習コストを下げ、
//     mode toggle に必要だった localStorage / mode toggle button / comment-side-badge も削減できた。
//   - AC-6 (panel 跨ぎコメント不可): panelContainerRef.contains(cell) で構造的に担保。
//     セレクタは `closest('[data-side][data-line-number]')` に統一 (td/div どちらでも動く)。
//   - LineCommentHandlers は panelId 単位で thread を管理する。
//   - sortAnchorKeys: 範囲 → 単一の順、で並べる (旧 DiffTable と同じ UX)。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RenderedPanel, SideBySideRow, Side } from '@zeus/review-diff-shared'
import { sideToAttr, attrToSide } from '@zeus/review-diff-shared'
import { parseLineCommentKey } from './state'
import type { LineCommentHandlers } from './useLineComments'
import { PanelHeader } from './PanelHeader'
import { CommentForm } from './CommentForm'
import { createShiki } from './shiki-bundle'

const SHIKI = createShiki()
const CLICK_THRESHOLD_MS = 200

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
  // v4.12.0 (refinement): PanelHeader 右に Hide diff ボタンを出すための callback。
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
      // パフォーマンス最適化 (v4.12.0): display:none / content-visibility:hidden 中は offsetHeight=0 になり
      // 全 row に minHeight=0 を書く副作用を避けるため、最初の 1 行だけ probe して skip 判定。
      // ResizeObserver は display:none 復帰時に「全 row が 0→実サイズ」の遷移で一斉発火するため、
      // 非表示中の sync 呼出をスキップすれば LoAF で計測された forced-layout 3.1 秒級の主犯を抑制できる。
      if (leftRows[0].offsetHeight === 0 && rightRows[0].offsetHeight === 0) return

      // パフォーマンス最適化 (v4.12.0): read / write を 3-pass に厳密分離して forced sync layout を
      // N 回 → 1 回に削減する。元実装は loop 内で `offsetHeight` 直後に `style.minHeight` を書いていたため、
      // 各 row で layout が強制フラッシュされ N 行 = N 回の reflow になっていた (28 panel × 数千 row = 6 秒)。
      //   Pass 1: 全 row の minHeight を '' にして natural サイズに戻す (layout 無効化のみ)
      //   Pass 2: 全 row の offsetHeight を一括 read (このタイミングで layout が 1 回だけフラッシュ)
      //   Pass 3: 全 row に新しい minHeight を一括 write (layout 無効化のみ)
      for (let i = 0; i < n; i++) {
        leftRows[i].style.minHeight = ''
        rightRows[i].style.minHeight = ''
      }
      const heights: number[] = new Array(n)
      for (let i = 0; i < n; i++) {
        heights[i] = Math.max(leftRows[i].offsetHeight, rightRows[i].offsetHeight)
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

  // 左右スクロール同期: per-side が独立 overflow-x:auto なので、片側を横スクロールすると
  // 反対側は動かない。ユーザー要望で「赤と緑のスクロールが同期」= 1 panel 内では
  // asIs / toBe の scrollLeft が常に一致するべき。双方向 mirror で sync する。
  //
  // パフォーマンス最適化 (v4.12.0): 旧実装は `syncing` フラグで再帰防止していたが、連続スクロール時に
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
    document.body.classList.add('is-dragging-line-range')
    function onMove(e: PointerEvent) {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      if (!el) return
      const cell = el.closest('[data-side][data-line-number]') as HTMLElement | null
      if (!cell || !panelContainerRef.current?.contains(cell)) return
      // 同じ row の cell-ln (gutter) を取得して位置を決定 (cell-code から hover してても gutter 位置に出す)
      const row = cell.closest('.code-row') as HTMLElement | null
      if (!row) return
      const ln = row.querySelector('.cell-ln') as HTMLElement | null
      if (!ln) return
      const lnRect = ln.getBoundingClientRect()
      // gutter 内の + ボタンと同じ位置: 左端 + 9px (line-comment-trigger の left:2px + ボタン中心)
      setDragIndicator({
        left: lnRect.left + 9,
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
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    if (!el) return null
    const cell = el.closest('[data-side][data-line-number]') as HTMLElement | null
    if (!cell) return null
    // panelContainerRef.contains で AC-6 構造的担保: 別 panel の cell は無視
    if (panelContainerRef.current && !panelContainerRef.current.contains(cell)) return null
    const sideAttr = cell.dataset.side
    const side = sideAttr ? attrToSide(sideAttr) : null
    const num = cell.dataset.lineNumber
    if (!side || side !== expectSide || !num) return null
    const n = Number(num)
    return Number.isFinite(n) ? n : null
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
          v4.12.0 perf-fix: panel-block に content-visibility: auto を当てたことで暗黙的に
          contain: paint が効き、position: fixed の containing block が panel-block に redirect されて
          中心に固定されるデグレが発生していた。createPortal で document.body 直下に逃がして
          viewport 座標で動く本来の挙動に戻す。 */}
      {dragIndicator
        ? createPortal(
            <div
              className="drag-cursor-indicator"
              aria-hidden="true"
              style={{ left: dragIndicator.left, top: dragIndicator.top }}
            >+</div>,
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
  highlight: boolean
  commentKeysByAnchor: Map<string, string[]>
  handlers: LineCommentHandlers
} & RowHandlerProps

// split mode body: 親 grid を 2 列に分け、各列を独立 overflow-x:auto コンテナにする。
// 各 side 内では「コードセル + その下に該当 side のコメントスレッド」を縦に積む。
// asIs コメントは左 side、toBe コメントは右 side に出る (構造上左右に紐づくので自然)。
function SplitBody({
  panel, highlight, commentKeysByAnchor, handlers, ...rowProps
}: BodyProps) {
  // 全 row を flatten。segment 区切りは divider 行で表現。
  const flat: Array<{ row: SideBySideRow; segmentIndex: number; rowIndex: number; isFirstOfSegment: boolean }> = []
  panel.segments.forEach((seg, si) => {
    seg.rows.forEach((row, ri) => {
      flat.push({ row, segmentIndex: si, rowIndex: ri, isFirstOfSegment: ri === 0 && si > 0 })
    })
  })
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
          {flat.map(({ row, segmentIndex, rowIndex, isFirstOfSegment }) => (
            <SideRow
              key={`asis-${segmentIndex}-${rowIndex}`}
              side="asIs"
              row={row}
              panel={panel}
              highlight={highlight}
              isFirstOfSegment={isFirstOfSegment}
              commentKeysByAnchor={commentKeysByAnchor}
              handlers={handlers}
              {...rowProps}
            />
          ))}
        </div>
      </div>
      <div className="panel-side panel-side-tobe" data-side-container="tobe">
        <div className="panel-side-inner">
          {flat.map(({ row, segmentIndex, rowIndex, isFirstOfSegment }) => (
            <SideRow
              key={`tobe-${segmentIndex}-${rowIndex}`}
              side="toBe"
              row={row}
              panel={panel}
              highlight={highlight}
              isFirstOfSegment={isFirstOfSegment}
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
function SideRow({
  side, row, panel, highlight, isFirstOfSegment,
  commentKeysByAnchor, handlers,
  isInDragRange, onPointerDown, onPointerMove, onPointerUp,
}: {
  side: Side
  row: SideBySideRow
  panel: RenderedPanel
  highlight: boolean
  isFirstOfSegment: boolean
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
      <div className={`code-row code-row-${sideClass} code-row-${cell.type}${selectedClass}`}>
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
      className="line-comment-trigger absolute left-0.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 p-0 inline-flex items-center justify-center border-0 rounded-[4px] bg-accent text-white text-[11px] font-bold leading-none cursor-pointer z-[2] shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
      aria-label="Add comment to this line"
      title="Add comment / drag to select range"
      onClick={(e) => {
        // キーボード Enter のみ form を開く (マウスは pointerdown/up 経由)
        if (e.detail === 0) onOpenLineForm(panelId, { side, number: lineNumber })
      }}
    >
      +
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
  if (!hasSaved && !formOpen) return null

  const label =
    parsed.endNumber != null && parsed.endNumber !== parsed.number
      ? `行 ${parsed.number}-${parsed.endNumber}`
      : `行 ${parsed.number}`

  const thread = (
    <div
      className="flex flex-col gap-2 pl-14 pr-4 py-2.5 font-sans text-[13px] leading-[1.5]"
      data-side={sideToAttr(parsed.side)}
    >
      <div className="font-mono text-[11px] text-text-dim tracking-[0.04em] uppercase">{label}</div>
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
    </div>
  )

  // comment row は該当 side の scroll container 内 (SideRow の兄弟) として出される。
  // 親の panel-side が overflow-x:auto なので、コメントは side 幅 (panel の左 or 右半分) に
  // フィットして表示される。横スクロールはコード行と共有。
  //
  // comment-row BEM 維持: width calc が `(100vw - var(--nav-width) - 48px) / 2 - 1px` で
  // dynamic CSS var を含む。utility 化すると arbitrary value がきわめて読みにくくなる。
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
          className="w-full min-h-[70px] bg-background text-text border border-border rounded-md px-2.5 py-2 font-sans text-[13px] leading-[1.5] resize-y outline-none transition-colors duration-100 focus:border-accent"
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
