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

  // jump-btn の utility 文字列。先頭/末尾で disabled になるため `enabled:hover:*` で切り分け。
  const JUMP_BTN =
    'bg-transparent border border-border-soft text-text-dim w-[22px] h-[22px] rounded-[5px] inline-flex items-center justify-center cursor-pointer p-0 transition-colors duration-[120ms] enabled:hover:bg-surface-2 enabled:hover:text-text enabled:hover:border-border disabled:opacity-[0.35] disabled:cursor-not-allowed'

  return (
    // group-nav BEM 維持: sticky + max-height: calc(100vh - 96px) + ::-webkit-scrollbar カスタムが
    // globals.css にあるため (細い 4px の縦バー)。
    <aside className="group-nav">
      <header className="pb-[18px] mb-[18px] border-b border-border-soft">
        <div className="flex items-center justify-between mb-3.5 min-h-6">
          <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-text-dim uppercase">GROUP</span>
          <span
            className="inline-flex items-baseline font-mono tabular-nums text-text-dim tracking-tight"
            aria-label={`Group ${index + 1} of ${total}`}
          >
            <span className="text-[17px] font-semibold text-text">{num}</span>
            <span className="text-sm mx-[3px] text-text-dim opacity-60">/</span>
            <span className="text-sm text-text-dim">{tot}</span>
          </span>
          {/* v4.12.0 (refinement) グループ間ナビゲーション。
              eyebrow 直後に prev/next 矢印を置いて scroll を 1 click でやれるようにする。
              先頭/末尾の group では片側を disabled (cursor not-allowed + opacity 落とし)。 */}
          <div className="inline-flex gap-0.5 ml-auto items-center" role="group" aria-label="Jump between groups">
            <button
              type="button"
              className={JUMP_BTN}
              onClick={() => onJumpToGroupIndex(index - 1)}
              disabled={index === 0}
              aria-label="Previous group"
              title="前のグループへ"
            >
              <ChevronUpIcon />
            </button>
            <button
              type="button"
              className={JUMP_BTN}
              onClick={() => onJumpToGroupIndex(index + 1)}
              disabled={index === total - 1}
              aria-label="Next group"
              title="次のグループへ"
            >
              <ChevronDownIcon />
            </button>
          </div>
          {badge ? (
            // group-decision-badge BEM 維持: is-approved/is-rc/is-no-panels の色切替が globals.css にあるため
            <span
              className={`group-decision-badge inline-flex items-center px-2 py-0.5 ml-1.5 text-[10px] font-semibold tracking-[0.06em] uppercase rounded-full border border-transparent ${badge.cls}`}
              aria-label={`Decision: ${badge.label}`}
            >
              {badge.label}
            </span>
          ) : null}
        </div>
        <h2 className="text-[19px] font-semibold text-text m-0 mb-2.5 tracking-[-0.015em] leading-[1.25]">{title}</h2>
        {descHtml ? (
          // group-desc BEM 維持: prose 内 typography token の上書き scope として globals.css で使用。
          <div
            className="group-desc prose prose-invert prose-sm max-w-none text-[12.5px] leading-[1.55] mb-4"
            dangerouslySetInnerHTML={{ __html: descHtml }}
          />
        ) : null}
      </header>

      {/* v4.8.0: context+ は close-relaunch ループの起点。クリックで現状 state を回収して
          CLI を終了させ、SKILL.md 側で summary.json を再生成してから Skill を再起動する。
          regenPending=true 中は他 group も含め全ての context+ を disable する。 */}
      <div className="flex justify-start mb-4" role="group" aria-label="Request more context">
        {/* btn-context BEM 維持: .is-pending state による accent 色化 + .btn-context-icon .spin animation が
            globals.css にあるため。base 見た目は utility。 */}
        <button
          type="button"
          className={`btn-context inline-flex items-center gap-2 px-3 py-[7px] text-xs font-medium font-sans tracking-[-0.005em] text-text bg-surface-2 border border-border-soft rounded-md cursor-pointer shadow-[0_1px_0_rgba(0,0,0,0.2)] transition-[background,border,color,transform] duration-[120ms] enabled:hover:bg-surface-3 enabled:hover:border-border enabled:hover:text-text enabled:active:translate-y-[0.5px] focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:opacity-[0.45] disabled:cursor-not-allowed disabled:bg-transparent${regenPending ? ' is-pending' : ''}`}
          disabled={regenPending}
          title={
            regenPending
              ? 'Regenerating — this tab will close and reopen automatically'
              : 'Request more context for this group (this tab will close and reopen with expanded panels)'
          }
          onClick={() => onRequestContext(groupId)}
          aria-busy={regenPending}
        >
          {/* btn-context-icon BEM 維持: 内側 .spin の rotate animation を globals.css でスコープしているため */}
          <span className="btn-context-icon inline-flex w-3 h-3 [color:currentColor]" aria-hidden="true">
            {regenPending ? <SpinnerIcon /> : <PlusIcon />}
          </span>
          <span className="tabular-nums">
            {regenPending ? 'Regenerating' : 'More context'}
          </span>
        </button>
      </div>

      {panels.length ? (
        // group-panel-list の `margin-left: -2px + padding-left: 2px` は active rail (::before) を
        // nav 左端ぴったりに見せるためのオフセット。utility 化可能だがセマンティック wrap で残置。
        <nav className="flex flex-col gap-px -ml-0.5 pl-0.5" aria-label="Panels in this group">
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
      {/* group-decision-section BEM の `margin-top: auto` は flex column 親 (.group-nav) で必要だったが、
          ここでは utility `mt-auto` で代替する。残りは utility 化。 */}
      <div className="mt-auto pt-4 border-t border-border-soft flex flex-col gap-2.5">
        <textarea
          className="w-full min-h-[60px] max-h-[200px] resize-none bg-background text-text border border-border rounded-[7px] px-2.5 py-2 font-sans text-xs leading-[1.5] outline-none transition-colors duration-[120ms] focus:border-accent disabled:bg-surface-2 disabled:text-text-dim disabled:cursor-not-allowed"
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
        <div className="flex gap-1.5" role="radiogroup" aria-label="Group decision">
          {/* btn-decision + btn-approve/btn-rc BEM 維持: .is-selected で approved=緑、rc=赤に色を切り替える
              scope rule が globals.css にあるため。base 見た目は utility。 */}
          <button
            type="button"
            className={`btn-decision btn-approve flex-1 px-2.5 py-1.5 border border-border bg-surface-2 text-text rounded-[7px] cursor-pointer text-[11.5px] font-medium font-sans transition-colors duration-[120ms] enabled:hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed${decision === 'approved' ? ' is-selected' : ''}`}
            disabled={!decisionInteractive}
            aria-pressed={decision === 'approved'}
            onClick={() => onDecisionChange(groupId, decision === 'approved' ? null : 'approved')}
          >
            Approve
          </button>
          <button
            type="button"
            className={`btn-decision btn-rc flex-1 px-2.5 py-1.5 border border-border bg-surface-2 text-text rounded-[7px] cursor-pointer text-[11.5px] font-medium font-sans transition-colors duration-[120ms] enabled:hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed${decision === 'request-changes' ? ' is-selected' : ''}`}
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
  //
  // group-panel-item BEM 維持: ::before の accent rail + .is-active で rail visible 化 + .is-reviewed で
  // indicator-btn 色変化 (= success 緑) + focus-visible で内側 box-shadow 表示 が globals.css にある。
  // base 見た目 (flex 配置 / radius / font-size) は utility で表現、上記 state は className に残置。
  return (
    <div
      className={`${className} relative flex items-stretch gap-0 bg-transparent text-text rounded-[5px] text-xs transition-colors duration-[120ms] hover:bg-surface-2`}
      aria-current={active ? 'true' : undefined}
    >
      <button
        type="button"
        className="panel-item-indicator-btn bg-transparent border-0 py-2 pl-2 pr-1 cursor-pointer text-text-dim inline-flex items-start transition-colors duration-[120ms] hover:text-text"
        onClick={(e) => {
          e.stopPropagation()
          onToggleReviewed(panel.panelId)
        }}
        title={reviewed ? '読了マークを外す' : '読了マークを付ける'}
        aria-label={reviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
        aria-pressed={reviewed}
      >
        {/* panel-item-indicator BEM 維持: .group-panel-item.is-active .panel-item-indicator の
            color: var(--color-accent) を globals.css でスコープしているため (active 行は dot も accent) */}
        <span
          className="panel-item-indicator inline-flex items-center justify-center mt-px text-text-dim shrink-0 transition-colors duration-[120ms]"
          aria-hidden="true"
        >
          {reviewed ? <CheckDotIcon /> : <RingDotIcon />}
        </span>
      </button>
      <button
        type="button"
        className="bg-transparent border-0 py-2 pl-1 pr-2.5 text-left cursor-pointer text-text text-xs flex-1 min-w-0 hover:bg-surface-2 hover:rounded-[5px]"
        onClick={() => onJump(panel.panelId)}
        title={panel.intent}
      >
        <span className="flex flex-col gap-[3px] min-w-0">
          {/* panel-intent-line BEM 維持: `.group-panel-item.is-active .panel-intent-line` で text color
              を accent ON 時に上書きする rule が globals.css にあるため。 */}
          <span className="panel-intent-line font-medium text-text whitespace-normal break-words leading-[1.4] tracking-[-0.005em] transition-colors duration-[120ms]">
            {panel.intent}
          </span>
          <span className="text-[10.5px] text-text-dim font-mono flex gap-1 items-center flex-wrap break-all">
            {asIs && toBe && asIs !== toBe ? (
              <>
                <span className="min-w-0 break-all">{basename(asIs)}</span>
                <span className="text-text-dim opacity-70" aria-hidden>→</span>
                <span className="min-w-0 break-all">{basename(toBe)}</span>
              </>
            ) : (
              <span className="min-w-0 break-all">{basename(toBe ?? asIs ?? '(no file)')}</span>
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
  // stroke に design token を直接指定する理由: 親の currentColor (= success 緑) を fill に使い、
  // 抜き文字でチェックを描くため。`var(--color-background)` は @theme で実体化された CSS var を直参照する。
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" fill="currentColor" />
      <path d="M3.6 6.2 5 7.6 8.4 4.2" stroke="var(--color-background)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
