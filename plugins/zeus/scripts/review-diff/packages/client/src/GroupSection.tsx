// 1 グループの section (v4.7.0 panel model)。
// 左 sticky nav (GroupNav) + 右 panels 列 (PanelBlock の連続) を CSS Grid で並べる。
// グループ間の境界は section の border-top で表現する。
//
// 新規: context+ / context- ボタンを footer に追加。
//   - channelsEnabled=false → 両ボタン disabled + tooltip 'Claude Code Channels not available'
//   - pendingGroupId === groupId → 両ボタン disabled + spinner 表示 (連打防止)
//   - channelStatus=='disabled'|'closed' → 同様に disabled

import { memo } from 'react'
import type { RenderedPanel } from '@zeus/review-diff-shared'
import { GroupNav } from './GroupNav'
import { PanelBlock } from './PanelBlock'
import type { LineCommentHandlers } from './useLineComments'
import type { ChannelStatus } from './useChannelSSE'

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
  // Channels integration
  channelsEnabled: boolean
  channelStatus: ChannelStatus
  pendingGroupId: string | null
  onRequestContext: (groupId: string, direction: 'more' | 'less') => void
} & LineCommentHandlers

export const GroupSection = memo(function GroupSection({
  index, total, groupId, title, description, panels,
  reviewedPanels, onJumpToPanel, onToggleReviewed, onNavResizerPointerDown,
  channelsEnabled, channelStatus, pendingGroupId, onRequestContext,
  ...lineCommentHandlers
}: Props) {
  // context+/- ボタンの disabled 判定:
  //   - channelsEnabled=false: そもそも Channels 経路無し
  //   - channelStatus が disabled/closed: SSE 接続が利用不可
  //   - pendingGroupId === groupId: 現在 feedback 待機中 (連打防止)
  //   - pendingGroupId !== null かつ != groupId: 別 group が待機中。他 group の操作も止める方が安全
  const ctxDisabled =
    !channelsEnabled ||
    channelStatus === 'disabled' ||
    channelStatus === 'closed' ||
    pendingGroupId !== null

  const ctxTooltip = !channelsEnabled
    ? 'Claude Code Channels not available (start with --channels-enabled and load the channel server)'
    : channelStatus === 'disabled' || channelStatus === 'closed'
      ? 'Channel disconnected'
      : pendingGroupId === groupId
        ? 'Waiting for Claude to respond…'
        : pendingGroupId !== null
          ? 'Another group is being regenerated'
          : 'Request more / less context for this group'

  const isPendingHere = pendingGroupId === groupId

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
          channelsEnabled={channelsEnabled}
          ctxDisabled={ctxDisabled}
          ctxTooltip={ctxTooltip}
          isPendingHere={isPendingHere}
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
