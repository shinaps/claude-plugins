// 1 Panel = 1 <table> でレンダリングするコンポーネント。
//
// 設計判断:
//   - AC-6 (panel 跨ぎコメント不可) を構造的に担保するため、各 panel が独立した <table> + ref を持ち、
//     pointermove 中の elementFromPoint で取得した td を panelTableRef.contains(cell) で
//     scope チェックする。別 panel のセルは即 null 化される。
//   - split / unified モード切替は colgroup を切り替えるだけで row 構造は維持。
//     split: gutter(asIs) | code(asIs) | gutter(toBe) | code(toBe)  4 列
//     unified: gutter(asIs+toBe) | gutter(toBe) | code  3 列 (左右 2 つの行番号セル + 1 つのコード列)
//       実装上は同じ <tr> に asIs/toBe の line セルを左に並べ、code は toBe 優先で出す。
//   - DOM data 属性は shared/sideToAttr で 'asis'/'tobe' に統一 (既存 data-line-number と整合)。
//   - LineCommentHandlers は panelId 単位で thread を管理する。
//   - sortAnchorKeys: 範囲 → 単一の順、で並べる (旧 DiffTable と同じ UX)。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  const panelTableRef = useRef<HTMLTableElement>(null)
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
  function resolveLineAtPoint(
    clientX: number, clientY: number, expectSide: Side,
  ): number | null {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    if (!el) return null
    const cell = el.closest('td[data-side]') as HTMLElement | null
    if (!cell) return null
    // panelTableRef.contains で AC-6 構造的担保: 別 panel の cell は無視
    if (panelTableRef.current && !panelTableRef.current.contains(cell)) return null
    const sideAttr = cell.dataset.side
    const side = sideAttr ? attrToSide(sideAttr) : null
    const num = cell.dataset.lineNumber
    if (!side || side !== expectSide || !num) return null
    const n = Number(num)
    return Number.isFinite(n) ? n : null
  }

  function handlePointerDown(
    e: React.PointerEvent<HTMLTableCellElement>,
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

  function handlePointerMove(e: React.PointerEvent<HTMLTableCellElement>) {
    const cur = dragRef.current
    if (!cur) return
    const next = resolveLineAtPoint(e.clientX, e.clientY, cur.side)
    if (next == null || next === cur.currentNumber) return
    setDragBoth({ ...cur, currentNumber: next })
  }

  function handlePointerUp(e: React.PointerEvent<HTMLTableCellElement>) {
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
    <div className="panel" data-panel-id={panel.panelId}>
      <PanelHeader panel={panel} mode={mode} onToggle={toggle} />
      <div className="panel-body">
        <table
          ref={panelTableRef}
          className={`panel-table panel-table-${mode}`}
          data-panel-id={panel.panelId}
        >
          {mode === 'split' ? (
            <colgroup>
              <col style={{ width: 52 }} />
              <col style={{ width: 'calc((100% - 104px) / 2)' }} />
              <col style={{ width: 52 }} />
              <col style={{ width: 'calc((100% - 104px) / 2)' }} />
            </colgroup>
          ) : (
            <colgroup>
              <col style={{ width: 52 }} />
              <col style={{ width: 52 }} />
              <col style={{ width: 'calc(100% - 104px)' }} />
            </colgroup>
          )}
          {panel.segments.map((seg, si) => (
            <tbody key={`seg-${si}`} className="panel-segment">
              {seg.rows.map((row, ri) => (
                <RowAndComments
                  key={`r-${si}-${ri}`}
                  row={row}
                  mode={mode}
                  panel={panel}
                  highlight={highlight}
                  isInDragRange={isInDragRange}
                  onLinePointerDown={handlePointerDown}
                  onLinePointerMove={handlePointerMove}
                  onLinePointerUp={handlePointerUp}
                  commentKeysByAnchor={commentKeysByAnchor}
                  handlers={handlers}
                />
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  )
})

// 1 行 + その行をアンカーとする comment thread / form を 1 セットで出す。
function RowAndComments({
  row, mode, panel, highlight,
  isInDragRange, onLinePointerDown, onLinePointerMove, onLinePointerUp,
  commentKeysByAnchor, handlers,
}: {
  row: SideBySideRow
  mode: 'split' | 'unified'
  panel: RenderedPanel
  highlight: boolean
  isInDragRange: (side: Side, lineNumber: number | undefined) => boolean
  onLinePointerDown: (e: React.PointerEvent<HTMLTableCellElement>, side: Side, lineNumber: number) => void
  onLinePointerMove: (e: React.PointerEvent<HTMLTableCellElement>) => void
  onLinePointerUp: (e: React.PointerEvent<HTMLTableCellElement>) => void
  commentKeysByAnchor: Map<string, string[]>
  handlers: LineCommentHandlers
}) {
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
  const rowSelectedClass = asIsInRange || toBeInRange ? ' line-selected' : ''

  function gutterPointerProps(side: Side, lineNumber: number | undefined) {
    if (lineNumber == null) return {}
    return {
      'data-side': sideToAttr(side),
      'data-line-number': String(lineNumber),
      onPointerDown: (e: React.PointerEvent<HTMLTableCellElement>) =>
        onLinePointerDown(e, side, lineNumber),
      onPointerMove: onLinePointerMove,
      onPointerUp: onLinePointerUp,
      onPointerCancel: onLinePointerUp,
    }
  }
  function codeDataAttrs(side: Side, lineNumber: number | undefined) {
    if (lineNumber == null) return {}
    return {
      'data-side': sideToAttr(side),
      'data-line-number': String(lineNumber),
    }
  }

  return (
    <>
      <tr className={`code-row${rowSelectedClass}`}>
        {/* asIs gutter */}
        <td
          className={`ln ln-asis ln-${row.asIs.type}`}
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
        </td>
        {mode === 'split' ? (
          <>
            <td
              className={`code code-asis code-${row.asIs.type}`}
              {...codeDataAttrs('asIs', row.asIs.line)}
            >
              <pre dangerouslySetInnerHTML={{ __html: asIsHtml }} />
            </td>
            <td
              className={`ln ln-tobe ln-${row.toBe.type}`}
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
            </td>
            <td
              className={`code code-tobe code-${row.toBe.type}`}
              {...codeDataAttrs('toBe', row.toBe.line)}
            >
              <pre dangerouslySetInnerHTML={{ __html: toBeHtml }} />
            </td>
          </>
        ) : (
          // unified: asIs gutter + toBe gutter + 単一コード列。
          // 表示行は asIs (deletion) / toBe (addition) / context のうち、片側に line がある方を
          // メインで出す。両側 context なら toBeLanguage で highlight した toBeHtml を表示する。
          <>
            <td
              className={`ln ln-tobe ln-${row.toBe.type}`}
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
            </td>
            <td
              className={
                row.toBe.type !== 'empty'
                  ? `code code-tobe code-${row.toBe.type}`
                  : `code code-asis code-${row.asIs.type}`
              }
              {...(row.toBe.type !== 'empty'
                ? codeDataAttrs('toBe', row.toBe.line)
                : codeDataAttrs('asIs', row.asIs.line))}
            >
              <pre dangerouslySetInnerHTML={{
                __html: row.toBe.type !== 'empty' ? toBeHtml : asIsHtml,
              }} />
            </td>
          </>
        )}
      </tr>
      {anchorKeys.length > 0
        ? sortAnchorKeys(anchorKeys).map(key => (
            <CommentRow
              key={key}
              lineKey={key}
              panel={panel}
              handlers={handlers}
              mode={mode}
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

  // split: 4 列 (asIs gutter + asIs code + toBe gutter + toBe code)。
  // unified: 3 列 (asIs gutter + toBe gutter + code)。
  // どちらでも「asIs 側に thread / toBe 側に空」または「asIs 側に空 / toBe 側に thread」を 1 行で出す。
  const colsAsIs = mode === 'split' ? 2 : 1
  const colsToBe = mode === 'split' ? 2 : 2
  return (
    <tr className="comment-row" data-comment-side={sideToAttr(parsed.side)}>
      {parsed.side === 'asIs' ? (
        <>
          <td colSpan={colsAsIs} className="comment-cell">{thread}</td>
          <td colSpan={colsToBe} className="comment-cell comment-cell-empty" />
        </>
      ) : (
        <>
          <td colSpan={colsAsIs} className="comment-cell comment-cell-empty" />
          <td colSpan={colsToBe} className="comment-cell">{thread}</td>
        </>
      )}
    </tr>
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
