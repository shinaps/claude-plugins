// Panel の上部に出るヘッダ。
//   - intent (太字)
//   - asIs.file → toBe.file (片側だけなら片側、cross-file なら矢印で並べる)
//   - v4.12.0 (refinement): onCollapse / onExpand のどちらかが渡されたら右端にボタンを表示。
//       - 通常表示 (expanded) では onCollapse → chevron up アイコン (Hide)
//       - collapsed 状態では onExpand + totalRowsHint → "Show N rows" ボタン
//     どちらの状態でも panel タイトル + ファイル名は維持され、行数は Show diff ボタンに集約。

import type { RenderedPanel } from '@zeus/review-diff-shared'

export type PanelHeaderProps = {
  panel: RenderedPanel
  // 通常状態 (expanded) で渡される: chevron up の Hide ボタンを表示
  onCollapse?: () => void
  // collapsed 状態で渡される: 行数付き Show diff ボタンを表示
  onExpand?: () => void
  totalRowsHint?: number
}

export function PanelHeader({ panel, onCollapse, onExpand, totalRowsHint }: PanelHeaderProps) {
  const asIsFile = panel.asIs?.file
  const toBeFile = panel.toBe?.file
  return (
    <div className="panel-header" data-panel-id={panel.panelId}>
      <div className="panel-header-main">
        <div className="panel-intent">{panel.intent}</div>
        <div className="panel-files">
          {asIsFile && toBeFile && asIsFile !== toBeFile ? (
            <>
              <span className="panel-file panel-file-asis">{asIsFile}</span>
              <span className="panel-file-arrow" aria-hidden>→</span>
              <span className="panel-file panel-file-tobe">{toBeFile}</span>
            </>
          ) : (
            <span className="panel-file">{toBeFile ?? asIsFile ?? '(no file)'}</span>
          )}
        </div>
      </div>
      {onExpand ? (
        <button
          type="button"
          className="panel-header-expand-btn"
          onClick={onExpand}
          title="Show diff"
          aria-label="Show this panel's diff"
        >
          {typeof totalRowsHint === 'number' ? (
            <span className="panel-header-expand-rows">{totalRowsHint.toLocaleString()} rows</span>
          ) : null}
          <span className="panel-header-expand-label">Show diff</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 5.5 7 9.5 11 5.5" />
          </svg>
        </button>
      ) : null}
      {onCollapse ? (
        <button
          type="button"
          className="panel-header-collapse-btn"
          onClick={onCollapse}
          title="Hide diff"
          aria-label="Hide this panel"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8.5 7 4.5 11 8.5" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}
