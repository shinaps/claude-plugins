// アプリのトップレベル (v4.7.0 panel model)。
//
// 設計判断:
//   - groups[].panels[] を素直に並べる単一スクロール (Linear Guide タブ風)
//   - Reviewed の単位は file ではなく **panelId** (= reviewedPanels[])
//   - Comment の構造は scope union ({type:'overall'} / {type:'line', panelId, side, file, line, endLine?})
//   - Channels: useChannelSSE で /events/browser 購読 + /feedback POST。
//     channelsEnabled=false なら status='disabled' で context+/- ボタンは disabled
//   - 'panels-updated' を受けたら setGroupsState で **groupId 単位** の panels を差し替える
//     (panelId 集合が変わったら orphan draft purge も自動)
//   - AI Review Report カード (page-header) は plan-reviewer C-2 で保持

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClientPayload,
  Comment,
  Panel,
  PrMeta,
  RenderedPanel,
} from '@zeus/review-diff-shared'
import { TabBar } from './TabBar'
import { GroupSection } from './GroupSection'
import { ActionBar } from './ActionBar'
import { SubmitModal } from './SubmitModal'
import { renderMarkdown, escapeHtml } from './markdown'
import { getToken, parseLineCommentKey } from './state'
import { useLineComments } from './useLineComments'
import { useChannelSSE, type CurrentRange } from './useChannelSSE'

const NAV_WIDTH_MIN = 240
const NAV_WIDTH_MAX = 480

type Props = { payload: ClientPayload }
type Tab = 'activity' | 'guide' | 'diff'

// App ローカルの group state。client 側で panels-updated を受けて差し替えるため
// payload.groups をそのまま使わず useState で持つ。groupId === group title を使う
// (現 schema では group に明示的 id field が無い)。
type AppGroup = {
  groupId: string
  title: string
  description: string
  panels: RenderedPanel[]
}

export function App({ payload }: Props) {
  const [groupsState, setGroupsState] = useState<AppGroup[]>(() =>
    payload.groups.map((g, i) => ({
      // 現 SummaryJson.Group には id field が無いため、title をそのまま groupId として使う。
      // title が重複する場合は index suffix を付けて衝突回避。
      groupId: g.title || `group-${i}`,
      title: g.title,
      description: g.description,
      panels: g.panels,
    })),
  )

  // groupId → その group が現在持つ panelId 集合のゲッタ用 ref。
  // useChannelSSE は panels-updated 受信時に **受信 groupId に対応する旧 panel 集合だけ** を
  // orphan draft purge の oldIds として使う必要がある。全 group flatten を渡すと、SSE で 1
  // group を更新するたびに他 group の panel が「oldIds にあり newIds に無い」と誤判定され、
  // 巻き添えで他 group の draft が消える事故が起きる (C-1)。ref で常に最新の groupsState を
  // 参照することで stale closure も避ける。
  const groupsStateRef = useRef(groupsState)
  groupsStateRef.current = groupsState
  const getPanelIdsForGroup = useCallback((groupId: string): Set<string> => {
    const s = new Set<string>()
    const g = groupsStateRef.current.find(x => x.groupId === groupId)
    if (g) for (const p of g.panels) s.add(p.panelId)
    return s
  }, [])

  // panels-updated 受信時の handler。指定 groupId の panels を差し替える。
  // 注: payload.panels は Panel[] (RenderedPanel ではない) で、segments を持たない。
  // sources を持たない CLIENT 側では re-render できないため、暫定で intent + asIs/toBe だけ
  // 上書きし、segments は前回のものを引き継ぐ (理想は CLI が renderPanel を再実行して
  // /channel/inbox に RenderedPanel を流すが、それは v4.7.x で対応)。
  const handlePanelsUpdated = useCallback((groupId: string, panels: Array<{ panelId: string }>) => {
    setGroupsState(prev => prev.map(g => {
      if (g.groupId !== groupId) return g
      // 受信 panels (Panel shape) と前回 RenderedPanel をマージ。新規 panelId は segments 空で追加。
      const prevById = new Map(g.panels.map(p => [p.panelId, p]))
      const nextPanels: RenderedPanel[] = panels.map(received => {
        const prevP = prevById.get(received.panelId)
        const r = received as Panel
        return {
          panelId: r.panelId,
          intent: r.intent,
          asIs: r.asIs,
          toBe: r.toBe,
          segments: prevP?.segments ?? [],
          asIsLanguage: prevP?.asIsLanguage,
          toBeLanguage: prevP?.toBeLanguage,
          asIsTotal: prevP?.asIsTotal,
          toBeTotal: prevP?.toBeTotal,
        }
      })
      return { ...g, panels: nextPanels }
    }))
  }, [])

  // Channels SSE 接続。enabled=false なら no-op で status='disabled'。
  const channelsEnabled = payload.channelsEnabled
  const channel = useChannelSSE({
    enabled: channelsEnabled,
    browserToken: payload.browserToken,
    sessionId: payload.sessionId,
    getPanelIdsForGroup,
    onPanelsUpdated: handlePanelsUpdated,
  })

  const [reviewedPanels, setReviewedPanels] = useState<Set<string>>(() => new Set())
  const lineCommentHandlers = useLineComments()
  const [tab, setTab] = useState<Tab>('guide')
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<null | 'approve' | 'reject'>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [modalDecision, setModalDecision] = useState<null | 'approve' | 'reject'>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<string>(getToken())

  // panelId → 所属 file (overall comment の file 併記用)
  const panelFileMap = useMemo(() => {
    const m = new Map<string, { asIsFile?: string; toBeFile?: string }>()
    for (const g of groupsState) for (const p of g.panels) {
      m.set(p.panelId, { asIsFile: p.asIs?.file, toBeFile: p.toBe?.file })
    }
    return m
  }, [groupsState])

  useEffect(() => {
    if (!scrollTarget) return
    const sel = `.panel-block[data-panel-id="${cssEscape(scrollTarget)}"]`
    const el = containerRef.current?.querySelector(sel) as HTMLElement | null
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setScrollTarget(null)
  }, [scrollTarget])

  const toggleReviewed = useCallback((panelId: string, next: boolean) => {
    setReviewedPanels(prev => {
      const out = new Set(prev)
      if (next) out.add(panelId)
      else out.delete(panelId)
      return out
    })
  }, [])

  function markAll() {
    setReviewedPanels(new Set(payload.allPanels))
  }

  function jumpToPanel(panelId: string) {
    setScrollTarget(panelId)
  }

  // submit する Comment[] を構築。
  // overall は scope: {type:'overall'}、行コメントは scope: {type:'line', panelId, side, file, line, endLine?}。
  // file は panel の side に対応する file (asIs.file / toBe.file) を入れる。
  function collectComments(overallBody: string): Comment[] {
    const out: Comment[] = []
    const g = overallBody.trim()
    if (g) out.push({ body: g, scope: { type: 'overall' } })
    for (const [key, bodies] of lineCommentHandlers.lineComments) {
      const { panelId, side, number, endNumber } = parseLineCommentKey(key)
      const files = panelFileMap.get(panelId) ?? {}
      const file = side === 'asIs'
        ? (files.asIsFile ?? files.toBeFile ?? '')
        : (files.toBeFile ?? files.asIsFile ?? '')
      for (const body of bodies) {
        const trimmed = body.trim()
        if (!trimmed) continue
        out.push({
          body: trimmed,
          scope: {
            type: 'line',
            panelId,
            side,
            file,
            line: number,
            ...(endNumber != null && endNumber !== number ? { endLine: endNumber } : {}),
          },
        })
      }
    }
    return out
  }

  async function submit(decision: 'approve' | 'reject', overallBody: string) {
    if (submitted) return
    const cs = collectComments(overallBody)
    try {
      await fetch(`/result?token=${encodeURIComponent(tokenRef.current)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          reviewedPanels: Array.from(reviewedPanels),
          comments: cs,
        }),
      })
      setSubmitted(decision)
      setModalDecision(null)
      setTimeout(() => {
        try { window.close() } catch { /* noop */ }
      }, 300)
    } catch {
      setToast('Failed to submit.')
      setTimeout(() => setToast(null), 3000)
    }
  }

  // group ごとの context+/- ハンドラ。currentRanges を集約してから sendFeedback。
  const onRequestContext = useCallback(
    (groupId: string, direction: 'more' | 'less') => {
      const g = groupsState.find(x => x.groupId === groupId)
      if (!g) return
      const currentRanges: CurrentRange[] = g.panels.map(p => ({
        panelId: p.panelId,
        asIs: p.asIs ? { file: p.asIs.file, ranges: p.asIs.ranges } : undefined,
        toBe: p.toBe ? { file: p.toBe.file, ranges: p.toBe.ranges } : undefined,
      }))
      void channel.sendFeedback(groupId, direction, currentRanges)
    },
    [groupsState, channel],
  )

  // nav resizer (旧 App から流用、CSS variable 直接書き込み + rAF batch)
  const onNavResizerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const resizer = e.currentTarget
    const pointerId = e.pointerId
    const container = containerRef.current
    if (!container) return
    const section = resizer.closest('.group-section') as HTMLElement | null
    if (!section) return

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    resizer.classList.add('dragging')
    try { resizer.setPointerCapture(pointerId) } catch { /* noop */ }

    let rafId: number | null = null
    let pendingClientX = 0
    function flush() {
      rafId = null
      if (!container) return
      const sectionLeft = section!.getBoundingClientRect().left
      const next = pendingClientX - sectionLeft
      const clamped = Math.max(NAV_WIDTH_MIN, Math.min(NAV_WIDTH_MAX, next))
      container.style.setProperty('--nav-width', `${clamped}px`)
    }
    function onMove(ev: PointerEvent) {
      pendingClientX = ev.clientX
      if (rafId !== null) return
      rafId = requestAnimationFrame(flush)
    }
    function onUp() {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      resizer.classList.remove('dragging')
      try { resizer.releasePointerCapture(pointerId) } catch { /* noop */ }
      resizer.removeEventListener('pointermove', onMove)
      resizer.removeEventListener('pointerup', onUp)
      resizer.removeEventListener('pointercancel', onUp)
    }
    resizer.addEventListener('pointermove', onMove)
    resizer.addEventListener('pointerup', onUp)
    resizer.addEventListener('pointercancel', onUp)
  }, [])

  if (submitted) {
    return <div className="done">{submitted} received. You can close this tab.</div>
  }

  const meta = formatMeta(payload)
  const overallHtml = renderMarkdown(payload.summary.overallSummary || '')
  const title = payload.prMeta
    ? payload.prMeta.title
    : payload.summary.mode === 'staged'
      ? 'Staged Diff Review'
      : 'Diff Review'

  return (
    <>
      <TabBar
        active={tab}
        onChange={setTab}
        meta={`${payload.allPanels.length} panel${payload.allPanels.length === 1 ? '' : 's'}`}
      />
      <div className="page-header">
        {/* AI Review Report カード (plan-reviewer C-2 で保持) */}
        <div className="report-card">
          <div className="report-card-eyebrow">AI Review Report</div>
          <h1>{title}</h1>
          <div className="meta" dangerouslySetInnerHTML={{ __html: meta }} />
          {overallHtml ? (
            <div className="markdown" dangerouslySetInnerHTML={{ __html: overallHtml }} />
          ) : null}
          {groupsState.length > 0 ? (
            <ul className="report-index">
              {groupsState.map((g, i) => (
                <li key={g.groupId}>
                  <button
                    type="button"
                    className="report-index-item"
                    onClick={() => g.panels[0] && jumpToPanel(g.panels[0].panelId)}
                    aria-label={`Jump to group ${i + 1}: ${g.title}`}
                  >
                    <span className="report-index-number">{String(i + 1).padStart(2, '0')}</span>
                    <span className="report-index-title">{g.title}</span>
                    <span className="report-index-meta">
                      {g.panels.length} panel{g.panels.length === 1 ? '' : 's'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="groups-container" ref={containerRef}>
        {groupsState.map((g, i) => (
          <GroupSection
            key={g.groupId}
            index={i}
            total={groupsState.length}
            groupId={g.groupId}
            title={g.title}
            description={g.description}
            panels={g.panels}
            reviewedPanels={reviewedPanels}
            onJumpToPanel={jumpToPanel}
            onToggleReviewed={toggleReviewed}
            onNavResizerPointerDown={onNavResizerPointerDown}
            channelsEnabled={channelsEnabled}
            channelStatus={channel.status}
            pendingGroupId={channel.pendingGroupId}
            onRequestContext={onRequestContext}
            {...lineCommentHandlers}
          />
        ))}
      </div>
      <ActionBar
        reviewedCount={reviewedPanels.size}
        totalPanels={payload.allPanels.length}
        onMarkAll={markAll}
        onApprove={() => setModalDecision('approve')}
        onReject={() => setModalDecision('reject')}
      />
      {modalDecision ? (
        <SubmitModal
          decision={modalDecision}
          onCancel={() => setModalDecision(null)}
          onConfirm={(body) => submit(modalDecision, body)}
        />
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </>
  )
}

function formatMeta(payload: ClientPayload): string {
  const pr: PrMeta | null = payload.prMeta
  if (pr) {
    const author = typeof pr.author === 'string' ? pr.author : (pr.author?.login ?? '')
    return `PR #${pr.number} · ${escapeHtml(author)} · ${escapeHtml(pr.headRefName || '')} → ${escapeHtml(pr.baseRefName || '')}`
  }
  return `${payload.summary.mode === 'staged' ? 'staged diff' : 'diff'} · ${payload.allPanels.length} panel${payload.allPanels.length === 1 ? '' : 's'}`
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
  return s.replace(/["\\]/g, '\\$&')
}
