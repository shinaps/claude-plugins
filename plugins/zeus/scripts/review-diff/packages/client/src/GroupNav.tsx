// 1 グループの左 sticky ペイン (v4.12.0 stacked group モデル)。
//
// v4.12.0 改修:
//   - Reviewed progress meter を廃止 (panel 単位 Reviewed 概念ごと撤廃)
//   - 代わりに group ヘッダ右隅に decision バッジ (APPROVED / CHANGES / NO PANELS) を表示
//   - panel list の下に「decision section」を新設: group コメント textarea + Approve / Request Changes
//     ボタンを colocate。ユーザーは「左で評価 / 右で読む」レイアウトで decision を完結できる
//   - context+ ボタンは維持 (close-relaunch ループの起点として regen-group を発火)
//
// 構成 (上から):
//   1. eyebrow: GROUP の小さなラベル + 右上に display number "01/04" + decision バッジ
//   2. title (h2): tight tracking、emphasized
//   3. description (markdown): 控えめ、余白多め
//   4. context+ button: アイコン主体の Linear 風 pill
//   5. panel list: 各 item に dot indicator (active rail = currently-reading 強調)
//   6. decision section: textarea + Approve / Request Changes (panels=0 group は disable)
//
// scroll spy:
//   IntersectionObserver で .panel-block の可視性を観測し、いま画面に最も上に
//   見えている panel を active 表示する。

import { useEffect, useState } from 'react'
import type { RenderedPanel, GroupDecision } from '@zeus/review-diff-shared'
import { renderMarkdown } from './markdown'

type Props = {
  index: number
  total: number
  groupId: string
  title: string
  description: string
  panels: RenderedPanel[]
  onJumpToPanel: (panelId: string) => void
  // v4.8.0 context+ (close-relaunch): regen 中は全 group の context+ ボタンを止める。
  regenPending: boolean
  onRequestContext: (groupId: string) => void
  // v4.12.0 group decision + comment
  decision: GroupDecision | null
  comment: string
  onDecisionChange: (groupId: string, next: GroupDecision | null) => void
  onCommentChange: (groupId: string, body: string) => void
  // regen 中など、Approve/RC ボタンも操作不可にしたい時 true
  submitDisabled: boolean
  // v4.12.0 (later): panel ごとの「読了マーカ」。group decision とは別軸の視覚アシスト。
  // 左 nav の dot indicator を click で toggle して、ユーザーが「どこまで読んだか」を追えるようにする。
  // ResultJson には載せない (内部 UI state のみ、regen-group では restore 対象)。
  reviewedPanels: Set<string>
  onToggleReviewed: (panelId: string) => void
  // v4.12.0 (refinement): グループ間ナビゲーション。eyebrow の数字横に prev/next 矢印を出して
  // 「次の group へスクロール」をワンクリックでできるようにする。先頭/末尾 group では片側 disabled。
  onJumpToGroupIndex: (targetIndex: number) => void
}

export function GroupNav({
  index, total, groupId, title, description, panels, onJumpToPanel,
  regenPending, onRequestContext,
  decision, comment, onDecisionChange, onCommentChange, submitDisabled,
  reviewedPanels, onToggleReviewed,
  onJumpToGroupIndex,
}: Props) {
  const num = String(index + 1).padStart(2, '0')
  const tot = String(total).padStart(2, '0')
  const descHtml = renderMarkdown(description || '')

  const activePanelId = useScrollSpy(panels)
  const noPanels = panels.length === 0

  // decision バッジのラベルとクラス。panels=0 の group は強制 approved 扱いだが
  // バッジ表記は「NO PANELS」として区別する (Submit active 条件は満たすが UI 上は明示)。
  const badge = noPanels
    ? { label: 'NO PANELS', cls: 'is-no-panels' }
    : decision === 'approved'
      ? { label: 'APPROVED', cls: 'is-approved' }
      : decision === 'request-changes'
        ? { label: 'CHANGES', cls: 'is-rc' }
        : null

  const decisionInteractive = !noPanels && !submitDisabled

  return (
    <aside className="group-nav">
      <header className="group-nav-header">
        <div className="group-nav-eyebrow">
          <span className="group-nav-eyebrow-label">GROUP</span>
          <span className="group-nav-numerals" aria-label={`Group ${index + 1} of ${total}`}>
            <span className="group-nav-num">{num}</span>
            <span className="group-nav-num-sep">/</span>
            <span className="group-nav-num-tot">{tot}</span>
          </span>
          {/* v4.12.0 (refinement) グループ間ナビゲーション。
              eyebrow 直後に prev/next 矢印を置いて scroll を 1 click でやれるようにする。
              先頭/末尾の group では片側を disabled (cursor not-allowed + opacity 落とし)。 */}
          <div className="group-nav-jump" role="group" aria-label="Jump between groups">
            <button
              type="button"
              className="group-nav-jump-btn"
              onClick={() => onJumpToGroupIndex(index - 1)}
              disabled={index === 0}
              aria-label="Previous group"
              title="前のグループへ"
            >
              <ChevronUpIcon />
            </button>
            <button
              type="button"
              className="group-nav-jump-btn"
              onClick={() => onJumpToGroupIndex(index + 1)}
              disabled={index === total - 1}
              aria-label="Next group"
              title="次のグループへ"
            >
              <ChevronDownIcon />
            </button>
          </div>
          {badge ? (
            <span className={`group-decision-badge ${badge.cls}`} aria-label={`Decision: ${badge.label}`}>
              {badge.label}
            </span>
          ) : null}
        </div>
        <h2 className="group-title">{title}</h2>
        {descHtml ? (
          <div className="group-desc" dangerouslySetInnerHTML={{ __html: descHtml }} />
        ) : null}
      </header>

      {/* v4.8.0: context+ は close-relaunch ループの起点。クリックで現状 state を回収して
          CLI を終了させ、SKILL.md 側で summary.json を再生成してから Skill を再起動する。
          regenPending=true 中は他 group も含め全ての context+ を disable する。 */}
      <div className="group-context-actions" role="group" aria-label="Request more context">
        <button
          type="button"
          className={`btn-context${regenPending ? ' is-pending' : ''}`}
          disabled={regenPending}
          title={
            regenPending
              ? 'Regenerating — this tab will close and reopen automatically'
              : 'Request more context for this group (this tab will close and reopen with expanded panels)'
          }
          onClick={() => onRequestContext(groupId)}
          aria-busy={regenPending}
        >
          <span className="btn-context-icon" aria-hidden="true">
            {regenPending ? <SpinnerIcon /> : <PlusIcon />}
          </span>
          <span className="btn-context-label">
            {regenPending ? 'Regenerating' : 'More context'}
          </span>
        </button>
      </div>

      {panels.length ? (
        <nav className="group-panel-list" aria-label="Panels in this group">
          {panels.map((p) => (
            <PanelItem
              key={p.panelId}
              panel={p}
              active={activePanelId === p.panelId}
              reviewed={reviewedPanels.has(p.panelId)}
              onJump={onJumpToPanel}
              onToggleReviewed={onToggleReviewed}
            />
          ))}
        </nav>
      ) : null}

      {/* v4.12.0 decision section: panels=0 の group は disable + no-panels 表示
          (ユーザーは何を見ずに decide するのかわからないので、自動 approved 扱いを App 側で行う) */}
      <div className="group-decision-section">
        <textarea
          className="group-comment"
          placeholder={
            noPanels
              ? 'No panels in this group'
              : decision === 'request-changes'
                ? '修正してほしい点を書いてください...'
                : 'この group へのコメント (任意)'
          }
          value={comment}
          disabled={!decisionInteractive}
          onChange={(e) => onCommentChange(groupId, e.target.value)}
        />
        <div className="group-decision-bar" role="radiogroup" aria-label="Group decision">
          <button
            type="button"
            className={`btn-decision btn-approve${decision === 'approved' ? ' is-selected' : ''}`}
            disabled={!decisionInteractive}
            aria-pressed={decision === 'approved'}
            onClick={() => onDecisionChange(groupId, decision === 'approved' ? null : 'approved')}
          >
            Approve
          </button>
          <button
            type="button"
            className={`btn-decision btn-rc${decision === 'request-changes' ? ' is-selected' : ''}`}
            disabled={!decisionInteractive}
            aria-pressed={decision === 'request-changes'}
            onClick={() => onDecisionChange(groupId, decision === 'request-changes' ? null : 'request-changes')}
          >
            Request changes
          </button>
        </div>
      </div>
    </aside>
  )
}

function PanelItem({
  panel, active, reviewed, onJump, onToggleReviewed,
}: {
  panel: RenderedPanel
  active: boolean
  reviewed: boolean
  onJump: (panelId: string) => void
  onToggleReviewed: (panelId: string) => void
}) {
  const asIs = panel.asIs?.file
  const toBe = panel.toBe?.file
  const className = [
    'group-panel-item',
    active ? 'is-active' : '',
    reviewed ? 'is-reviewed' : '',
  ].filter(Boolean).join(' ')
  // dot indicator は button として独立配置。クリックで reviewed toggle、
  // 親 (.group-panel-item) のジャンプとは別アクション (stopPropagation で分離)。
  return (
    <div className={className} aria-current={active ? 'true' : undefined}>
      <button
        type="button"
        className="panel-item-indicator-btn"
        onClick={(e) => {
          e.stopPropagation()
          onToggleReviewed(panel.panelId)
        }}
        title={reviewed ? '読了マークを外す' : '読了マークを付ける'}
        aria-label={reviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
        aria-pressed={reviewed}
      >
        <span className="panel-item-indicator" aria-hidden="true">
          {reviewed ? <CheckDotIcon /> : <RingDotIcon />}
        </span>
      </button>
      <button
        type="button"
        className="panel-item-jump"
        onClick={() => onJump(panel.panelId)}
        title={panel.intent}
      >
        <span className="panel-item-text">
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
        </span>
      </button>
    </div>
  )
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx < 0 ? p : p.slice(idx + 1)
}

// ---------- scroll spy hook ----------
function useScrollSpy(panels: RenderedPanel[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    if (panels.length === 0) return
    const visibility = new Map<string, boolean>()
    const ids = panels.map((p) => p.panelId)
    const observers: IntersectionObserver[] = []
    const recompute = () => {
      const first = ids.find((id) => visibility.get(id))
      setActiveId(first ?? null)
    }
    for (const id of ids) {
      const el = document.querySelector(`.panel-block[data-panel-id="${cssEscape(id)}"]`)
      if (!el) continue
      const io = new IntersectionObserver(
        ([entry]) => {
          if (!entry) return
          visibility.set(id, entry.isIntersecting)
          recompute()
        },
        { rootMargin: '-30% 0px -50% 0px', threshold: 0 },
      )
      io.observe(el)
      observers.push(io)
    }
    return () => {
      observers.forEach((io) => io.disconnect())
    }
  }, [panels])
  return activeId
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
  return s.replace(/[^A-Za-z0-9_-]/g, '\\$&')
}

// ---------- inline SVG icons ----------
function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6 2v8M2 6h8" />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <svg className="spin" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6 1.5 a4.5 4.5 0 1 1 -3.18 1.32" />
    </svg>
  )
}

function RingDotIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  )
}

function ChevronUpIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5 6 4.5 9 7.5" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  )
}

function CheckDotIcon() {
  // 読了 (= reviewed) の状態を表現する filled dot + check mark。
  // 視覚的にも「埋まった = 完了」のメタファ。
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" fill="currentColor" />
      <path d="M3.6 6.2 5 7.6 8.4 4.2" stroke="var(--background)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
