// アプリのトップレベル (v4.8.0 panel model + close-relaunch context+)。
//
// 設計判断:
//   - groups[].panels[] を素直に並べる単一スクロール (Linear Guide タブ風)
//   - Reviewed の単位は file ではなく **panelId** (= reviewedPanels[])
//   - Comment の構造は scope union ({type:'overall'} / {type:'line', panelId, side, file, line, endLine?})
//   - v4.8.0: Channels SSE 経路を全廃。context+ ボタンは「現在 state を回収して POST /result に
//     `decision: 'regen-group'` を送る → window.close() → SKILL.md 側で summary.json の該当 group
//     の panels を ±N 行広げて再生成 → restore JSON を渡しつつ Skill 再起動」のループに変更。
//     initialReviewedPanels / initialComments / initialLineCommentDrafts を payload から受け取って
//     useState 初期化 + sessionStorage 書き戻しで前回状態をシームレスに復元する。
//   - AI Review Report カード (page-header) は plan-reviewer C-2 で保持

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClientPayload,
  Comment,
  DisplayRange,
  PrMeta,
  RenderedPanel,
  ResultJson,
} from '@zeus/review-diff-shared'
import { TabBar } from './TabBar'
import { GroupSection } from './GroupSection'
import { ActionBar } from './ActionBar'
import { SubmitModal } from './SubmitModal'
import { renderMarkdown, escapeHtml } from './markdown'
import { getToken, lineCommentKey, parseLineCommentKey } from './state'
import { useLineComments } from './useLineComments'

const NAV_WIDTH_MIN = 240
const NAV_WIDTH_MAX = 480

type Props = { payload: ClientPayload }
type Tab = 'activity' | 'guide' | 'diff'

// App ローカルの group state。v4.8.0 で SSE による in-place 差し替えが無くなったので
// payload.groups から 1 回だけ初期化すれば足りる (regen は close-relaunch で別プロセスへ)。
// それでも useState 持ちにしておくのは、将来 in-process な local edit (panel 並べ替え等) を
// 入れる時にスムーズに拡張できるようにするため。
type AppGroup = {
  groupId: string
  title: string
  description: string
  panels: RenderedPanel[]
}

export function App({ payload }: Props) {
  const [groupsState] = useState<AppGroup[]>(() =>
    payload.groups.map((g, i) => ({
      // W-1: CLI が `g${i}` で生成する RenderedGroup.groupId を優先採用。
      // 古い payload (groupId 未設定) や test fixture 互換のため title / index fallback も残す。
      groupId: g.groupId || g.title || `group-${i}`,
      title: g.title,
      description: g.description,
      panels: g.panels,
    })),
  )

  // initial state seed: payload.initialLineCommentDrafts を sessionStorage に書き戻し、
  // CommentForm が mount 時にそれを読んで draft フィールドを復元する。
  // useEffect ではなく useState の lazy initializer で 1 回だけ実行することで、
  // mount 後の re-render で重複書き込みされる事故を防ぐ (副作用だが mount-time guard 相当)。
  useState(() => {
    if (typeof sessionStorage === 'undefined') return null
    const drafts = payload.initialLineCommentDrafts
    if (!drafts) return null
    try {
      for (const [k, v] of Object.entries(drafts)) {
        if (typeof v === 'string' && v !== '') sessionStorage.setItem(k, v)
      }
    } catch { /* storage unavailable */ }
    return null
  })

  // 前回の line comments (saved) を useLineComments の seed にする。
  // payload.initialComments のうち scope.type === 'line' のものだけが対象。overall は
  // submit modal の input に流したいが、modal の入力欄まで貫通する fan は重いので
  // 一旦 overall は捨てる (regen-group のループでは AI が再 review する前提)。
  const initialLineCommentsMap = useMemo(() => {
    const m = new Map<string, string[]>()
    const list = payload.initialComments
    if (!list) return m
    for (const c of list) {
      if (c.scope.type !== 'line') continue
      const key = lineCommentKey(c.scope.panelId, c.scope.side, c.scope.line, c.scope.endLine)
      const arr = m.get(key) ?? []
      arr.push(c.body)
      m.set(key, arr)
    }
    return m
  }, [payload.initialComments])

  const [reviewedPanels, setReviewedPanels] = useState<Set<string>>(
    () => new Set(payload.initialReviewedPanels ?? []),
  )
  const lineCommentHandlers = useLineComments({ lineComments: initialLineCommentsMap })
  const [tab, setTab] = useState<Tab>('guide')
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<null | 'approve' | 'reject' | 'regen'>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [modalDecision, setModalDecision] = useState<null | 'approve' | 'reject'>(null)
  // 連打防止 + ボタン disable 用フラグ。close-relaunch は 1 回しか走らないが、ユーザーが
  // 連打した時に setTimeout(window.close) が複数回走って未確定の close が混乱するのを防ぐ。
  const [regenPending, setRegenPending] = useState(false)

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

  // sessionStorage 全体を走査して `draft:` prefix の値を Record にまとめる。
  // regen-group POST 時の lineCommentDrafts に乗せて、SKILL.md 側に渡す → restore JSON に書き出す。
  // 値が空文字列の draft は除外 (UI 上「書きかけ無し」の状態と等価)。
  function collectAllDrafts(): Record<string, string> {
    const out: Record<string, string> = {}
    if (typeof sessionStorage === 'undefined') return out
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i)
        if (!k || !k.startsWith('draft:')) continue
        const v = sessionStorage.getItem(k)
        if (typeof v === 'string' && v !== '') out[k] = v
      }
    } catch { /* storage unavailable */ }
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
        } satisfies ResultJson),
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

  // v4.8.0: context+ ボタンの新動作。現状 state (Reviewed + line comments + 未保存 draft) を
  // 回収し、decision='regen-group' で POST /result に送ってから window.close()。
  // SKILL.md 側がこれを受けて summary.json の panels[] を「より広い context」で再生成し、
  // restore JSON を渡しつつ Skill 再起動するループに繋がる。
  const onRequestContext = useCallback(
    async (groupId: string) => {
      if (regenPending || submitted) return
      const g = groupsState.find(x => x.groupId === groupId)
      if (!g) return
      setRegenPending(true)
      const currentRanges: Array<{
        panelId: string
        asIs?: { file: string; ranges: DisplayRange[] }
        toBe?: { file: string; ranges: DisplayRange[] }
      }> = g.panels.map(p => ({
        panelId: p.panelId,
        asIs: p.asIs ? { file: p.asIs.file, ranges: p.asIs.ranges } : undefined,
        toBe: p.toBe ? { file: p.toBe.file, ranges: p.toBe.ranges } : undefined,
      }))
      const cs = collectComments('')
      const drafts = collectAllDrafts()
      const body: ResultJson = {
        decision: 'regen-group',
        reviewedPanels: Array.from(reviewedPanels),
        comments: cs,
        regenGroup: { groupId, currentRanges },
        lineCommentDrafts: drafts,
      }
      try {
        await fetch(`/result?token=${encodeURIComponent(tokenRef.current)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        setSubmitted('regen')
        // SKILL.md が新しい summary.json で再起動してくれる前提。window.close で UI を畳む。
        setTimeout(() => {
          try { window.close() } catch { /* noop */ }
        }, 300)
      } catch {
        setRegenPending(false)
        setToast('Failed to request context expansion.')
        setTimeout(() => setToast(null), 3000)
      }
    },
    [groupsState, reviewedPanels, regenPending, submitted, lineCommentHandlers.lineComments],
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
    const msg = submitted === 'regen'
      ? 'Requesting context expansion. You can close this tab — review will re-open with the expanded panels.'
      : `${submitted} received. You can close this tab.`
    return <div className="done">{msg}</div>
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
            regenPending={regenPending}
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
