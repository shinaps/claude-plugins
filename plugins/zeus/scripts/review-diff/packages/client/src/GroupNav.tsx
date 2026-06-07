// 1 グループの左 sticky ペイン。Linear / Raycast 風の editorial minimalism にリファイン。
//
// 構成 (上から):
//   1. eyebrow: GROUP の小さなラベル + 右上に oversized display number "01/04"
//   2. title (h2): tight tracking、emphasized
//   3. description (markdown): 控えめ、余白多め
//   4. progress meter: 細い 2px バー + "3/7 reviewed" 表記。scroll spy active 時にアクセント色化
//   5. context+ button: アイコン主体の Linear 風 pill (テキストは "More context")
//   6. panel list: 各 item に dot indicator (reviewed: filled / unread: ring) + active rail (2px accent)
//
// scroll spy:
//   IntersectionObserver で .panel-block の可視性を観測し、いま画面に最も上に
//   見えている panel を active 表示する。読書中の panel が左 nav 上で常に追跡されるので、
//   group を跨いだスクロール中に「今どの章を読んでいるか」が一目でわかる。
//   rootMargin で「viewport の上 30% / 下 50% を死角」にして、典型的な "目線位置 (上から 30%)"
//   に来た panel を active とする (Linear の docs sidebar と同じ手法)。

import { useEffect, useState, useMemo } from 'react'
import type { RenderedPanel } from '@zeus/review-diff-shared'
import { renderMarkdown } from './markdown'

type Props = {
  index: number
  total: number
  groupId: string
  title: string
  description: string
  panels: RenderedPanel[]
  reviewedPanels: Set<string>
  onJumpToPanel: (panelId: string) => void
  // context+ 関連: GroupNav 内のサマリ近くに置くことで視認性を上げる
  channelsEnabled: boolean
  ctxDisabled: boolean
  ctxTooltip: string
  isPendingHere: boolean
  onRequestContext: (groupId: string, direction: 'more' | 'less') => void
}

export function GroupNav({
  index, total, groupId, title, description, panels, reviewedPanels, onJumpToPanel,
  channelsEnabled, ctxDisabled, ctxTooltip, isPendingHere, onRequestContext,
}: Props) {
  const num = String(index + 1).padStart(2, '0')
  const tot = String(total).padStart(2, '0')
  const descHtml = renderMarkdown(description || '')

  const reviewedCount = useMemo(
    () => panels.filter((p) => reviewedPanels.has(p.panelId)).length,
    [panels, reviewedPanels],
  )
  const progressPct = panels.length === 0 ? 0 : Math.round((reviewedCount / panels.length) * 100)

  // scroll spy: 現在読んでいる panel を IntersectionObserver で追跡
  const activePanelId = useScrollSpy(panels)

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
        </div>
        <h2 className="group-title">{title}</h2>
        {descHtml ? (
          <div className="group-desc" dangerouslySetInnerHTML={{ __html: descHtml }} />
        ) : null}

        {panels.length > 0 ? (
          <div
            className="group-progress"
            role="meter"
            aria-valuenow={reviewedCount}
            aria-valuemin={0}
            aria-valuemax={panels.length}
            aria-label={`${reviewedCount} of ${panels.length} panels reviewed`}
          >
            <div className="group-progress-track">
              <div
                className="group-progress-fill"
                style={{ width: `${progressPct}%` }}
                data-complete={progressPct === 100 ? 'true' : 'false'}
              />
            </div>
            <div className="group-progress-meta">
              <span className="group-progress-count">
                <span className="group-progress-count-cur">{reviewedCount}</span>
                <span className="group-progress-count-sep">/</span>
                <span className="group-progress-count-tot">{panels.length}</span>
              </span>
              <span className="group-progress-label">
                {progressPct === 100 ? 'reviewed' : 'reviewed'}
              </span>
            </div>
          </div>
        ) : null}
      </header>

      {channelsEnabled ? (
        <div className="group-context-actions" role="group" aria-label="Request more context">
          <button
            type="button"
            className={`btn-context${isPendingHere ? ' is-pending' : ''}`}
            disabled={ctxDisabled}
            title={ctxTooltip}
            onClick={() => onRequestContext(groupId, 'more')}
            aria-busy={isPendingHere}
          >
            <span className="btn-context-icon" aria-hidden="true">
              {isPendingHere ? <SpinnerIcon /> : <PlusIcon />}
            </span>
            <span className="btn-context-label">
              {isPendingHere ? 'Regenerating' : 'More context'}
            </span>
          </button>
        </div>
      ) : null}

      {panels.length ? (
        <nav className="group-panel-list" aria-label="Panels in this group">
          {panels.map((p) => (
            <PanelItem
              key={p.panelId}
              panel={p}
              reviewed={reviewedPanels.has(p.panelId)}
              active={activePanelId === p.panelId}
              onJump={onJumpToPanel}
            />
          ))}
        </nav>
      ) : null}
    </aside>
  )
}

function PanelItem({
  panel, reviewed, active, onJump,
}: {
  panel: RenderedPanel
  reviewed: boolean
  active: boolean
  onJump: (panelId: string) => void
}) {
  const asIs = panel.asIs?.file
  const toBe = panel.toBe?.file
  const className = [
    'group-panel-item',
    reviewed ? 'is-reviewed' : '',
    active ? 'is-active' : '',
  ].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={className}
      onClick={() => onJump(panel.panelId)}
      title={panel.intent}
      aria-current={active ? 'true' : undefined}
    >
      {/* dot indicator: reviewed = filled / unread = ring。Linear の sidebar 既読 dot と同じ語彙。
          active 時は dot が accent 色化して「今ここ」を強調する。 */}
      <span className="panel-item-indicator" aria-hidden="true">
        {reviewed ? <CheckDotIcon /> : <RingDotIcon />}
      </span>
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
  )
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx < 0 ? p : p.slice(idx + 1)
}

// ---------- scroll spy hook ----------
// panels 配列が変わるたびに IntersectionObserver を張り直す。
// rootMargin: 上 30% / 下 50% を死角にして、画面上から 30% の位置に来た panel を active 扱い。
// これは Linear の docs sidebar や VSCode の outline panel と同じパターン。
function useScrollSpy(panels: RenderedPanel[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    if (panels.length === 0) return
    // 各 panel の可視率を追跡し、最も viewport 上部に近い (= panels[] 順で最初の visible) を active 化
    const visibility = new Map<string, boolean>()
    const ids = panels.map((p) => p.panelId)
    const observers: IntersectionObserver[] = []
    const recompute = () => {
      const first = ids.find((id) => visibility.get(id))
      setActiveId(first ?? null)
    }
    for (const id of ids) {
      // .panel-block セレクタで anchor 対象を限定 (Panel 自身の <div data-panel-id> と衝突回避)
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

// CSS.escape の polyfill (古いブラウザ向け defensive)。
// panelId は通常 [A-Za-z0-9_-] のみだが、AI が summary.json で記号入れる可能性に備える。
function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
  return s.replace(/[^A-Za-z0-9_-]/g, '\\$&')
}

// ---------- inline SVG icons ----------
// アイコンは独立ファイルにせず inline で持つ。サイズが小さい (4 個 x ~10 行) ので bundle 影響微小、
// CSS の color (currentColor) で active / disabled に追従させる方が綺麗。

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6 2v8M2 6h8" />
    </svg>
  )
}

function SpinnerIcon() {
  // CSS animation で回転。SVG 自体は static、styles.css 側で keyframes 適用。
  return (
    <svg className="spin" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6 1.5 a4.5 4.5 0 1 1 -3.18 1.32" />
    </svg>
  )
}

function CheckDotIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="5" fill="currentColor" />
      <path d="M3.6 6.2 5 7.6 8.4 4.2" stroke="var(--background)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
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
