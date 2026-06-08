// 1 グループの section (v4.12.0 stacked group モデル)。
// 左 sticky nav (GroupNav: decision section 統合) + 右 panels 列 (PanelBlock 列) を CSS Grid で並べる。
// グループ間の境界は section の border-top で表現する。
//
// v4.12.0 改修:
//   - Reviewed checkbox 系の props を全廃 (PanelBlock 側で削除済み)
//   - group decision / comment は GroupNav 内に colocate 配置のため、本コンポーネントは pass-through のみ
//   - context+ ボタンの regenPending は維持 (close-relaunch ループの同時発火防止)

import { memo } from 'react'
import type { RenderedPanel, GroupDecision } from '@zeus/review-diff-shared'
import { GroupNav } from './GroupNav'
import { PanelBlock } from './PanelBlock'
import { shouldAutoCollapseFile } from './auto-collapse'
import type { LineCommentHandlers } from './useLineComments'

type Props = {
  index: number
  total: number
  groupId: string
  title: string
  description: string
  panels: RenderedPanel[]
  onJumpToPanel: (panelId: string) => void
  onNavResizerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
  regenPending: boolean
  onRequestContext: (groupId: string) => void
  // v4.12.0 group decision + comment
  decision: GroupDecision | null
  comment: string
  onDecisionChange: (groupId: string, next: GroupDecision | null) => void
  onCommentChange: (groupId: string, body: string) => void
  submitDisabled: boolean
  // v4.12.0 panel 読了マーカ (左 nav の dot click でトグル、視覚アシスト)
  reviewedPanels: Set<string>
  onToggleReviewed: (panelId: string) => void
  // v4.12.0 (refinement): グループ間ナビゲーション (左 nav の prev/next 矢印用)
  onJumpToGroupIndex: (targetIndex: number) => void
} & LineCommentHandlers

export const GroupSection = memo(function GroupSection({
  index, total, groupId, title, description, panels,
  onJumpToPanel, onNavResizerPointerDown,
  regenPending, onRequestContext,
  decision, comment, onDecisionChange, onCommentChange, submitDisabled,
  reviewedPanels, onToggleReviewed,
  onJumpToGroupIndex,
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
          onJumpToPanel={onJumpToPanel}
          regenPending={regenPending}
          onRequestContext={onRequestContext}
          decision={decision}
          comment={comment}
          onDecisionChange={onDecisionChange}
          onCommentChange={onCommentChange}
          submitDisabled={submitDisabled}
          reviewedPanels={reviewedPanels}
          onToggleReviewed={onToggleReviewed}
          onJumpToGroupIndex={onJumpToGroupIndex}
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
        {panels.map((p) => {
          // v4.12.0 (refinement): 初期 collapsed 判定は 2 条件 (どちらか満たせば collapsed):
          //   - group decision が approved (= レビュー済み、コードを隠してレンダリングコスト抑制)
          //   - ファイル名 pattern (build artifact / lockfile / minified) に該当
          const file = p.toBe?.file ?? p.asIs?.file
          const isCollapseDefault = decision === 'approved' || shouldAutoCollapseFile(file)
          return (
            <PanelBlock
              key={p.panelId}
              panel={p}
              defaultCollapsed={isCollapseDefault}
              {...lineCommentHandlers}
            />
          )
        })}
      </div>
    </section>
  )
})
