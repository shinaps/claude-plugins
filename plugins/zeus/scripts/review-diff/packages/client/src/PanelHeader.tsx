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
    // panel-header BEM 維持: 祖先 .panel-block 内で `position: sticky; top: 46px` させる規則が globals.css
    // にあり (panel ごとに自身のヘッダが viewport 上端に貼り付く挙動)。utility だけだと panel-block の
    // collapsed 用 border-bottom 解除も別途必要になるため scope を残す。
    <div
      className="panel-header flex justify-between items-center gap-3 px-3.5 py-2.5 bg-surface-2 border-b border-border-soft text-xs"
      data-panel-id={panel.panelId}
    >
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-text font-sans">{panel.intent}</div>
        <div className="flex items-center gap-1.5 text-[11px] text-text-dim font-mono">
          {asIsFile && toBeFile && asIsFile !== toBeFile ? (
            <>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-del-fg">{asIsFile}</span>
              <span className="text-text-dim opacity-70" aria-hidden>→</span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-add-fg">{toBeFile}</span>
            </>
          ) : (
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{toBeFile ?? asIsFile ?? '(no file)'}</span>
          )}
        </div>
      </div>
      {onExpand ? (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-surface border border-border text-text-dim rounded-[5px] cursor-pointer font-sans text-[11.5px] font-medium shrink-0 transition-colors duration-[120ms] hover:bg-surface-3 hover:text-text hover:border-border"
          onClick={onExpand}
          title="Show diff"
          aria-label="Show this panel's diff"
        >
          {typeof totalRowsHint === 'number' ? (
            <span className="font-mono tabular-nums text-text-dim mr-0.5">{totalRowsHint.toLocaleString()} rows</span>
          ) : null}
          <span>Show diff</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 5.5 7 9.5 11 5.5" />
          </svg>
        </button>
      ) : null}
      {onCollapse ? (
        <button
          type="button"
          className="bg-transparent border border-border-soft text-text-dim w-[26px] h-[26px] rounded-[5px] inline-flex items-center justify-center cursor-pointer p-0 shrink-0 transition-colors duration-[120ms] hover:bg-surface-3 hover:text-text hover:border-border"
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
