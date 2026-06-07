// 1 グループの左 sticky ペイン (v4.7.0 panel model)。
// 番号 + タイトル + 説明 (markdown) + panel 一覧。クリックで右ペインの panel に anchor scroll。
//
// panel-list の各エントリ:
//   - intent を主表示 (太字、短文)
//   - 下行に asIs.file / toBe.file (cross-file は矢印で並べる)
//   - Reviewed の panel は薄く表示

import type { RenderedPanel } from '@zeus/review-diff-shared'
import { renderMarkdown } from './markdown'

type Props = {
  index: number
  total: number
  title: string
  description: string
  panels: RenderedPanel[]
  reviewedPanels: Set<string>
  onJumpToPanel: (panelId: string) => void
}

export function GroupNav({
  index, total, title, description, panels, reviewedPanels, onJumpToPanel,
}: Props) {
  const num = String(index + 1).padStart(2, '0')
  const tot = String(total).padStart(2, '0')
  const descHtml = renderMarkdown(description || '')

  return (
    <aside className="group-nav">
      <div className="group-number">
        {num} <span className="total">/ {tot}</span>
      </div>
      <h2 className="group-title">{title}</h2>
      {descHtml ? (
        <div className="group-desc" dangerouslySetInnerHTML={{ __html: descHtml }} />
      ) : null}
      {panels.length ? (
        <div className="group-panel-list">
          {panels.map((p) => (
            <PanelItem
              key={p.panelId}
              panel={p}
              reviewed={reviewedPanels.has(p.panelId)}
              onJump={onJumpToPanel}
            />
          ))}
        </div>
      ) : null}
    </aside>
  )
}

function PanelItem({
  panel, reviewed, onJump,
}: {
  panel: RenderedPanel
  reviewed: boolean
  onJump: (panelId: string) => void
}) {
  const asIs = panel.asIs?.file
  const toBe = panel.toBe?.file
  return (
    <button
      type="button"
      className={`group-panel-item ${reviewed ? 'reviewed' : ''}`}
      onClick={() => onJump(panel.panelId)}
      title={panel.intent}
    >
      <span className="panel-intent-line">{panel.intent}</span>
      <span className="panel-files-line">
        {asIs && toBe && asIs !== toBe ? (
          <>
            <span className="file-name">{basename(asIs)}</span>
            <span className="file-arrow" aria-hidden>→</span>
            <span className="file-name">{basename(toBe)}</span>
          </>
        ) : (
          <span className="file-name">{basename(toBe ?? asIs ?? '(no file)')}</span>
        )}
      </span>
    </button>
  )
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx < 0 ? p : p.slice(idx + 1)
}
