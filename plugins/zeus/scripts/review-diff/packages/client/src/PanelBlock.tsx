// 旧 FileBlock の panel model 版置換。
//
// 役割:
//   - 1 Panel をラップし、Reviewed checkbox (panelId 単位) を扱う (A9 統合)
//   - per-panel コメント (= panel 全体に対するコメント) の textarea を将来追加する余地を持つ
//     (v4.7.0 MVP では line comment のみで十分なので checkbox だけに留める)
//
// なぜ責務を Panel から分離するか:
//   Panel.tsx は drag-select / 行コメント / split-unified の実装で密度が高い。
//   Reviewed 状態は panel の表示モードと無関係に切り替わるので、ラッパで持つ方が
//   Panel の再 render と Reviewed checkbox の再 render を分離できる。

import { useCallback } from 'react'
import type { RenderedPanel } from '@zeus/review-diff-shared'
import { Panel } from './Panel'
import type { LineCommentHandlers } from './useLineComments'

export type PanelBlockProps = {
  panel: RenderedPanel
  reviewed: boolean
  onToggleReviewed: (panelId: string, next: boolean) => void
  highlight?: boolean
} & LineCommentHandlers

export function PanelBlock(props: PanelBlockProps) {
  const { panel, reviewed, onToggleReviewed, highlight, ...handlers } = props
  const onToggle = useCallback(() => {
    onToggleReviewed(panel.panelId, !reviewed)
  }, [onToggleReviewed, panel.panelId, reviewed])

  return (
    <div
      className={`panel-block${reviewed ? ' is-reviewed' : ''}`}
      data-panel-id={panel.panelId}
    >
      <Panel panel={panel} highlight={highlight} {...handlers} />
      <div className="panel-footer">
        <label className="panel-reviewed-label">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={onToggle}
            aria-label={`Mark panel ${panel.panelId} as reviewed`}
          />
          <span>Reviewed</span>
        </label>
      </div>
    </div>
  )
}
