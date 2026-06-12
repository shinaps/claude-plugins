// unified mode body (単一カラム diff)。768px 以下 (= split の各列が物理的に読めない幅) で
// SplitBody の代わりに使われる。モバイルのスコープは「閲覧 + Approve/Reject」なので、
// split が持つ行コメント新規作成 (LineTrigger / drag-select) / editor link / chunk ナビの
// data-chunk-idx は意図的に置かない。既存スレッドの表示と Reply は CommentRow がそのまま担う。
//
// 構造は SplitBody の片 side と同型 (.panel-side > .panel-side-inner > .code-row*):
//   - .panel-side の BEM を再利用することで overflow-x / scrollbar / sticky gutter の
//     スタイルを globals.css からそのまま継承する
//   - split 専用の重い同期 (行高同期 3-pass / 左右スクロール mirror) は左右が無いので不要。
//     CommentRow が参照する --ps-scroll-x / --ps-width の contract だけ軽量 effect で自前で満たす

import { Fragment, useLayoutEffect, useMemo, useRef } from 'react'
import type { RenderedPanel } from '@show-me/diff-shared'
import { toUnifiedRows, type UnifiedRow } from '../lib/unified'
import { highlightCode } from '../lib/highlight-code'
import { intraLineDecorations } from '../lib/char-diff'
import { escapeHtml } from '../lib/markdown'
import { CommentRow, anchorMapKey, sortAnchorKeys } from './CommentRow'
import type { LineCommentHandlers } from './useLineComments'

export type UnifiedBodyProps = {
  panel: RenderedPanel
  highlight: boolean
  commentKeysByAnchor: Map<string, string[]>
  handlers: LineCommentHandlers
}

export function UnifiedBody({ panel, highlight, commentKeysByAnchor, handlers }: UnifiedBodyProps) {
  // segment 単位で変換する: セグメント境界の dashed separator を split と同じ位置に出すため
  const segments = useMemo(
    () => panel.segments.map((seg) => toUnifiedRows(seg.rows)),
    [panel.segments],
  )
  const sideRef = useRef<HTMLDivElement>(null)

  // CommentRow の横 pinning contract (--ps-scroll-x / --ps-width) を満たす。
  // split 版 (Panel.tsx) は左右 mirror に同乗させているが、unified は単一カラムなので
  // scroll listener + ResizeObserver 各 1 個だけで済む。
  useLayoutEffect(() => {
    const side = sideRef.current
    if (!side) return
    const pin = () => {
      side.style.setProperty('--ps-scroll-x', `${side.scrollLeft}px`)
    }
    const updateWidth = () => {
      side.style.setProperty('--ps-width', `${side.clientWidth}px`)
    }
    updateWidth()
    side.addEventListener('scroll', pin, { passive: true })
    const ro = new ResizeObserver(updateWidth)
    ro.observe(side)
    return () => {
      side.removeEventListener('scroll', pin)
      ro.disconnect()
    }
  }, [])

  return (
    // panel-side BEM 再利用 (overflow-x / scrollbar / padding-bottom)。panel-side-unified は
    // split 専用 selector (.panel-side-asis / -tobe) のどれにもヒットさせないための識別子。
    <div className="panel-side panel-side-unified" data-side-container="unified" ref={sideRef}>
      <div className="panel-side-inner">
        {segments.map((rows, si) => (
          <Fragment key={si}>
            {si > 0 ? (
              <div className="h-0 border-t border-dashed border-border-soft my-1" aria-hidden="true" />
            ) : null}
            {rows.map((row, ri) => (
              <UnifiedRowView
                key={`${si}-${ri}`}
                row={row}
                panel={panel}
                highlight={highlight}
                commentKeysByAnchor={commentKeysByAnchor}
                handlers={handlers}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

function UnifiedRowView({
  row, panel, highlight, commentKeysByAnchor, handlers,
}: {
  row: UnifiedRow
  panel: RenderedPanel
  highlight: boolean
  commentKeysByAnchor: Map<string, string[]>
  handlers: LineCommentHandlers
}) {
  // deletion は変更前ファイルの言語、addition / context は変更後の言語でハイライトする
  // (cross-file 異言語 panel で split と同じ見え方を保つ)
  const lang = row.kind === 'deletion'
    ? (panel.asIsLanguage ?? 'plaintext')
    : (panel.toBeLanguage ?? 'plaintext')
  // pairRaw が付くのは位置対応ペアの deletion/addition のみ (toUnifiedRows が付与)。
  // deps に pairRaw を含める: 自分の raw が同じでも相手側が変われば変更文字範囲は変わるため
  const pairRaw = row.kind === 'context' ? undefined : row.pairRaw
  const html = useMemo(() => {
    if (!highlight) return escapeHtml(row.raw)
    const decorations =
      pairRaw != null
        ? row.kind === 'deletion'
          ? intraLineDecorations(row.raw, pairRaw, 'del')
          : intraLineDecorations(pairRaw, row.raw, 'add')
        : undefined
    return highlightCode(row.raw, lang, decorations)
  }, [highlight, row.raw, lang, pairRaw, row.kind])

  // コメント anchor の lookup:
  //   - deletion 行 → asIs(oldLine)
  //   - addition 行 → toBe(newLine)
  //   - context 行  → asIs(oldLine) と toBe(newLine) の両方を結合。
  //     split では context 行も両 side にコメントが付けられるため、toBe だけ引くと
  //     asIs 側 context 行の既存スレッドが unified で不可視になり、見えないコメントを
  //     残したまま Approve する事故につながる
  const anchorKeys: string[] = []
  if (row.kind === 'deletion') {
    if (row.oldLine != null) anchorKeys.push(...(commentKeysByAnchor.get(anchorMapKey('asIs', row.oldLine)) ?? []))
  } else if (row.kind === 'addition') {
    if (row.newLine != null) anchorKeys.push(...(commentKeysByAnchor.get(anchorMapKey('toBe', row.newLine)) ?? []))
  } else {
    if (row.oldLine != null) anchorKeys.push(...(commentKeysByAnchor.get(anchorMapKey('asIs', row.oldLine)) ?? []))
    if (row.newLine != null) anchorKeys.push(...(commentKeysByAnchor.get(anchorMapKey('toBe', row.newLine)) ?? []))
  }

  // gutter は 1 本: deletion = 旧行番号、addition / context = 新行番号 (新が無い片側 context は旧)。
  // モバイル幅で行番号 2 列に 104px を使う余裕は無く、色 (add/del bg) で行種別は判別できる。
  const gutter = row.kind === 'deletion'
    ? row.oldLine
    : row.kind === 'addition'
      ? row.newLine
      : (row.newLine ?? row.oldLine)

  // code-row / cell-ln / cell-code の type 合成クラス (code-row-addition 等) は globals.css の
  // 配色 rule をそのまま流用する。side クラスは asis/tobe のどちらでもないので unified を当て、
  // split 専用 selector に拾われないようにする。
  const type = row.kind
  return (
    <>
      <div className={`code-row code-row-unified code-row-${type}`}>
        <div className={`cell-ln cell-ln-unified cell-ln-${type}`}>{gutter ?? ''}</div>
        <div className={`cell-code cell-code-unified cell-code-${type}`}>
          <pre dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
      {anchorKeys.length > 0
        ? sortAnchorKeys(anchorKeys).map((key) => (
            <CommentRow key={key} lineKey={key} panel={panel} handlers={handlers} />
          ))
        : null}
    </>
  )
}
