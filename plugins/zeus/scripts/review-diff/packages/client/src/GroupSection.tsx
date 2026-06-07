// 1 グループの section (v4.8.0 panel model + close-relaunch context+)。
// 左 sticky nav (GroupNav) + 右 panels 列 (PanelBlock の連続) を CSS Grid で並べる。
// グループ間の境界は section の border-top で表現する。
//
// v4.8.0: context+ ボタンは direction を持たない 1 ボタンに簡素化 (旧 +/- 両方廃止)。
//   regenPending=true なら全 group の context+ ボタンを disable (連打 + ダブル close 防止)。
//   close-relaunch なので channelStatus / pendingGroupId / channelsEnabled の状態管理は不要。

import { memo } from 'react'
import type { RenderedPanel } from '@zeus/review-diff-shared'
import { GroupNav } from './GroupNav'
import { PanelBlock } from './PanelBlock'
import type { LineCommentHandlers } from './useLineComments'

type Props = {
  index: number
  total: number
  groupId: string
  title: string
  description: string
  panels: RenderedPanel[]
  reviewedPanels: Set<string>
  onJumpToPanel: (panelId: string) => void
  onToggleReviewed: (panelId: string, next: boolean) => void
  onNavResizerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  // v4.8.0 context+ (close-relaunch): regen 中は全 group の context+ ボタンを止める
  regenPending: boolean
  onRequestContext: (groupId: string) => void
} & LineCommentHandlers

export const GroupSection = memo(function GroupSection({
  index, total, groupId, title, description, panels,
  reviewedPanels, onJumpToPanel, onToggleReviewed, onNavResizerPointerDown,
  regenPending, onRequestContext,
  ...lineCommentHandlers
}: Props) {
  return (
    <section className="group-section" data-group-index={index} data-group-id={groupId}>
      <div className="group-nav-wrapper">
        <GroupNav
          index={index}
          total={total}
          groupId={groupId}
          title={title}
          description={description}
          panels={panels}
          reviewedPanels={reviewedPanels}
          onJumpToPanel={onJumpToPanel}
          regenPending={regenPending}
          onRequestContext={onRequestContext}
        />
        <div
          className="nav-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize navigation"
          onPointerDown={onNavResizerPointerDown}
        />
      </div>
      <div className="group-panels-column">
        {panels.map((p) => (
          <PanelBlock
            key={p.panelId}
            panel={p}
            reviewed={reviewedPanels.has(p.panelId)}
            onToggleReviewed={onToggleReviewed}
            {...lineCommentHandlers}
          />
        ))}
      </div>
    </section>
  )
})
