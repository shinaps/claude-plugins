// 1 Panel = 1 CSS Grid (div ベース) でレンダリングするコンポーネント。
//
// 設計判断 (v4.7.1 grid refactor):
//   - 旧 <table> 構造では「左右独立横スクロール + 50/50 + 行高同期」が CSS 仕様上同時充足
//     不可能だった (table cell は per-cell scroll しか出来ず、列方向の cell 群を 1 つの scroll
//     viewport に束ねる box が CSS table model に存在しない)。
//     対症療法 (table-layout fixed/auto、useLayoutEffect で table.style.width 実測など 4 回試行)
//     はすべて根本的に解決不能だったため、DOM 構造そのものを div + CSS Grid に置換した。
//   - split mode: panel-grid を 2 列 (asIs side + toBe side) で構成。
//     各 side は独立した overflow-x:auto コンテナで、その中で gutter + code を縦に積む。
//     これにより「左右独立 1 スクロールバー」+「per-side blowout 防止 (minmax(0, 1fr))」を構造的に達成。
//   - 行高同期: ResizeObserver で各 side の同一インデックス .code-row の offsetHeight max を
//     min-height として書き戻す JS 同期方式。
//     subgrid は同一 scroll container 内でしか機能しないため per-side scroll と排他。
//   - unified mode: 単一カラム (gutter asIs + gutter toBe + code 1 列) の grid。
//     左右 scroll 分割は不要なので panel-side wrapper は無い。
//   - AC-6 (panel 跨ぎコメント不可): panelContainerRef.contains(cell) で構造的に担保。
//     セレクタは `closest('[data-side][data-line-number]')` に統一 (td/div どちらでも動く)。
//   - LineCommentHandlers は panelId 単位で thread を管理する。
//   - sortAnchorKeys: 範囲 → 単一の順、で並べる (旧 DiffTable と同じ UX)。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RenderedPanel, SideBySideRow, Side } from '@zeus/review-diff-shared'
import { sideToAttr, attrToSide } from '@zeus/review-diff-shared'
import { lineCommentKey, parseLineCommentKey } from './state'
import type { LineCommentHandlers } from './useLineComments'
import { usePanelToggle } from './usePanelToggle'
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
} & LineCommentHandlers

export const Panel = memo(function Panel({
  panel,
  highlight = true,
  ...handlers
}: PanelProps) {
  const { mode, toggle } = usePanelToggle(panel.panelId)
  const [drag, setDrag] = useState<DragState>(null)
  const dragRef = useRef<DragState>(null)
  // 旧 panelTableRef → panelContainerRef。div ベースに変わったので HTMLDivElement で受ける。
  // resolveLineAtPoint の AC-6 scope check (別 panel の cell を弾く) で使用。
  const panelContainerRef = useRef<HTMLDivElement>(null)

  // 行高同期 (split mode のみ): per-side scroll container が分かれた結果、左右で行高がズレる
  // (例: 左 side のみ wrap して高さが伸びるケース)。subgrid なら親 grid 内で自動的に揃うが、
  // 本実装では左右が別 scroll container なので subgrid が使えない。
  // ResizeObserver で各 .code-row を観測し、両 side の同一インデックス行の offsetHeight max を
  // min-height として書き戻して同期する。requestAnimationFrame で coalesce してレイアウト
  // スラッシングを防ぐ。
  useLayoutEffect(() => {
    if (mode !== 'split') return
    const container = panelContainerRef.current
    if (!container) return
    let raf = 0
    const sync = () => {
      raf = 0
      // 案 F: .code-row が box を持つので row 単位で観測 + min-height を当てる (cell 単位より単純)。
      const leftRows = container.querySelectorAll<HTMLElement>('.panel-side-asis .code-row')
      const rightRows = container.querySelectorAll<HTMLElement>('.panel-side-tobe .code-row')
      const n = Math.min(leftRows.length, rightRows.length)
      for (let i = 0; i < n; i++) {
        leftRows[i].style.minHeight = ''
        rightRows[i].style.minHeight = ''
      }
      for (let i = 0; i < n; i++) {
        const h = Math.max(leftRows[i].offsetHeight, rightRows[i].offsetHeight)
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
  }, [panel.segments, mode])

  // 左右スクロール同期 (split mode のみ): per-side が独立 overflow-x:auto なので、
  // 片側を横スクロールすると反対側は動かない。ユーザー要望で「赤と緑のスクロールが同期」
  // = 1 panel 内では asIs / toBe の scrollLeft が常に一致するべき。
  // 双方向 mirror で sync する。リエントラント防止のため flag で再帰呼び出しを抑止。
  useLayoutEffect(() => {
    if (mode !== 'split') return
    const container = panelContainerRef.current
    if (!container) return
    const asis = container.querySelector<HTMLElement>('.panel-side-asis')
    const tobe = container.querySelector<HTMLElement>('.panel-side-tobe')
    if (!asis || !tobe) return
    let syncing = false
    const mirror = (src: HTMLElement, dst: HTMLElement) => () => {
      if (syncing) return
      syncing = true
      dst.scrollLeft = src.scrollLeft
      // 次フレームで flag を下ろす (scroll event がもう一方から発火し終わるのを待つ)
      requestAnimationFrame(() => { syncing = false })
    }
    const onAsis = mirror(asis, tobe)
    const onTobe = mirror(tobe, asis)
    asis.addEventListener('scroll', onAsis, { passive: true })
    tobe.addEventListener('scroll', onTobe, { passive: true })
    return () => {
      asis.removeEventListener('scroll', onAsis)
      tobe.removeEventListener('scroll', onTobe)
    }
  }, [mode])

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

  function isInDragRange(side: Side, lineNumber: number | undefined): boolean {
    if (!drag || lineNumber == null) return false
    if (drag.side !== side) return false
    const lo = Math.min(drag.startNumber, drag.currentNumber)
    const hi = Math.max(drag.startNumber, drag.currentNumber)
    return lineNumber >= lo && lineNumber <= hi
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
      className={`panel-grid panel-grid-${mode}`}
      data-panel-id={panel.panelId}
      ref={panelContainerRef}
    >
      <PanelHeader panel={panel} mode={mode} onToggle={toggle} />
      {panel.sourcesUnavailable ? (
        <SourcesUnavailableBanner info={panel.sourcesUnavailable} />
      ) : null}
      {mode === 'split' ? (
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
      ) : (
        <UnifiedBody
          panel={panel}
          highlight={highlight}
          commentKeysByAnchor={commentKeysByAnchor}
          handlers={handlers}
          isInDragRange={isInDragRange}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      )}
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
    <div className="panel-body panel-body-split">
      <div className="panel-side panel-side-asis" data-side-container="asis">
        {/* panel-side-inner で width: max-content + min-width: 100% を持たせ、内側 row 全行が
            同じ width (= widest cell)。これで全行で bg paint area が揃い、sticky の containing
            block が安定 (panel-side が scroll container、inner がその子で flex row を縦に積む)。 */}
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
      {isFirstOfSegment ? <div className="panel-segment-divider" aria-hidden="true" /> : null}
      {/* row 自身に cell.type (context/addition/deletion/empty) のクラスも持たせ、row 単位で bg を
          塗る (案 F: display: contents 廃止、min-width: max-content の row 全幅で bg paint area が
          確実に row 物理幅まで広がる)。display: contents だと paint area が viewport 幅で
          クリップされる Chromium 挙動を回避。 */}
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
              mode="split"
            />
          ))
        : null}
    </>
  )
}

// unified mode body: 単一 scroll container、3 列 grid (asIs gutter + toBe gutter + code)。
// 表示行は asIs (deletion) / toBe (addition) / context のうち、片側に line がある方を
// メインで出す。両側 context なら toBe を表示。
function UnifiedBody({
  panel, highlight, commentKeysByAnchor, handlers,
  isInDragRange, onPointerDown, onPointerMove, onPointerUp,
}: BodyProps) {
  return (
    <div className="panel-body panel-body-unified">
      {panel.segments.map((seg, si) => (
        <div className="panel-segment" key={`seg-${si}`}>
          {seg.rows.map((row, ri) => (
            <UnifiedRow
              key={`r-${si}-${ri}`}
              row={row}
              panel={panel}
              highlight={highlight}
              commentKeysByAnchor={commentKeysByAnchor}
              handlers={handlers}
              isInDragRange={isInDragRange}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function UnifiedRow({
  row, panel, highlight, commentKeysByAnchor, handlers,
  isInDragRange, onPointerDown, onPointerMove, onPointerUp,
}: {
  row: SideBySideRow
  panel: RenderedPanel
  highlight: boolean
  commentKeysByAnchor: Map<string, string[]>
  handlers: LineCommentHandlers
} & RowHandlerProps) {
  const asIsLang = panel.asIsLanguage ?? 'plaintext'
  const toBeLang = panel.toBeLanguage ?? 'plaintext'
  const asIsHtml = useMemo(
    () => highlight ? highlightCode(row.asIs.raw, asIsLang) : escapeHtml(row.asIs.raw),
    [highlight, row.asIs.raw, asIsLang],
  )
  const toBeHtml = useMemo(
    () => highlight ? highlightCode(row.toBe.raw, toBeLang) : escapeHtml(row.toBe.raw),
    [highlight, row.toBe.raw, toBeLang],
  )

  const asIsAnchor = row.asIs.line != null
    ? commentKeysByAnchor.get(`asIs\x1f${row.asIs.line}`) ?? [] : []
  const toBeAnchor = row.toBe.line != null
    ? commentKeysByAnchor.get(`toBe\x1f${row.toBe.line}`) ?? [] : []
  const anchorKeys = [...asIsAnchor, ...toBeAnchor]

  const asIsInRange = isInDragRange('asIs', row.asIs.line)
  const toBeInRange = isInDragRange('toBe', row.toBe.line)
  const selectedClass = asIsInRange || toBeInRange ? ' line-selected' : ''

  function gutterPointerProps(side: Side, lineNumber: number | undefined) {
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
  function codeDataAttrs(side: Side, lineNumber: number | undefined) {
    if (lineNumber == null) return {}
    return {
      'data-side': sideToAttr(side),
      'data-line-number': String(lineNumber),
    }
  }

  const showToBe = row.toBe.type !== 'empty'
  const codeSide: Side = showToBe ? 'toBe' : 'asIs'
  const codeCell = showToBe ? row.toBe : row.asIs
  const codeSideClass = codeSide === 'asIs' ? 'asis' : 'tobe'
  const codeHtml = showToBe ? toBeHtml : asIsHtml

  return (
    <>
      <div className={`code-row code-row-unified code-row-${codeCell.type}${selectedClass}`}>
        <div
          className={`cell-ln cell-ln-asis cell-ln-${row.asIs.type}`}
          {...gutterPointerProps('asIs', row.asIs.line)}
        >
          {row.asIs.line ?? ''}
          {row.asIs.line != null ? (
            <LineTrigger
              panelId={panel.panelId}
              side="asIs"
              lineNumber={row.asIs.line}
              onOpenLineForm={handlers.onOpenLineForm}
            />
          ) : null}
        </div>
        <div
          className={`cell-ln cell-ln-tobe cell-ln-${row.toBe.type}`}
          {...gutterPointerProps('toBe', row.toBe.line)}
        >
          {row.toBe.line ?? ''}
          {row.toBe.line != null ? (
            <LineTrigger
              panelId={panel.panelId}
              side="toBe"
              lineNumber={row.toBe.line}
              onOpenLineForm={handlers.onOpenLineForm}
            />
          ) : null}
        </div>
        <div
          className={`cell-code cell-code-${codeSideClass} cell-code-${codeCell.type}`}
          {...codeDataAttrs(codeSide, codeCell.line)}
        >
          <pre dangerouslySetInnerHTML={{ __html: codeHtml }} />
        </div>
      </div>
      {anchorKeys.length > 0
        ? sortAnchorKeys(anchorKeys).map(key => (
            <CommentRow
              key={key}
              lineKey={key}
              panel={panel}
              handlers={handlers}
              mode="unified"
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
  return (
    <button
      type="button"
      className="line-comment-trigger"
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
  lineKey, panel, handlers, mode,
}: {
  lineKey: string
  panel: RenderedPanel
  handlers: LineCommentHandlers
  mode: 'split' | 'unified'
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
    <div className="comment-thread" data-side={sideToAttr(parsed.side)}>
      <div className="comment-thread-header">{label}</div>
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

  // split mode: comment row は該当 side の scroll container 内 (SideRow の兄弟) として出される。
  //   親の panel-side が overflow-x:auto なので、コメントは side 幅 (panel の左 or 右半分) に
  //   フィットして表示される。横スクロールはコード行と共有。
  // unified mode: 1 column 全幅。W-2 で追加した comment-thread-unified + side バッジで
  //   「どちら側に対するコメントか」を視覚的に明示する。
  if (mode === 'unified') {
    return (
      <div className="comment-row comment-row-unified" data-comment-side={sideToAttr(parsed.side)}>
        <div className="comment-cell">
          <div className="comment-thread-unified">
            <span
              className="comment-side-badge"
              data-side={sideToAttr(parsed.side)}
              aria-label={parsed.side === 'asIs' ? 'as-is side comment' : 'to-be side comment'}
            >
              {parsed.side === 'asIs' ? 'asIs' : 'toBe'}
            </span>
            {thread}
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="comment-row comment-row-split" data-comment-side={sideToAttr(parsed.side)}>
      <div className="comment-cell">{thread}</div>
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
    <div className="sources-unavailable-banner" role="status" data-kind={info.kind}>
      <span className="sources-unavailable-icon" aria-hidden="true">⚠</span>
      <span className="sources-unavailable-text">{text}{detail}</span>
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

  if (isEditing) {
    return (
      <div className="comment-bubble is-editing">
        <textarea
          ref={ref}
          className="comment-textarea"
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
        <div className="comment-form-actions">
          <button
            type="button"
            className="comment-btn comment-btn-cancel"
            onClick={() => onCancelEdit(lineKey, index)}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="comment-btn comment-btn-save"
            onClick={() => onSaveEdit(lineKey, index, draft)}
          >
            保存
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="comment-bubble">
      <div className="comment-body">{body}</div>
      <div className="comment-actions">
        <button
          type="button"
          className="comment-action-btn"
          onClick={() => onStartEdit(lineKey, index, body)}
        >
          編集
        </button>
        <button
          type="button"
          className="comment-action-btn comment-action-danger"
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
