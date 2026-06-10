// 1 グループの section (stacked group モデル)。
// 左 sticky nav (GroupNav: decision section 統合) + 右 panels 列 (PanelBlock 列) を CSS Grid で並べる。
// グループ間の境界は section の border-top で表現する。
//
// 構成方針:
//   - Reviewed checkbox 系の props は持たない (PanelBlock 側で廃止済み)
//   - group decision / comment は GroupNav 内に colocate 配置のため、本コンポーネントは pass-through のみ
//   - context+ ボタンの regenPending は close-relaunch ループの同時発火防止に必須

import { memo } from 'react'
import type { RenderedPanel, GroupDecision, ThreadSnapshot } from '@zeus/review-diff-shared'
import { GroupNav } from './GroupNav'
import { PanelBlock } from './PanelBlock'
import type { FileCommentHandlers } from './PanelHeader'
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
  // group decision + comment
  decision: GroupDecision | null
  comment: string
  // この group を anchor にした会話スレッド (comment-reply 復帰時の initialThreads 由来)。無ければ null。
  thread: ThreadSnapshot | null
  onDecisionChange: (groupId: string, next: GroupDecision | null) => void
  onCommentChange: (groupId: string, body: string) => void
  // group コメントをスレッドに積む (GroupNav の Comment ボタン → App.addGroupComment へ pass-through)
  onSubmitComment: () => void
  // ファイル単位コメント (PanelBlock → PanelHeader へ pass-through)
  fileComments?: FileCommentHandlers
  submitDisabled: boolean
  // panel 読了マーカ (左 nav の dot click でトグル、視覚アシスト)
  reviewedPanels: Set<string>
  onToggleReviewed: (panelId: string) => void
  // グループ間ナビゲーション (左 nav の prev/next 矢印用)
  onJumpToGroupIndex: (targetIndex: number) => void
} & LineCommentHandlers

export const GroupSection = memo(function GroupSection({
  index, total, groupId, title, description, panels,
  onJumpToPanel, onNavResizerPointerDown,
  regenPending, onRequestContext,
  decision, comment, thread, onDecisionChange, onCommentChange, onSubmitComment, fileComments, submitDisabled,
  reviewedPanels, onToggleReviewed,
  onJumpToGroupIndex,
  ...lineCommentHandlers
}: Props) {
  return (
    // group-section BEM 維持: dynamic --nav-width を grid-template-columns に含むため
    // (`var(--nav-width, 320px) minmax(0,1fr)`)、utility だと表現が冗長 + content-visibility:auto +
    // media query での grid 解除も globals.css に集約している。
    <section className="group-section" data-group-index={index} data-group-id={groupId}>
      {/* group-nav-wrapper は nav-resizer (absolute) の containing block */}
      <div className="group-nav-wrapper relative min-w-0">
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
          thread={thread}
          onDecisionChange={onDecisionChange}
          onCommentChange={onCommentChange}
          onSubmitComment={onSubmitComment}
          submitDisabled={submitDisabled}
          reviewedPanels={reviewedPanels}
          onToggleReviewed={onToggleReviewed}
          onJumpToGroupIndex={onJumpToGroupIndex}
        />
        {/*
          nav-resizer BEM 維持: ::before で grab zone 拡張 (視覚バーと掴み領域の分離) と、
          drag 中の `.dragging` class による accent 色化が globals.css にあるため。
          視覚バー自体の幅 (4px) と placement (absolute right:0) は utility で十分。
        */}
        <div
          className="nav-resizer absolute right-0 top-0 bottom-0 w-1 cursor-col-resize bg-transparent z-10 transition-colors duration-100 hover:bg-accent"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize navigation"
          onPointerDown={onNavResizerPointerDown}
        />
      </div>
      <div className="min-w-0 flex flex-col">
        {panels.map((p) => {
          // 初期 collapsed 判定は 2 条件 (どちらか満たせば collapsed):
          //   - group decision が approved (= レビュー済み、コードを隠してレンダリングコスト抑制)
          //   - ファイル名 pattern (build artifact / lockfile / minified) に該当
          const file = p.toBe?.file ?? p.asIs?.file
          const isCollapseDefault = decision === 'approved' || shouldAutoCollapseFile(file)
          return (
            <PanelBlock
              key={p.panelId}
              panel={p}
              defaultCollapsed={isCollapseDefault}
              fileComments={fileComments}
              {...lineCommentHandlers}
            />
          )
        })}
      </div>
    </section>
  )
})
