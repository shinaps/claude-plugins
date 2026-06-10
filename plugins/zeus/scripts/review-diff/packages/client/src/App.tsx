// アプリのトップレベル (stacked PR 風 group ベース承認モデル)。
//
// 設計判断:
//   - groups[].panels[] を素直に並べる単一スクロール (Linear Guide タブ風)
//   - 評価単位は **group** (= groupDecisions: Record<groupId, 'approved' | 'request-changes' | null>)。
//     panel 単位 Reviewed は廃止し、AI が決めた group の切り方に沿って人間が判断する
//   - group コメントは GroupNav 内に colocate (decision section)。textarea 入力は App ルート state を
//     useCallback + spread 更新で安定化させ、再 render 嵐を防ぐ
//   - Submit Review は全 group decision 確定時のみ active 化 (panels=0 group は自動 approved 扱い)
//   - panels=0 group は decision 不要 (UI 上 disable)、自動 approved 扱いで Submit ゲートを通す
//   - context+ ボタンは「現状 state を回収して POST /result に decision='regen-group' を送る
//     → window.close() → SKILL.md 側で summary.json を再生成 → restore JSON を渡しつつ Skill 再起動」
//     のループ。group decision / group comment / line comment / 未保存 draft 全てを restore する

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import type {
  ClientPayload,
  Comment,
  DisplayRange,
  GroupDecision,
  PrMeta,
  RenderedPanel,
  ResultJson,
  ReviewKind,
} from '@zeus/review-diff-shared'
import type { ThreadMessage, ThreadSnapshot } from '@zeus/review-diff-shared'
import { threadKey } from '@zeus/review-diff-shared'
import { TabBar } from './TabBar'
import { GroupSection } from './GroupSection'
import { PanelBlock } from './PanelBlock'
import { SubmitBar } from './SubmitBar'
import { ChunkNavigator } from './ChunkNavigator'
import { ActivityView } from './ActivityView'
import { shouldAutoCollapseFile } from './auto-collapse'

// Diff タブで初期 collapsed にする行数の閾値。Guide タブと違って 1 panel = 1 file 全体なので
// 「ちょっとした変更でもファイル全部表示」になりがち。閾値を低めに振って俯瞰時の応答性を確保。
const DIFF_TAB_COLLAPSE_ROW_THRESHOLD = 200
import { renderMarkdown, escapeHtml } from './markdown'
import { getToken, lineCommentKey, parseLineCommentKey } from './state'
import { useLineComments } from './useLineComments'

const NAV_WIDTH_MIN = 240
const NAV_WIDTH_MAX = 480

type Props = { payload: ClientPayload }
type Tab = 'activity' | 'guide' | 'diff'

// App ローカルの group state。
type AppGroup = {
  groupId: string
  title: string
  description: string
  panels: RenderedPanel[]
}

export function App({ payload }: Props) {
  const [groupsState] = useState<AppGroup[]>(() =>
    payload.groups.map((g, i) => ({
      groupId: g.groupId || g.title || `group-${i}`,
      title: g.title,
      description: g.description,
      panels: g.panels,
    })),
  )

  // initial state seed: payload.initialLineCommentDrafts を sessionStorage に書き戻し、
  // CommentForm が mount 時にそれを読んで draft フィールドを復元する。
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
  // payload.initialComments は CLI 側で pre-filter 済み (scope.type === 'line' のみ)。
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

  // group decision state。
  // panels.length === 0 の group は自動 approved 扱い (W-6): UI で decision 不要、
  // Submit active 条件もこれで満たす。restore が来てもこれより自動 approved を優先する。
  const [groupDecisions, setGroupDecisions] = useState<Record<string, GroupDecision | null>>(() => {
    const init: Record<string, GroupDecision | null> = {}
    for (const g of groupsState) {
      if (g.panels.length === 0) {
        init[g.groupId] = 'approved'
        continue
      }
      const restored = payload.initialGroupDecisions?.[g.groupId]
      init[g.groupId] = restored ?? null
    }
    return init
  })
  const [groupComments, setGroupComments] = useState<Record<string, string>>(
    () => payload.initialGroupComments ?? {},
  )

  // 会話スレッド (group / line scope)。GitHub の pending review と同じく、group の Comment ボタンは
  // ここに user message を「積む」だけでレビューを継続できる。Claude への送信 (= close-relaunch) は
  // SubmitBar の Comment / Submit に同乗して一括で行う。
  const [threads, setThreads] = useState<Record<string, ThreadSnapshot>>(
    () => payload.initialThreads ?? {},
  )

  // group コメントを pending としてスレッドに積み、textarea をクリアする。
  // textarea クリアは「同じ本文が submit 時の comments[] にも入って二重 thread 化される」のを防ぐ意図。
  const addGroupComment = useCallback((groupId: string) => {
    const body = (groupComments[groupId] ?? '').trim()
    if (!body) return
    const key = threadKey({ type: 'group', groupId })
    const msg: ThreadMessage = { id: crypto.randomUUID(), author: 'user', body, ts: Date.now() }
    setThreads(prev => {
      const existing = prev[key]
      const snap: ThreadSnapshot = existing
        // 追記時は resolved を倒す (返信待ちの open スレッドに戻す)
        ? { ...existing, messages: [...existing.messages, msg], resolved: false }
        : { scope: { type: 'group', groupId }, messages: [msg], resolved: false, outdated: false }
      return { ...prev, [key]: snap }
    })
    setGroupComments(prev => ({ ...prev, [groupId]: '' }))
  }, [groupComments])

  // 読了マーカ (panel 単位): group decision とは別軸の視覚アシスト。
  // 左 nav の dot を click したら toggle。ResultJson には載せない (= 読了状態は session-local)。
  // 将来 regen-group の restore に乗せたい場合は payload.initialReviewedPanels を seed する。
  const [reviewedPanels, setReviewedPanels] = useState<Set<string>>(
    () => new Set(payload.initialReviewedPanels ?? []),
  )

  const lineCommentHandlers = useLineComments({ lineComments: initialLineCommentsMap })
  // 初期タブは Activity (AI Review Report をまず俯瞰してから Guide で詳細を進める動線)
  const [tab, setTab] = useState<Tab>('activity')
  // 訪問済みタブを追跡: 一度 mount したタブは content-visibility: hidden で隠して保持し、
  // 次回切替を即時化する。Guide / Diff は 28 panel × 数千行 = 数万 DOM のレンダリングコストがあるため、
  // 毎回 mount/unmount すると切替に数秒かかる (LoAF 実測 6 秒級)。
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(() => new Set(['activity']))
  useEffect(() => {
    setVisitedTabs(prev => {
      if (prev.has(tab)) return prev
      const out = new Set(prev)
      out.add(tab)
      return out
    })
  }, [tab])

  // タブ毎のスクロール位置を保存・復元 (Guide と Diff で独立スクロール)。
  // 同じ document scroll を共有しているので、タブ切替前後で window.scrollY を save → restore する。
  // ref で保持して setState を伴わない (再 render を引き起こさない)。
  const scrollPositionsRef = useRef<Map<Tab, number>>(new Map())
  const prevTabRef = useRef<Tab>('activity')
  useEffect(() => {
    // 旧タブの位置を保存し、新タブの保存位置 (or 0) に復元する。
    // ブラウザの scroll restoration が tab change で介入しないよう instant で書き戻す。
    scrollPositionsRef.current.set(prevTabRef.current, window.scrollY)
    const target = scrollPositionsRef.current.get(tab) ?? 0
    // 即座の scrollTo は新タブの DOM 準備が間に合わないと無視されるので rAF を待つ
    requestAnimationFrame(() => {
      window.scrollTo({ top: target, behavior: 'instant' as ScrollBehavior })
    })
    prevTabRef.current = tab
  }, [tab])

  // Guide タブの prewarm: Activity 初回表示の安定後に background mount。
  // 初回 click 時の 600〜1000ms 遅延を「ユーザーが Activity を読んでいる時間」に隠す。
  // setTimeout 1500ms は Activity 初期 paint + reflow の安定を待つ目安。
  // ブラウザが requestIdleCallback 対応ならそれを優先 (より「重くない」タイミングで実行)。
  useEffect(() => {
    let cancelled = false
    const prewarmGuide = () => {
      if (cancelled) return
      setVisitedTabs(prev => {
        if (prev.has('guide')) return prev
        const next = new Set(prev)
        next.add('guide')
        return next
      })
    }
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (h: number) => void
    }
    let cancel: () => void
    if (typeof w.requestIdleCallback === 'function') {
      const handle = w.requestIdleCallback(prewarmGuide, { timeout: 3000 })
      cancel = () => w.cancelIdleCallback?.(handle)
    } else {
      const handle = window.setTimeout(prewarmGuide, 1500)
      cancel = () => window.clearTimeout(handle)
    }
    return () => {
      cancelled = true
      cancel()
    }
  }, [])

  // タブ切替は重い render を伴うため React 18 の concurrent transition で非緊急化する。
  // click → setTab() を urgent state update のまま実行すると click event handler 内で
  // 同期 render が走り、その間 input が無反応になる (INP poor)。startTransition でラップすると:
  //   - click → 旧 UI が一瞬残る (isPending=true)
  //   - 新 UI render は background で進む (interrupt 可)
  // 結果として INP が劇的に改善 (実測 6500ms → 16ms)。
  // 注意: TabBar 内 input への state update には使ってはいけない (textarea のキー入力が遅延する)。
  const [isPending, startTransition] = useTransition()
  const onTabChange = useCallback((next: Tab) => {
    startTransition(() => setTab(next))
  }, [])
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<null | 'submit' | 'comment' | 'regen'>(null)
  const [toast, setToast] = useState<string | null>(null)

  // v5: EditorLinkTrigger から Toast を呼ぶための window グローバルチャネルを設定。
  // prop drilling (App → ChunkNavigator → PanelBlock → Panel → SideRow → EditorLinkTrigger) を避ける。
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__reviewDiffShowToast = (msg: string) => {
      setToast(msg)
      setTimeout(() => setToast(null), 2000)
    }
    return () => {
      if (typeof window !== 'undefined') delete window.__reviewDiffShowToast
    }
  }, [])
  // 連打防止 + ボタン disable 用フラグ
  const [regenPending, setRegenPending] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<string>(getToken())

  // panelId → 所属 file (line comment の file 併記用)
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

  const onDecisionChange = useCallback((id: string, next: GroupDecision | null) => {
    // v5.0.3: ユーザー操作で decision が変わった瞬間に auto-submit を arm する。
    // restore 経由の初期状態が全埋まりでも、ここを経由しない限り発火しない。
    autoSubmitArmedRef.current = true
    setGroupDecisions(prev => ({ ...prev, [id]: next }))
    // decision 確定 (approved / request-changes どちらも) で次 group に自動スクロール。
    // RC でも遷移させる理由: RC を付けた後にユーザーがその場に留まる強い動機は無く、むしろ
    // 次の group のレビューに進めた方が手数が減る。解除 (null) は意図的に「気が変わった」操作なので
    // scroll しない。最後の group では次が無いので scroll しない。
    // setState 直後に DOM 更新待ちが必要なので rAF で 1 フレーム待つ。
    if (next === 'approved' || next === 'request-changes') {
      const idx = groupsState.findIndex(g => g.groupId === id)
      if (idx >= 0 && idx < groupsState.length - 1) {
        const target = groupsState[idx + 1]
        requestAnimationFrame(() => {
          const sel = `.group-section[data-group-id="${cssEscape(target.groupId)}"]`
          const el = containerRef.current?.querySelector(sel) as HTMLElement | null
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      }
    }
  }, [groupsState])

  const onCommentChange = useCallback((id: string, body: string) => {
    setGroupComments(prev => {
      // 空文字列なら entry を削除して payload を綺麗に保つ
      if (body === '') {
        const out = { ...prev }
        delete out[id]
        return out
      }
      return { ...prev, [id]: body }
    })
  }, [])

  const onToggleReviewed = useCallback((panelId: string) => {
    setReviewedPanels(prev => {
      const out = new Set(prev)
      if (out.has(panelId)) out.delete(panelId)
      else out.add(panelId)
      return out
    })
  }, [])

  function jumpToPanel(panelId: string) {
    setScrollTarget(panelId)
  }

  // グループ間ナビゲーション: 左 nav の prev/next 矢印から呼ばれる。
  // index ベースで scrollIntoView を呼ぶ。groupsState の長さでクランプ済み前提だが防御的に。
  const onJumpToGroupIndex = useCallback((targetIndex: number) => {
    if (targetIndex < 0 || targetIndex >= groupsState.length) return
    const target = groupsState[targetIndex]
    const sel = `.group-section[data-group-id="${cssEscape(target.groupId)}"]`
    const el = containerRef.current?.querySelector(sel) as HTMLElement | null
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [groupsState])

  // submit する Comment[] を構築。
  // - group コメント (空でないもの) を scope: {type:'group', groupId} で
  // - line コメント を scope: {type:'line', panelId, side, file, line, endLine?} で
  function collectComments(): Comment[] {
    const out: Comment[] = []
    for (const [groupId, body] of Object.entries(groupComments)) {
      const trimmed = body.trim()
      if (trimmed) out.push({ body: trimmed, scope: { type: 'group', groupId } })
    }
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

  // fillMode は SubmitBar の「Approve & Submit」「Reject & Submit」用。
  // 未判定 group をどちらかに補完して意思を明示する。指定なしなら未判定はそのまま (null 落とし) で送る。
  // note は SubmitBar の textarea で書いた全体コメント (任意)。SKILL.md 側で commit メッセージ生成等に活用。
  // v5: reviewKind ('approve' | 'request-changes' | 'comment') を必須引数として受け取る。
  //     'comment' のときは decision='comment-reply' に切り替え、Claude が thread に返信する経路に乗る。
  async function submit(opts?: { fillMode?: 'approved' | 'request-changes'; note?: string; reviewKind?: ReviewKind }) {
    if (submitted) return
    const fillMode = opts?.fillMode
    const note = opts?.note?.trim() || undefined
    const reviewKind: ReviewKind = opts?.reviewKind ?? 'approve'
    const decisions: Record<string, GroupDecision> = {}
    for (const g of groupsState) {
      const cur = groupDecisions[g.groupId] ?? null
      const next = cur ?? (fillMode ?? null)
      if (next !== null) decisions[g.groupId] = next
    }
    const cs = collectComments()
    const body: ResultJson = {
      decision: reviewKind === 'comment' ? 'comment-reply' : 'submit',
      reviewKind,
      groupDecisions: decisions,
      // ローカル threads state を送る (initialThreads + 本セッションで Comment ボタンが積んだ pending message)
      threads,
      comments: cs,
      ...(note ? { submitNote: note } : {}),
    }
    try {
      await fetch(`/result?token=${encodeURIComponent(tokenRef.current)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setSubmitted(reviewKind === 'comment' ? 'comment' : 'submit')
      setTimeout(() => {
        try { window.close() } catch { /* noop */ }
      }, 300)
    } catch {
      setToast('Failed to submit.')
      setTimeout(() => setToast(null), 3000)
    }
  }

  // context+: 現状 state (group decisions + コメント + line comment drafts) を回収し、
  // decision='regen-group' で POST /result に送ってから window.close()。
  // SKILL.md 側がこれを受けて summary.json の panels[] を再生成 + restore JSON を Write して
  // Skill 再起動するループに繋がる。
  // note: 「どの context を追加してほしいか」の自由文。SKILL.md 側で AI への指示として活用。
  const onRequestContext = useCallback(
    async (groupId: string, note?: string) => {
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
      const decisions: Record<string, GroupDecision> = {}
      for (const [k, v] of Object.entries(groupDecisions)) {
        if (v !== null) decisions[k] = v
      }
      const trimmedNote = note?.trim() || undefined
      const body: ResultJson = {
        decision: 'regen-group',
        // regen-group は review 全体の決定ではないので reviewKind は 'comment' (= 未確定) で埋める
        reviewKind: 'comment',
        groupDecisions: decisions,
        threads,
        comments: collectComments(),
        regenGroup: { groupId, currentRanges, ...(trimmedNote ? { note: trimmedNote } : {}) },
        lineCommentDrafts: collectAllDrafts(),
      }
      try {
        await fetch(`/result?token=${encodeURIComponent(tokenRef.current)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        setSubmitted('regen')
        setTimeout(() => {
          try { window.close() } catch { /* noop */ }
        }, 300)
      } catch {
        setRegenPending(false)
        setToast('Failed to request context expansion.')
        setTimeout(() => setToast(null), 3000)
      }
    },
    [groupsState, groupDecisions, groupComments, threads, regenPending, submitted, lineCommentHandlers.lineComments],
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
    // パフォーマンス最適化: ドラッグ中だけ body に is-resizing-nav class を当て、
     // CSS 側で .group-section / .group-nav-wrapper に will-change: grid-template-columns を付与。
     // これにより Chrome が grid 再計算を独立 layer に隔離し、reflow コストが下がる。
     // ドラッグ終了時に class を外して will-change を消す (常時付けると memory コストが上がる)。
    document.body.classList.add('is-resizing-nav')
    resizer.classList.add('dragging')
    try { resizer.setPointerCapture(pointerId) } catch { /* noop */ }

    // パフォーマンス最適化: drag 開始時の section.left を 1 度だけキャッシュ。
    // ドラッグ中に getBoundingClientRect() を呼ぶと「直前の setProperty 後のスタイル更新」を
    // 完了させるための forced sync layout が rAF callback 内で発生し、frame budget を食い潰す。
    // 座標は drag 中変わらないので start でキャッシュすれば flush は純粋に style write だけになる。
    const cachedSectionLeft = section.getBoundingClientRect().left
    let rafId: number | null = null
    let pendingClientX = 0
    let lastWrittenPx = -1
    function flush() {
      rafId = null
      if (!container) return
      const next = pendingClientX - cachedSectionLeft
      const clamped = Math.max(NAV_WIDTH_MIN, Math.min(NAV_WIDTH_MAX, next))
      const rounded = Math.round(clamped)
      // パフォーマンス最適化: 同じ px 値なら setProperty を skip (style recalc を起こさない)。
      // 1px 未満の微動でも cascade が走るのを防ぐ。
      if (rounded === lastWrittenPx) return
      lastWrittenPx = rounded
      container.style.setProperty('--nav-width', `${rounded}px`)
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
      document.body.classList.remove('is-resizing-nav')
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

  // done state: 全画面センター寄せの完了メッセージ。
  if (submitted === 'regen') {
    return (
      <div className="px-6 py-20 text-center text-lg text-text w-full">
        Requesting context expansion. You can close this tab — review will re-open with the expanded panels.
      </div>
    )
  }
  if (submitted === 'comment') {
    return (
      <div className="px-6 py-20 text-center text-lg text-text w-full">
        Comment sent. You can close this tab — review will re-open with Claude&apos;s replies.
      </div>
    )
  }
  if (submitted === 'submit') {
    const approved = Object.values(groupDecisions).filter(d => d === 'approved').length
    const rc = Object.values(groupDecisions).filter(d => d === 'request-changes').length
    const total = groupsState.length
    const msg = approved === total
      ? `Review submitted (all ${total} groups approved). You can close this tab — Claude will create commits.`
      : rc === total
        ? `Review submitted (all ${total} groups request-changes). You can close this tab.`
        : `Review submitted (${approved} approved / ${rc} request-changes). You can close this tab.`
    return <div className="px-6 py-20 text-center text-lg text-text w-full">{msg}</div>
  }

  const meta = formatMeta(payload)
  const overallHtml = renderMarkdown(payload.summary.overallSummary || '')
  const title = payload.prMeta
    ? payload.prMeta.title
    : payload.summary.mode === 'staged'
      ? 'Staged Diff Review'
      : 'Diff Review'

  const approvedCount = Object.values(groupDecisions).filter(d => d === 'approved').length
  const rcCount = Object.values(groupDecisions).filter(d => d === 'request-changes').length

  // v5.0.3: 全 group decision が確定した瞬間に submit を自動発火する。
  // reviewKind は groupDecisions の分布から判定 (全 approved → 'approve'、それ以外 → 'request-changes')。
  // 「Comment」だけは明示的にボタンで送る運用 (= 自動 submit には乗らない、note 付きで残せる)。
  // submit 内で submitted === null ガードがあるので二重発火しない。
  // restore (= regen-group/comment-reply 復帰) で initial がすでに全埋まりだった場合に意図せず即 submit が
  // 走らないよう、autoSubmitArmedRef でユーザーの操作 (= setDecision を経由した遷移) が一度でも起きるまでは
  // 発火しない仕掛けにする。
  const autoSubmitArmedRef = useRef(false)
  const totalGroups = groupsState.length
  const allDecided = totalGroups > 0 && (approvedCount + rcCount) === totalGroups
  useEffect(() => {
    if (!autoSubmitArmedRef.current) return
    if (!allDecided) return
    if (submitted || regenPending) return
    // 全 approved なら approve、1 つでも RC があれば request-changes 扱い (linear-stack 側で先頭から
    // approved を commit、最初の RC で break する既存ロジックがそのまま走る)
    const reviewKind: ReviewKind = rcCount === 0 ? 'approve' : 'request-changes'
    submit({ reviewKind })
  }, [allDecided, rcCount, submitted, regenPending])

  // Activity タブ: Editorial Dashboard 風の俯瞰画面。
  // diff 規模 (Files/Additions/Deletions/Progress) + 言語/レイヤ別 proportional bar + group index で
  // 「これから何をレビューするか」を 3 秒で把握できるよう設計。JSX 本体は ActivityView に切り出し済み。
  const activityContent = (
    <ActivityView
      title={title}
      metaHtml={meta}
      overallHtml={overallHtml}
      rawPanels={payload.rawPanels}
      groups={groupsState}
      groupDecisions={groupDecisions}
      approvedCount={approvedCount}
      rcCount={rcCount}
      onJumpToGroup={(_groupId, firstPanelId) => {
        setTab('guide')
        if (firstPanelId) jumpToPanel(firstPanelId)
      }}
      scriptResults={payload.scriptResults}
      threads={threads}
    />
  )

  // Guide タブ: stacked-group レビュー本体 (panel + decision)
  // pb-[200px] は SubmitBar (fixed bottom-6) の上にスクロール余白を確保する意図
  const guideContent = (
    <div className="m-0 w-full px-6 pb-[200px] flex-1" ref={containerRef}>
      {groupsState.map((g, i) => (
        <GroupSection
          key={g.groupId}
          index={i}
          total={groupsState.length}
          groupId={g.groupId}
          title={g.title}
          description={g.description}
          panels={g.panels}
          onJumpToPanel={jumpToPanel}
          onNavResizerPointerDown={onNavResizerPointerDown}
          regenPending={regenPending}
          onRequestContext={onRequestContext}
          decision={groupDecisions[g.groupId] ?? null}
          comment={groupComments[g.groupId] ?? ''}
          thread={threads[threadKey({ type: 'group', groupId: g.groupId })] ?? null}
          onSubmitComment={() => addGroupComment(g.groupId)}
          onDecisionChange={onDecisionChange}
          onCommentChange={onCommentChange}
          submitDisabled={regenPending}
          reviewedPanels={reviewedPanels}
          onToggleReviewed={onToggleReviewed}
          onJumpToGroupIndex={onJumpToGroupIndex}
          {...lineCommentHandlers}
        />
      ))}
    </div>
  )

  // Diff タブ: GitHub 風の「ファイル単位 split-side-by-side 差分」を縦積みで表示。
  // Guide タブの AI グルーピングを介さず、git diff の出力ファイル順にすべて並べる。
  // PanelBlock は Guide タブと完全同一実装 (lazyHighlight + intrinsic-size + sticky header)。
  //
  // 左 sticky nav にファイル一覧 (intent + +N/-M 差分カウント) を配置。
  // GitHub PR の Files Changed タブと同じ感覚で「全ファイル俯瞰 + クリックで該当ファイルへジャンプ」できる。
  // 差分カウントは payload.rawPanels の segments を walk して addition/deletion 行数を集計。
  const jumpToRawPanel = useCallback((panelId: string) => {
    const sel = `.raw-diff-tab .panel-block[data-panel-id="${cssEscape(panelId)}"]`
    const el = document.querySelector(sel) as HTMLElement | null
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const diffContent = (
    // raw-diff-tab BEM 維持 (jumpToRawPanel の querySelector で参照される) + 内側 scope に
    // `--nav-width: 280px` を設定。grid-template-columns は var(--nav-width) を参照し、内側
    // .comment-row も同じ var を calc で使うため、280 を 1 箇所だけ書く形にして将来の変更漏れを防ぐ。
    <div className="raw-diff-tab grid gap-6 px-6 pt-4 pb-20 grid-cols-[var(--nav-width)_minmax(0,1fr)] [--nav-width:280px]">
      {/* raw-diff-nav BEM 維持: ::-webkit-scrollbar 非表示 rule を globals.css でスコープしているため */}
      <aside
        className="raw-diff-nav sticky top-14 self-start max-h-[calc(100vh-80px)] overflow-y-auto pr-1 flex flex-col gap-0.5 [scrollbar-width:none] [-ms-overflow-style:none]"
        aria-label="Changed files"
      >
        {payload.rawPanels.map((p) => {
          let add = 0
          let del = 0
          for (const seg of p.segments) {
            for (const row of seg.rows) {
              if (row.toBe.type === 'addition') add++
              if (row.asIs.type === 'deletion') del++
            }
          }
          return (
            <button
              key={p.panelId}
              type="button"
              className="grid grid-cols-[1fr_auto] grid-rows-[auto_auto] gap-x-2 px-2.5 py-1.5 bg-transparent border-0 rounded-md text-left text-text font-sans cursor-pointer transition-colors duration-100 hover:bg-surface-2"
              onClick={() => jumpToRawPanel(p.panelId)}
              title={p.intent}
            >
              <span className="col-start-1 row-start-1 text-[12.5px] font-medium overflow-hidden text-ellipsis whitespace-nowrap">{basename(p.intent)}</span>
              <span className="col-start-2 row-start-1 inline-flex gap-1 items-baseline font-mono text-[10.5px] tabular-nums">
                {add > 0 ? <span className="text-add-fg">+{add}</span> : null}
                {del > 0 ? <span className="text-del-fg">-{del}</span> : null}
              </span>
              <span className="col-span-full row-start-2 text-[10.5px] text-text-dim font-mono overflow-hidden text-ellipsis whitespace-nowrap">{p.intent}</span>
            </button>
          )
        })}
      </aside>
      <div className="flex flex-col min-w-0">
        {payload.rawPanels.map((p) => {
          // 巨大 panel (build artifact 等) は初期 collapsed で開いてレンダリングコストを抑制。
          // segments の合計 row 数で判定。
          let totalRows = 0
          for (const seg of p.segments) totalRows += seg.rows.length
          const file = p.toBe?.file ?? p.asIs?.file
          const isAutoCollapseByPattern = shouldAutoCollapseFile(file)
          const isAutoCollapseByRows = totalRows > DIFF_TAB_COLLAPSE_ROW_THRESHOLD
          return (
            <PanelBlock
              key={p.panelId}
              panel={p}
              defaultCollapsed={isAutoCollapseByPattern || isAutoCollapseByRows}
              {...lineCommentHandlers}
            />
          )
        })}
        {payload.rawPanels.length === 0 ? (
          <div className="px-6 py-[60px] text-center text-text-dim text-[13px]">No file changes to display.</div>
        ) : null}
      </div>
    </div>
  )

  return (
    <>
      <TabBar
        active={tab}
        onChange={onTabChange}
        meta={`${payload.allPanels.length} panel${payload.allPanels.length === 1 ? '' : 's'}`}
        project={payload.project}
        pending={isPending}
      />
      {/* 訪問済みタブのみレンダー + 非アクティブは content-visibility: hidden で keep alive。
          display: none と違い render state を保持したまま「次回表示時のコストを最小化」する。
          ResizeObserver の一斉発火問題 (LoAF で計測された 6 秒級の主犯) も display:none 復帰時の
          0→実サイズ遷移が無くなるため抑制される。 */}
      {visitedTabs.has('activity') ? (
        <div className={tab === 'activity' ? '' : 'tab-hidden'}>{activityContent}</div>
      ) : null}
      {visitedTabs.has('guide') ? (
        <div className={tab === 'guide' ? '' : 'tab-hidden'}>{guideContent}</div>
      ) : null}
      {visitedTabs.has('diff') ? (
        <div className={tab === 'diff' ? '' : 'tab-hidden'}>{diffContent}</div>
      ) : null}
      {/* ChunkNavigator (左下): SubmitBar と対称配置で「全 diff 通しの chunk ジャンプ」を提供。
          activity タブには diff が無いので非表示にしたいが、ChunkNavigator 自身が「chunk 0 件なら null 返す」
          ガードを持つので常時 render しても安全。 */}
      <ChunkNavigator />
      {/* SubmitBar は全タブで常時表示 (どこからでも Submit できるように) */}
      <SubmitBar
        approvedCount={approvedCount}
        rcCount={rcCount}
        totalGroups={groupsState.length}
        onSubmit={submit}
        submitting={submitted !== null}
      />
      {toast ? (
        <div
          className="fixed top-6 right-6 bg-surface-2 border border-border rounded-lg px-3.5 py-2.5 text-xs z-50 shadow-[0_4px_12px_rgba(0,0,0,0.25)]"
          role="status"
          aria-live="polite"
        >
          {toast}
        </div>
      ) : null}
    </>
  )
}

function formatMeta(payload: ClientPayload): string {
  // 複数プロジェクトのレビューを並行して開いたとき Activity タブ単体でも識別できるよう、
  // meta 行の先頭にリポジトリ名を置く (branch は PR モードなら headRefName と重複するので staged のみ)
  const project = payload.project
  const pr: PrMeta | null = payload.prMeta
  if (pr) {
    const author = typeof pr.author === 'string' ? pr.author : (pr.author?.login ?? '')
    const prefix = project ? `${escapeHtml(project.name)} · ` : ''
    return `${prefix}PR #${pr.number} · ${escapeHtml(author)} · ${escapeHtml(pr.headRefName || '')} → ${escapeHtml(pr.baseRefName || '')}`
  }
  const prefix = project
    ? `${escapeHtml(project.name)}${project.branch ? ` (${escapeHtml(project.branch)})` : ''} · `
    : ''
  return `${prefix}${payload.summary.mode === 'staged' ? 'staged diff' : 'diff'} · ${payload.allPanels.length} panel${payload.allPanels.length === 1 ? '' : 's'}`
}

function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
  return s.replace(/["\\]/g, '\\$&')
}

// "a/b/c.ts" → "c.ts" 形式の basename (rename 表記 "old → new" は new 側を採用)
function basename(intentOrPath: string): string {
  // rename 表記 "old → new" は new 側 (矢印の後) を使う
  const arrowIdx = intentOrPath.indexOf('→')
  const target = arrowIdx >= 0 ? intentOrPath.slice(arrowIdx + 1).trim() : intentOrPath
  const slashIdx = target.lastIndexOf('/')
  return slashIdx >= 0 ? target.slice(slashIdx + 1) : target
}
