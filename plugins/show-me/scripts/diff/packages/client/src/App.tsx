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
  DisplayRange,
  GroupDecision,
  PrMeta,
  RenderedPanel,
  ResultJson,
  ReviewKind,
  ThreadSnapshot,
} from '@show-me/diff-shared'
import { threadKey } from '@show-me/diff-shared'
import { TabBar } from './chrome/TabBar'
import { GroupSection } from './guide/GroupSection'
import { SubmitBar } from './chrome/SubmitBar'
import { useChunkKeyNav } from './chrome/useChunkKeyNav'
import { ActivityView } from './activity/ActivityView'
import { DiffTab } from './diff/DiffTab'
import { renderMarkdown, escapeHtml } from './lib/markdown'
import { cssEscape } from './lib/css-escape'
import { getToken } from './lib/state'
import { appendUserMessage, mergeGroupCommentsIntoThreads, mergeLineCommentsIntoThreads } from './lib/merge-threads'
import { useLineComments } from './guide/useLineComments'
import { useNavResizer } from './guide/useNavResizer'

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

  // Guide タブの line スレッド表示 (Panel.tsx CommentRow) は prop drilling 回避のため
  // window.__reviewDiffThreads を render 時に直読する。boot 時の initialThreads スナップショット
  // (index.tsx) だけだと本セッションで積んだ返信が Guide 側に反映されないため、毎 render で
  // 最新 threads を mirror する。冪等代入なので StrictMode の二重 render / useTransition の
  // 中断 render でも安全。
  // 注意: CommentRow がこれを読み直すのは「fileComments useMemo (deps: threads) の参照変化が
  // Panel の memo を破る」連鎖があるため。fileComments の deps から threads を外すとこの同期が壊れる。
  if (typeof window !== 'undefined') window.__reviewDiffThreads = threads

  // 低頻度 callback (addGroupComment / onRequestContext) が「発火時点の最新 state」を deps なしで
  // 読むための render 時同期ミラー。state を useCallback の deps に入れると group コメントの
  // 1 キーストロークごとに callback が再生成され、それを prop に受ける全 GroupSection の memo が
  // 破れて全 panel 再 render になるため、callback 本体は ref 経由で読む。
  // 冪等代入なので StrictMode の二重 render / useTransition の中断 render でも安全
  // (上の __reviewDiffThreads mirror と同じ論法)。
  const groupCommentsRef = useRef(groupComments)
  groupCommentsRef.current = groupComments
  const groupDecisionsRef = useRef(groupDecisions)
  groupDecisionsRef.current = groupDecisions
  const threadsRef = useRef(threads)
  threadsRef.current = threads

  // group コメントを pending としてスレッドに積み、textarea をクリアする。
  // textarea クリアは「同じ本文が submit 時の textarea 残量 thread 合成でもう一度積まれて
  // 二重になる」のを防ぐ意図。
  const addGroupComment = useCallback((groupId: string) => {
    const body = (groupCommentsRef.current[groupId] ?? '').trim()
    if (!body) return
    const scope = { type: 'group' as const, groupId }
    setThreads(prev => appendUserMessage(prev, threadKey(scope), scope, [body]))
    setGroupComments(prev => ({ ...prev, [groupId]: '' }))
  }, [])

  // ファイル単位コメント (panel header の MessageSquare ボタン)。group と同じ pending 方式で
  // file scope thread に積む。draft は PanelHeader ローカル state なのでここでは append のみ。
  const addFileComment = useCallback((file: string, body: string) => {
    const trimmed = body.trim()
    if (!trimmed) return
    const scope = { type: 'file' as const, file }
    setThreads(prev => appendUserMessage(prev, threadKey(scope), scope, [trimmed]))
  }, [])

  // Activity タブの Conversation カードからのスレッド返信。既存スレッドへの append 専用で、
  // scope はスレッド自身から引く (新規スレッド作成は group / file / line それぞれの正規動線が担う)。
  const addThreadReply = useCallback((key: string, body: string) => {
    const trimmed = body.trim()
    if (!trimmed) return
    setThreads(prev => {
      const existing = prev[key]
      if (!existing) return prev
      return appendUserMessage(prev, key, existing.scope, [trimmed])
    })
  }, [])

  // PanelHeader まで 1 prop で drill するための束。threads が変わった時だけ参照が変わる
  // (= 全 panel の memo が破れるのはコメント追加時のみ)。
  const fileComments = useMemo(() => ({
    getThread: (file: string) => threads[threadKey({ type: 'file', file })] ?? null,
    onAdd: addFileComment,
  }), [threads, addFileComment])

  const lineCommentHandlers = useLineComments()
  // lineComments のミラー (上の groupCommentsRef 群と同じ目的)。useLineComments() の戻りを
  // 参照するため宣言位置だけここに分離している。
  const lineCommentsRef = useRef(lineCommentHandlers.lineComments)
  lineCommentsRef.current = lineCommentHandlers.lineComments
  // 初期タブは Activity (AI Review Report をまず俯瞰してから Guide で詳細を進める動線)
  const [tab, setTab] = useState<Tab>('activity')
  // SubmitBar (sidebar variant) の開閉。サイドバーはコンテンツに覆い被さるのではなく
  // activity pane を margin で押し出してレイアウトごと狭めるため、SubmitBar 内部ではなく
  // App が状態を持つ。デフォルトは「最後の message が Claude の返信なら開く」(スレッド自動展開と同じ方針)。
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    const msgs = (payload.initialThreads ?? {})[threadKey({ type: 'review' })]?.messages ?? []
    return msgs.length > 0 && msgs[msgs.length - 1].author === 'agent'
  })
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
  // prop drilling (App → PanelBlock → Panel → SideRow → EditorLinkTrigger) を避ける。
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
  // 二重 POST /result ガード。submitted は postResult の fetch 解決後にしか立たないため、
  // in-flight 中の再クリック / auto-submit effect の再発火を同期的に止める ref (即時判定) と、
  // SubmitBar のボタン disable 用 state (UI 反映) の二段構え。regenPending と同じ役割分担。
  const submittingRef = useRef(false)
  const [submitInFlight, setSubmitInFlight] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<string>(getToken())
  // 完了画面の集計を「実際に POST した groupDecisions」と一致させるため、submit() が送信直前に
  // ここへスナップショットを保存する。fillMode 補完は submit 時の解釈であってユーザーの decision
  // ではないので state (groupDecisions) には書き戻さない (書き戻すと fetch 解決前の再 render で
  // auto-submit effect が二重発火しうる)。set は submit() 内・read は submitted 確定後の render
  // のみの一方向フローなので、render 中に ref を読んでも値は安定している。
  const sentDecisionsRef = useRef<Record<string, GroupDecision> | null>(null)

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
    // tab ガード: guide pane は prewarm により .tab-hidden (content-visibility: hidden) のまま
    // DOM に存在しうる。el の有無だけで消化判定すると、Activity からのジャンプで tab 遷移
    // (transition) が完了する前に隠れた pane へスクロールしてターゲットを失うため、
    // guide が前面の時だけ消化し、それまで scrollTarget を保持する。
    if (tab !== 'guide') return
    const sel = `.panel-block[data-panel-id="${cssEscape(scrollTarget)}"]`
    const el = containerRef.current?.querySelector(sel) as HTMLElement | null
    // 未 mount (prewarm 前) なら保持: visitedTabs 変化の再実行で mount 後に消化される
    if (!el) return
    // rAF で 1 フレーム待つ: タブ切替時のスクロール位置復元 effect (定義順で先) も rAF で
    // instant scrollTo するため、rAF の登録順実行保証により「復元 → smooth ジャンプ」の順になる。
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    setScrollTarget(null)
  }, [scrollTarget, tab, visitedTabs])

  const onDecisionChange = useCallback((id: string, next: GroupDecision | null) => {
    // ユーザー操作で decision が変わった瞬間に auto-submit を arm する。
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

  // useCallback 必須: 全 GroupSection に prop で渡るため、plain function だと App の毎 render で
  // 新参照になり GroupSection の memo が全壊する (onSubmitComment / onRequestContext と同じ制約)。
  const jumpToPanel = useCallback((panelId: string) => {
    setScrollTarget(panelId)
  }, [])

  // Activity → Guide の group ジャンプ。タブ切替は onTabChange (startTransition 済み) に乗せ、
  // scroll は上の scrollTarget 保持 effect が guide 前面化後に消化する。
  const onJumpToGroup = useCallback((_groupId: string, firstPanelId?: string) => {
    onTabChange('guide')
    if (firstPanelId) jumpToPanel(firstPanelId)
  }, [onTabChange, jumpToPanel])

  // グループ間ナビゲーション: 左 nav の prev/next 矢印から呼ばれる。
  // index ベースで scrollIntoView を呼ぶ。groupsState の長さでクランプ済み前提だが防御的に。
  const onJumpToGroupIndex = useCallback((targetIndex: number) => {
    if (targetIndex < 0 || targetIndex >= groupsState.length) return
    const target = groupsState[targetIndex]
    const sel = `.group-section[data-group-id="${cssEscape(target.groupId)}"]`
    const el = containerRef.current?.querySelector(sel) as HTMLElement | null
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [groupsState])

  // Diff タブの左 nav からファイル単位 panel へジャンプする。
  // .raw-diff-tab スコープで querySelector する (Guide タブの同 panelId と衝突しないため)。
  const jumpToRawPanel = useCallback((panelId: string) => {
    const sel = `.raw-diff-tab .panel-block[data-panel-id="${cssEscape(panelId)}"]`
    const el = document.querySelector(sel) as HTMLElement | null
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

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

  // POST /result → 完了 state 設定 → window.close の共通経路。submit / onRequestContext は
  // ResultJson の組み立てだけを担い、送信・クローズ・失敗 toast はここに集約する。
  // close を 300ms 遅らせるのは、完了 state の描画を一瞬見せてから閉じる意図。
  async function postResult(
    body: ResultJson,
    submittedKind: 'submit' | 'comment' | 'regen',
    failure: { message: string; cleanup?: () => void },
  ) {
    try {
      const res = await fetch(`/result?token=${encodeURIComponent(tokenRef.current)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      // fetch は 4xx/5xx で reject しないため明示検査する。ここを通すと token 不一致や
      // server エラーでも「送信成功」表示でタブが閉じ、decision / コメントが回収不能になる。
      if (!res.ok) throw new Error(`/result ${res.status}`)
      setSubmitted(submittedKind)
      setTimeout(() => {
        try { window.close() } catch { /* noop */ }
      }, 300)
    } catch {
      failure.cleanup?.()
      setToast(failure.message)
      setTimeout(() => setToast(null), 3000)
    }
  }

  // fillMode は SubmitBar の「Approve & Submit」「Reject & Submit」用。
  // 未判定 group をどちらかに補完して意思を明示する。指定なしなら未判定はそのまま (null 落とし) で送る。
  // note は SubmitBar の textarea で書いた全体コメント (任意)。review scope thread の user message として
  // 積むので Claude が返信でき、会話履歴が UI に残る。submitNote にも同じ文字列を載せる
  // (SKILL.md の commit メッセージ生成が submitNote を読む後方互換)。
  // reviewKind が 'comment' のときは decision='comment-reply' に切り替え、Claude が thread に返信する経路に乗る。
  async function submit(opts?: { fillMode?: 'approved' | 'request-changes'; note?: string; reviewKind?: ReviewKind }) {
    if (submitted || submittingRef.current) return
    // fetch 解決前の再入 (Submit 連打 / auto-submit effect の再発火) を同期的に遮断する。
    // 解除は postResult の失敗 cleanup のみ (成功時はタブごと閉じるので解除不要)。
    submittingRef.current = true
    setSubmitInFlight(true)
    const note = opts?.note?.trim() || undefined
    const reviewKind: ReviewKind = opts?.reviewKind ?? 'approve'
    const decisionsToSend = buildDecisions(groupsState, groupDecisions, opts?.fillMode)
    sentDecisionsRef.current = decisionsToSend
    const body: ResultJson = {
      decision: reviewKind === 'comment' ? 'comment-reply' : 'submit',
      reviewKind,
      groupDecisions: decisionsToSend,
      // ローカル threads state (initialThreads + 本セッションで Comment ボタンが積んだ pending message) に
      // 保存済み行コメント・group textarea の書き残し・note を合成して送る。threads が唯一の
      // コメントチャネル。setThreads を待たずローカルで合成するのは、state 反映前に fetch する
      // race を避けるため (この直後にタブは閉じるので state 更新は不要)。
      threads: appendReviewNote(
        mergeGroupCommentsIntoThreads(
          mergeLineCommentsIntoThreads(threads, lineCommentHandlers.lineComments, panelFileMap),
          groupComments,
        ),
        note,
      ),
      ...(note ? { submitNote: note } : {}),
      // comment-reply の close-relaunch で未送信 draft (Activity 返信フォーム / 行コメントフォームの
      // 書きかけ) を restore.json 経由で復元するための回収。SKILL.md の comment-reply 手順は
      // 「lineCommentDrafts を result.json からそのままコピー」を規定しており、ここで載せないと
      // 新タブ (= 新 sessionStorage) で書きかけが消える。approve / RC submit ではタブが完全終了
      // するため余分でも無害。
      lineCommentDrafts: collectAllDrafts(),
    }
    await postResult(body, reviewKind === 'comment' ? 'comment' : 'submit', {
      message: 'Failed to submit.',
      // 失敗時は Submit ボタンを復活させて再試行可能にする
      cleanup: () => {
        submittingRef.current = false
        setSubmitInFlight(false)
      },
    })
  }

  // context+: 現状 state (group decisions + コメント + line comment drafts) を回収し、
  // decision='regen-group' で POST /result に送ってから window.close()。
  // SKILL.md 側がこれを受けて summary.json の panels[] を再生成 + restore JSON を Write して
  // Skill 再起動するループに繋がる。
  // note: 「どの context を追加してほしいか」の自由文。SKILL.md 側で AI への指示として活用。
  const onRequestContext = useCallback(
    async (groupId: string, note?: string) => {
      if (regenPending || submitted || submittingRef.current) return
      const g = groupsState.find(x => x.groupId === groupId)
      if (!g) return
      setRegenPending(true)
      submittingRef.current = true
      // SubmitBar 側のボタンも disabled にする: submittingRef は同期ガード (クリックを no-op に
      // する) だけで UI に出ないため、これを欠くと regen の fetch 窓中に「enabled に見えるのに
      // 無反応」なボタンになる (ボタンは常時表示 + disabled で示す規約に反する)。
      setSubmitInFlight(true)
      const currentRanges: Array<{
        panelId: string
        asIs?: { file: string; ranges: DisplayRange[] }
        toBe?: { file: string; ranges: DisplayRange[] }
      }> = g.panels.map(p => ({
        panelId: p.panelId,
        asIs: p.asIs ? { file: p.asIs.file, ranges: p.asIs.ranges } : undefined,
        toBe: p.toBe ? { file: p.toBe.file, ranges: p.toBe.ranges } : undefined,
      }))
      const trimmedNote = note?.trim() || undefined
      const groupCommentsNow = groupCommentsRef.current
      const body: ResultJson = {
        decision: 'regen-group',
        // regen-group は review 全体の決定ではないので reviewKind は 'comment' (= 未確定) で埋める
        reviewKind: 'comment',
        groupDecisions: buildDecisions(groupsState, groupDecisionsRef.current),
        // 保存済み行コメントは thread に合成して送る (restore 後は thread として読み取り専用表示)。
        // group textarea の書き残しは thread 化せず groupComments で送る — regen は「送信」では
        // なく「中断・復元」なので、draft のまま textarea に戻すのが正しい。
        threads: mergeLineCommentsIntoThreads(threadsRef.current, lineCommentsRef.current, panelFileMap),
        ...(Object.keys(groupCommentsNow).length > 0 ? { groupComments: groupCommentsNow } : {}),
        regenGroup: { groupId, currentRanges, ...(trimmedNote ? { note: trimmedNote } : {}) },
        lineCommentDrafts: collectAllDrafts(),
      }
      await postResult(body, 'regen', {
        message: 'Failed to request context expansion.',
        // 失敗時は context+ ボタンを復活させて再試行可能にする (成功時はタブごと閉じるので解除不要)
        cleanup: () => {
          setRegenPending(false)
          submittingRef.current = false
          setSubmitInFlight(false)
        },
      })
    },
    // deps 注: groupComments / groupDecisions / threads / lineComments は ref ミラー経由で読むため
    // deps に入れない。state を deps に入れるとキーストロークごとに本 callback が再生成され、
    // これを prop に受ける全 GroupSection の memo が全壊する (ref は render 時同期代入 + 発火は
    // 常に render 後のイベントなので stale にならない)。collectAllDrafts / postResult は毎 render
    // 再生成される plain function だが、sessionStorage / ref / stable setter しか捕捉しないため
    // 意図的に除外。mergeLineCommentsIntoThreads はモジュールレベル純関数なので deps 不要。
    [groupsState, regenPending, submitted, panelFileMap],
  )

  const onNavResizerPointerDown = useNavResizer(containerRef)

  // ↑↓ キーの「次/前の変更箇所」ジャンプ。Guide / Diff のみ有効 (Activity ではキーを奪わない)。
  // 旧 ChunkNavigator (左下 floating UI) は GroupNav の decision ボタンに被る構造問題で廃止し、
  // キーボード機能だけを残した (useChunkKeyNav 冒頭コメント参照)。
  useChunkKeyNav(tab === 'guide' || tab === 'diff')

  const approvedCount = Object.values(groupDecisions).filter(d => d === 'approved').length
  const rcCount = Object.values(groupDecisions).filter(d => d === 'request-changes').length
  const totalGroups = groupsState.length
  const allDecided = totalGroups > 0 && (approvedCount + rcCount) === totalGroups

  // 全 group decision が確定した瞬間に submit を自動発火する。
  // reviewKind は groupDecisions の分布から判定 (全 approved → 'approve'、それ以外 → 'request-changes')。
  // 「Comment」だけは明示的にボタンで送る運用 (= 自動 submit には乗らない、note 付きで残せる)。
  // 二重発火防止は submit 内の submitted ガード + submittingRef の同期ガードの二段:
  // submitted は fetch 解決後にしか立たないため、fetch in-flight 中に decision がトグルされて
  // この effect が再実行されるウィンドウは submittingRef が塞ぐ。
  // restore (= regen-group/comment-reply 復帰) で initial がすでに全埋まりだった場合に意図せず即 submit が
  // 走らないよう、autoSubmitArmedRef でユーザーの操作 (= setDecision を経由した遷移) が一度でも起きるまでは
  // 発火しない仕掛けにする。
  // 注意: この useRef / useEffect は下の submitted 早期 return 群より前に置くこと。後ろに置くと
  // submitted 確定時の再 render で hooks 数が減り "Rendered fewer hooks than expected" でクラッシュする。
  const autoSubmitArmedRef = useRef(false)
  useEffect(() => {
    if (!autoSubmitArmedRef.current) return
    if (!allDecided) return
    if (submitted || regenPending || submittingRef.current) return
    // 全 approved なら approve、1 つでも RC があれば request-changes 扱い (linear-stack 側で先頭から
    // approved を commit、最初の RC で break する既存ロジックがそのまま走る)
    const reviewKind: ReviewKind = rcCount === 0 ? 'approve' : 'request-changes'
    submit({ reviewKind })
  }, [allDecided, rcCount, submitted, regenPending])

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
    // 集計は submit() が保存した送信スナップショットから計算する。state の groupDecisions は
    // fillMode 補完を含まないため、ここで state を見ると実際に送った内容とずれる。
    const sent = sentDecisionsRef.current ?? {}
    const sentApproved = Object.values(sent).filter(d => d === 'approved').length
    const sentRc = Object.values(sent).filter(d => d === 'request-changes').length
    const msg = sentApproved === totalGroups
      ? `Review submitted (all ${totalGroups} groups approved). You can close this tab — Claude will create commits.`
      : sentRc === totalGroups
        ? `Review submitted (all ${totalGroups} groups request-changes). You can close this tab.`
        : `Review submitted (${sentApproved} approved / ${sentRc} request-changes). You can close this tab.`
    return <div className="px-6 py-20 text-center text-lg text-text w-full">{msg}</div>
  }

  const meta = formatMeta(payload)
  const overallHtml = renderMarkdown(payload.summary.overallSummary || '')
  const title = payload.prMeta
    ? payload.prMeta.title
    : payload.summary.mode === 'staged'
      ? 'Staged Diff Review'
      : 'Diff Review'

  // Activity タブ: Editorial Dashboard 風の俯瞰画面。
  // Hero (diff 規模 + reviewed %) + Pre-flight checks + Overview + group index + Conversation で
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
      onJumpToGroup={onJumpToGroup}
      scriptResults={payload.scriptResults}
      threads={threads}
      onReplyToThread={addThreadReply}
    />
  )

  // Guide タブ: stacked-group レビュー本体 (panel + decision)
  // pb-[200px] は SubmitBar (fixed bottom-6) の上にスクロール余白を確保する意図
  // guide-tab class は GroupNav の useScrollSpy の querySelector スコープ (Diff タブに同 panelId の
  // .panel-block が存在するため、Guide pane 配下だけを観測対象にする目印)。
  const guideContent = (
    <div className="guide-tab m-0 w-full px-6 pb-[200px] flex-1" ref={containerRef}>
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
          onSubmitComment={addGroupComment}
          fileComments={fileComments}
          onDecisionChange={onDecisionChange}
          onCommentChange={onCommentChange}
          submitDisabled={regenPending}
          onJumpToGroupIndex={onJumpToGroupIndex}
          {...lineCommentHandlers}
        />
      ))}
    </div>
  )

  // Diff タブ: JSX 本体は DiffTab (memo 境界) に切り出し済み。
  // props はすべて安定参照 (payload 由来 / useCallback / useMemo) なので、App の state 変化では
  // 再 render されない。
  const diffContent = (
    <DiffTab
      rawPanels={payload.rawPanels}
      fileComments={fileComments}
      onJumpToRawPanel={jumpToRawPanel}
      {...lineCommentHandlers}
    />
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
      {/* .tab-pane は useChunkKeyNav の chunk 走査スコープ (.tab-pane:not(.tab-hidden)) の目印。
          activity pane の mr-[420px] は sidebar (w-[420px]) の押し出し: overlay でコンテンツを
          隠すのではなく、レイアウトごと狭めて全文が読める状態を保つ。 */}
      {visitedTabs.has('activity') ? (
        <div
          className={`tab-pane transition-[margin] duration-200 ease-out${tab === 'activity' ? '' : ' tab-hidden'}${
            tab === 'activity' && sidebarOpen ? ' mr-[420px]' : ''
          }`}
        >
          {activityContent}
        </div>
      ) : null}
      {visitedTabs.has('guide') ? (
        <div className={tab === 'guide' ? 'tab-pane' : 'tab-pane tab-hidden'}>{guideContent}</div>
      ) : null}
      {visitedTabs.has('diff') ? (
        <div className={tab === 'diff' ? 'tab-pane' : 'tab-pane tab-hidden'}>{diffContent}</div>
      ) : null}
      {/* SubmitBar は全タブで常時 mount (どこからでも Submit でき、note draft もタブをまたいで維持)。
          Activity では会話を主役にした右サイドバー、Guide / Diff ではコードを隠さない floating パネル。 */}
      <SubmitBar
        approvedCount={approvedCount}
        rcCount={rcCount}
        totalGroups={groupsState.length}
        onSubmit={submit}
        submitting={submitted !== null || submitInFlight}
        reviewThread={threads[threadKey({ type: 'review' })] ?? null}
        variant={tab === 'activity' ? 'sidebar' : 'floating'}
        sidebarOpen={sidebarOpen}
        onSidebarToggle={() => setSidebarOpen(o => !o)}
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

// ResultJson に載せる groupDecisions を組み立てる。未判定 (null) の group は fillMode で補完し、
// fillMode 未指定なら null のまま落とす (ResultJson に「未決定」は存在しないため)。
function buildDecisions(
  groups: AppGroup[],
  current: Record<string, GroupDecision | null>,
  fillMode?: GroupDecision,
): Record<string, GroupDecision> {
  const out: Record<string, GroupDecision> = {}
  for (const g of groups) {
    const next = current[g.groupId] ?? fillMode ?? null
    if (next !== null) out[g.groupId] = next
  }
  return out
}

// note を review scope thread の user message として合成した threads を返す (note 無しならそのまま)。
// 既存スレッドへの追記時は resolved を倒す (返信待ちの open スレッドに戻す)。
function appendReviewNote(
  threads: Record<string, ThreadSnapshot>,
  note: string | undefined,
): Record<string, ThreadSnapshot> {
  if (!note) return threads
  const scope = { type: 'review' as const }
  return appendUserMessage(threads, threadKey(scope), scope, [note])
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

