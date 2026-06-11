// Activity タブの content view。
// 「コードレビューに入る前に diff の規模・構造・進捗を 3 秒で把握する入口画面」というコンセプトで
// Editorial Dashboard 風に構成:
//   - Hero: 大型 title + meta + reviewed % で「何をどこまでレビューしたか」を即座に伝える
//   - Pre-flight checks / Overview / Groups (decision dot + file chip 列) / Conversation の縦積み
//
// 設計判断:
//   - Section 単位を eyebrow + 細い divider 線で延々と区切る編集者デザイン (Linear/Vercel 系)
//   - 配色は既存 token のみ (purple accent + add-fg green + warn amber + del-fg red + neutral grays)
//   - 数値はすべて tabular-nums の mono で表記し「計器盤」の重力感を出す
//   - 大型 title は tracking-tight で「読み物」より「告知」感を強める
//
// 入力は App.tsx から「現状 state を素直に渡す」だけ。ActivityView 自身は state を持たず純粋に表示する。
// memo 境界: activity pane は初期から常時 mount なので、App の無関係な state 変化 (group コメント
// 入力等) で Conversation / GroupIndex の再構築が走らないよう props の参照安定を前提に遮断する。

import type { FC, ReactNode } from 'react'
import { memo, useMemo, useState } from 'react'
import type { GroupDecision, RenderedPanel, ScriptResult, ScriptResultsPayload, ThreadMessage, ThreadSnapshot, AgentAction } from '@show-me/diff-shared'
import {
  Check, X, MinusCircle,
  ChevronDown, ChevronUp,
  MessageSquare, Lightbulb, FileEdit, Expand,
  FileCode, MessagesSquare,
  CircleDot, CheckCircle2, AlertTriangle,
} from 'lucide-react'
import {
  groupFiles,
  type FileChangeKind,
  type GroupFileInfo,
} from './activity-summary'
import { ThreadReplyForm } from './ThreadReplyForm'
import { basename } from '../lib/path'

// Activity タブの group 行で必要な最小限の info だけ受ける (App.tsx の AppGroup と互換)。
export type ActivityGroup = {
  groupId: string
  title: string
  panels: ReadonlyArray<RenderedPanel>
}

export type ActivityViewProps = {
  title: string
  // 既存 formatMeta() の出力 (escapeHtml 済み HTML 文字列)。
  metaHtml: string
  // 既存 renderMarkdown() の出力 (sanitized HTML)。空文字なら section 自体非表示。
  overallHtml: string
  rawPanels: ReadonlyArray<RenderedPanel>
  groups: ReadonlyArray<ActivityGroup>
  groupDecisions: Readonly<Record<string, GroupDecision | null>>
  approvedCount: number
  rcCount: number
  onJumpToGroup: (groupId: string, firstPanelId: string | undefined) => void
  // v5: Phase 4.5 のスクリプトゲート結果。Pre-flight checks セクションに表示。
  scriptResults?: ScriptResultsPayload
  // v5: スレッド全集合。Conversation セクションに集約表示 (active / resolved / outdated を分類)。
  threads?: Record<string, ThreadSnapshot>
  // Conversation カードからのスレッド返信。App の threads state に user message を
  // pending として積む (送信は SubmitBar の Comment / Submit に同乗)。
  onReplyToThread: (threadKey: string, body: string) => void
}

// file change kind ごとの chip スタイル。「A / M / D / R」のレターは GitHub の status 列と同じ規約。
const KIND_META: Record<
  FileChangeKind,
  { letter: string; chipBg: string; chipText: string; longLabel: string }
> = {
  added:    { letter: 'A', chipBg: 'bg-add-bg',     chipText: 'text-add-fg',     longLabel: 'added' },
  modified: { letter: 'M', chipBg: 'bg-surface-3',  chipText: 'text-text-muted', longLabel: 'modified' },
  deleted:  { letter: 'D', chipBg: 'bg-del-bg',     chipText: 'text-del-fg',     longLabel: 'deleted' },
  renamed:  { letter: 'R', chipBg: 'bg-accent-soft', chipText: 'text-accent',    longLabel: 'renamed' },
}

export const ActivityView: FC<ActivityViewProps> = memo(({
  title,
  metaHtml,
  overallHtml,
  rawPanels,
  groups,
  groupDecisions,
  approvedCount,
  rcCount,
  onJumpToGroup,
  scriptResults,
  threads,
  onReplyToThread,
}) => {
  // review スレッド (レビュー全体コメント) は Conversation 一覧に出さない:
  // SubmitBar の sidebar / floating パネルが専用の表示場所なので、ここにも出すと二重になる。
  const conversationThreads = useMemo(() => {
    if (!threads) return threads
    return Object.fromEntries(
      Object.entries(threads).filter(([, snap]) => snap.scope.type !== 'review'),
    )
  }, [threads])
  const totalGroups = groups.length
  const reviewedGroups = approvedCount + rcCount
  const reviewedPercent = totalGroups > 0
    ? Math.round((reviewedGroups / totalGroups) * 100)
    : 0

  return (
    <div className="m-0 w-full">
      {/* canvas: 上部 padding 多めで「読み物」っぽい縦リズム + 中央寄せ。max-w は dashboard が 4 列に収まる幅 */}
      <div className="px-8 pt-10 pb-24">
        <div className="max-w-[1080px] mx-auto">
          <Hero
            title={title}
            metaHtml={metaHtml}
            reviewedPercent={reviewedPercent}
            reviewedGroups={reviewedGroups}
            totalGroups={totalGroups}
          />

          {scriptResults && scriptResults.results.length > 0 ? (
            <Section label="Pre-flight checks">
              <PreflightChecks results={scriptResults.results} />
            </Section>
          ) : null}

          {overallHtml ? (
            <Section label="Overview">
              {/* markdown BEM 維持: globals.css の prose 用 token 上書き scope */}
              <div
                className="markdown prose prose-invert prose-sm max-w-none text-sm leading-[1.65]"
                dangerouslySetInnerHTML={{ __html: overallHtml }}
              />
            </Section>
          ) : null}

          {groups.length > 0 ? (
            <Section label={`Groups · ${totalGroups}`}>
              <GroupIndex
                groups={groups}
                groupDecisions={groupDecisions}
                onJumpToGroup={onJumpToGroup}
              />
            </Section>
          ) : null}

          {conversationThreads && Object.keys(conversationThreads).length > 0 ? (
            <Section label={`Conversation · ${Object.keys(conversationThreads).length}`}>
              <ConversationList threads={conversationThreads} groups={groups} rawPanels={rawPanels} onReplyToThread={onReplyToThread} />
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  )
})

// === Hero =====================================================================
// 上部の「告知」ブロック。editorial 風に eyebrow + 細 divider + 右端に reviewed % を置く。
// title は 40px の display サイズ + tracking-tight で「dashboard の表題」感を出す。

const Hero: FC<{
  title: string
  metaHtml: string
  reviewedPercent: number
  reviewedGroups: number
  totalGroups: number
}> = ({ title, metaHtml, reviewedPercent, reviewedGroups, totalGroups }) => (
  <header className="mb-12">
    <div className="flex items-center gap-3 mb-6">
      <span className="text-3xs tracking-[0.22em] uppercase text-accent font-semibold">
        AI Review
      </span>
      <span className="h-px flex-1 bg-border-soft" aria-hidden />
      <span
        className="text-3xs tracking-[0.18em] uppercase font-mono tabular-nums text-text-dim"
        title={`${reviewedGroups} of ${totalGroups} groups reviewed`}
      >
        {reviewedPercent}% reviewed
      </span>
    </div>
    {/* 巨大 title: tracking-[-0.025em] でぎっしり感を出す。leading は 1.08 で行間を詰めて重力感 */}
    <h1 className="m-0 text-4xl leading-[1.08] font-semibold tracking-[-0.025em] text-text">
      {title}
    </h1>
    {metaHtml ? (
      <div
        className="mt-5 text-xs leading-normal text-text-muted font-mono"
        dangerouslySetInnerHTML={{ __html: metaHtml }}
      />
    ) : null}
  </header>
)

// === Section wrapper ==========================================================
// eyebrow (small caps) + 細い divider 線で section を区切る編集者風レイアウト。
// 全 section が同じ frame を持つので、縦に並べると「目次のような」リズムが出る。

const Section: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <section className="mb-12">
    <div className="flex items-center gap-3 mb-5">
      <span className="text-3xs tracking-[0.22em] uppercase font-semibold text-text-dim">
        {label}
      </span>
      <span className="h-px flex-1 bg-border-soft" aria-hidden />
    </div>
    {children}
  </section>
)

// === Group Index ==============================================================
// 各 group を 1 行ボタンとして並べる。左から: decision dot / index / title + file chips / panel count。
// hover で背景を 1 段上げて clickability を示し、focus-visible で accent outline。

const GroupIndex: FC<{
  groups: ReadonlyArray<ActivityGroup>
  groupDecisions: Readonly<Record<string, GroupDecision | null>>
  onJumpToGroup: ActivityViewProps['onJumpToGroup']
}> = ({ groups, groupDecisions, onJumpToGroup }) => (
  <ul className="list-none m-0 p-0 flex flex-col gap-1">
    {groups.map((g, i) => {
      const decision = groupDecisions[g.groupId] ?? null
      const files = groupFiles(g.panels)
      const indexLabel = String(i + 1).padStart(2, '0')
      return (
        <li key={g.groupId}>
          <button
            type="button"
            className="w-full flex items-start gap-4 px-4 py-3.5 bg-transparent border-0 rounded-lg text-left cursor-pointer transition-colors duration-[140ms] hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
            onClick={() => onJumpToGroup(g.groupId, g.panels[0]?.panelId)}
            aria-label={`Open group ${i + 1}: ${g.title}`}
          >
            {/* dot + index は同じ垂直位置に揃えて目線を安定させる (mt-[7px] は dot 半径 + 行頭 baseline 補正) */}
            <DecisionDot decision={decision} />
            <span className="font-mono text-xs tabular-nums text-text-dim min-w-[24px] mt-[2px]">
              {indexLabel}
            </span>
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text leading-snug">
                {g.title}
              </span>
              {files.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {files.map((f) => (
                    <FileChip key={f.fullPath} info={f} />
                  ))}
                </div>
              ) : null}
            </div>
            <span className="text-2xs tabular-nums font-mono text-text-dim mt-[3px] shrink-0">
              {g.panels.length} {g.panels.length === 1 ? 'panel' : 'panels'}
            </span>
          </button>
        </li>
      )
    })}
  </ul>
)

// approved=add-fg green / request-changes=del-fg red / undecided=hollow ring。
// 2x2 dot サイズ、垂直は mt-[7px] で title baseline と視覚的に揃う。
const DecisionDot: FC<{ decision: GroupDecision | null }> = ({ decision }) => {
  if (decision === 'approved') {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-add-fg mt-[7px] shrink-0"
        aria-label="approved"
      />
    )
  }
  if (decision === 'request-changes') {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-del-fg mt-[7px] shrink-0"
        aria-label="request changes"
      />
    )
  }
  // undecided は中空 ring で「まだ」感を出す。border のみで bg なし。
  return (
    <span
      className="inline-block w-2 h-2 rounded-full border border-border mt-[7px] shrink-0"
      aria-label="undecided"
    />
  )
}

// file chip: kind を letter (A/M/D/R) で先頭に置き、basename をその右に。tooltip で full path。
const FileChip: FC<{ info: GroupFileInfo }> = ({ info }) => {
  const meta = KIND_META[info.kind]
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[5px] font-mono text-2xs leading-[1.4] ${meta.chipBg} ${meta.chipText}`}
      title={`${meta.longLabel}: ${info.fullPath}`}
    >
      <span className="text-3xs font-semibold tracking-wider opacity-70">
        {meta.letter}
      </span>
      <span>{info.display}</span>
    </span>
  )
}

// === Pre-flight checks (v5) =====================================================
// Phase 4.5 で実行されたローカル script の結果をチップ形式で並べる。
//   - passed: ✓ icon + 緑系
//   - failed: ✗ icon + 赤系 (この状態では本来 UI が開かないので、表示されるのは復旧後のみ)
//   - skipped: − icon + neutral

// border-color は base に置かず status 側で排他にする (同一 property の utility 競合は
// 記述順でなく stylesheet 順で解決されるため、base + override の重ね書きは事故る)
const PREFLIGHT_CHIP_BASE =
  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border bg-surface-2'
const PREFLIGHT_CHIP_STATUS: Record<ScriptResult['status'], string> = {
  passed: 'text-add-fg border-success/40',
  failed: 'text-del-fg border-danger/50',
  skipped: 'text-text-muted border-border',
}

const PreflightChecks: FC<{ results: ReadonlyArray<ScriptResult> }> = ({ results }) => (
  <div className="flex flex-wrap gap-2 py-1">
    {results.map((r) => {
      const Icon = r.status === 'passed' ? Check : r.status === 'failed' ? X : MinusCircle
      const duration = r.durationMs > 0 ? formatDuration(r.durationMs) : (r.reason ?? '')
      return (
        <span key={r.name} className={`${PREFLIGHT_CHIP_BASE} ${PREFLIGHT_CHIP_STATUS[r.status]}`} title={r.reason ?? r.status}>
          <Icon className="w-3 h-3" aria-hidden strokeWidth={2.5} />
          <span>{r.name}</span>
          {duration ? <span className="opacity-70">({duration})</span> : null}
        </span>
      )
    })}
  </div>
)

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// === Conversation (v5, frontend-design 刷新版) ==================================
// GitHub PR の Conversation タブ + Linear の comment thread を参考にした落ち着いた読み物感の
// timeline 風カード。avatar (YOU / Claude の 円形 badge) + 縦線 + speech bubble、line scope なら
// 該当コード snippet も上部に表示する。
//
// 構成: card head (anchor chip + status badge + expand toggle) → snippet (line scope) →
//       title (= first message excerpt) → expand 時に thread timeline。

type ThreadVariant = 'active' | 'resolved' | 'outdated'

const ConversationList: FC<{
  threads: Record<string, ThreadSnapshot>
  groups: ReadonlyArray<ActivityGroup>
  rawPanels: ReadonlyArray<RenderedPanel>
  onReplyToThread: (threadKey: string, body: string) => void
}> = ({ threads, groups, rawPanels, onReplyToThread }) => {
  // v5: resolve / reopen の local override state。
  // 完全な永続化 (submit 経由で restore.json に書き戻し) は useThreads 本格実装 (R-1) で対応。
  // 現状は close-relaunch を超えると消えるが、Activity タブ内では即座に反映される。
  const [resolveOverrides, setResolveOverrides] = useState<Record<string, boolean>>({})
  const effectiveResolved = (key: string, snap: ThreadSnapshot) =>
    Object.prototype.hasOwnProperty.call(resolveOverrides, key) ? resolveOverrides[key] : snap.resolved
  const toggleResolved = (key: string, current: boolean) =>
    setResolveOverrides(prev => ({ ...prev, [key]: !current }))
  // 返信は App state 側で thread の resolved を false に戻す (appendUserMessage の規約)。
  // local override が true のまま残ると「返信したのに resolved 表示のまま」になるため、
  // override を破棄して App state に従わせる。
  const handleReply = (key: string, body: string) => {
    onReplyToThread(key, body)
    setResolveOverrides(prev => {
      if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const entries = useMemo(() => Object.entries(threads), [threads])
  const active = entries.filter(([k, t]) => !effectiveResolved(k, t) && !t.outdated)
  const inactive = entries.filter(([k, t]) => effectiveResolved(k, t) || t.outdated)
  const [showInactive, setShowInactive] = useState(false)
  const unresolvedCount = active.length

  if (active.length === 0 && inactive.length === 0) {
    return (
      <div className="inline-flex items-center gap-2 py-3 text-text-muted text-xs">
        <MessagesSquare className="w-4 h-4" strokeWidth={1.8} aria-hidden />
        <span>No threads yet — drop a comment on any line to start one.</span>
      </div>
    )
  }

  const SUMMARY_BASE = 'inline-flex items-center gap-1.5 m-0 mb-1 text-xs font-mono'
  return (
    <div className="flex flex-col gap-3">
      {unresolvedCount > 0 ? (
        <p className={`${SUMMARY_BASE} text-warn`}>
          <CircleDot className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
          <span>{unresolvedCount} unresolved {unresolvedCount === 1 ? 'thread' : 'threads'}</span>
        </p>
      ) : (
        <p className={`${SUMMARY_BASE} text-add-fg`}>
          <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
          <span>All threads resolved</span>
        </p>
      )}
      {active.map(([key, snap]) => (
        <ConversationCard
          key={key}
          threadKey={key}
          snap={snap}
          variant="active"
          groups={groups}
          rawPanels={rawPanels}
          resolved={effectiveResolved(key, snap)}
          onToggleResolved={() => toggleResolved(key, effectiveResolved(key, snap))}
          onReply={(body) => handleReply(key, body)}
        />
      ))}
      {inactive.length > 0 ? (
        <button
          type="button"
          className="self-start inline-flex items-center gap-1.5 px-2.5 py-1.5 mt-1 bg-transparent border border-border-soft rounded-full text-text-muted text-xs font-mono cursor-pointer transition-colors duration-[120ms] hover:text-text hover:border-border hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent-soft focus-visible:outline-offset-2"
          aria-expanded={showInactive}
          onClick={() => setShowInactive(s => !s)}
        >
          {showInactive ? <ChevronUp className="w-3.5 h-3.5" aria-hidden /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden />}
          <span>
            {showInactive ? 'Hide' : 'Show'} resolved &amp; outdated
            <span className="ml-1.5 px-1.5 py-px rounded-full bg-surface-3 text-text text-2xs">{inactive.length}</span>
          </span>
        </button>
      ) : null}
      {showInactive ? inactive.map(([key, snap]) => {
        const isResolved = effectiveResolved(key, snap)
        const variant: ThreadVariant = snap.outdated ? 'outdated' : 'resolved'
        return (
          <ConversationCard
            key={key}
            threadKey={key}
            snap={snap}
            variant={variant}
            groups={groups}
            rawPanels={rawPanels}
            resolved={isResolved}
            onToggleResolved={() => toggleResolved(key, isResolved)}
            onReply={(body) => handleReply(key, body)}
          />
        )
      }) : null}
    </div>
  )
}

const ConversationCard: FC<{
  threadKey: string
  snap: ThreadSnapshot
  variant: ThreadVariant
  groups: ReadonlyArray<ActivityGroup>
  rawPanels: ReadonlyArray<RenderedPanel>
  resolved: boolean
  onToggleResolved: () => void
  onReply: (body: string) => void
}> = ({ threadKey, snap, variant, groups, rawPanels, resolved, onToggleResolved, onReply }) => {
  const [expanded, setExpanded] = useState(variant === 'active')
  const sectionId = `conversation-card-${threadKey.replace(/[^A-Za-z0-9_-]/g, '_')}`

  const lastMessage = snap.messages[snap.messages.length - 1]
  const firstMessage = snap.messages[0]
  const title = firstMessage?.body.split('\n')[0]?.slice(0, 110) ?? '(empty thread)'

  const snippet = useMemo(
    () => snap.scope.type === 'line' ? extractLineSnippet(snap.scope, groups, rawPanels) : null,
    [snap.scope, groups, rawPanels],
  )

  // group anchor は groupId (g0 等) だと人間に意味が伝わらないので group title を引いて表示する
  const scope = snap.scope
  const anchorLabel = scope.type === 'line'
    ? renderLineAnchor(scope.file, scope.line, scope.endLine)
    : scope.type === 'file'
      ? scope.file
      : scope.type === 'review'
        ? 'Review'
        : `Group · ${groups.find(g => g.groupId === scope.groupId)?.title ?? scope.groupId}`

  // resolve / reopen ボタン。on 状態の色は base と排他で持つ (utility の同 property 競合回避)
  const RESOLVE_BASE =
    'inline-flex items-center gap-1 px-2 py-[3px] border rounded-md text-2xs font-mono uppercase tracking-[0.04em] cursor-pointer transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:outline-accent-soft focus-visible:outline-offset-1'
  const RESOLVE_STATE = resolved
    ? 'text-add-fg border-add-fg/30 bg-add-bg/50'
    : 'text-text-muted border-border-soft bg-surface hover:text-text hover:border-border hover:bg-surface-2'

  return (
    <article
      className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-2 pt-3 pr-3.5 pb-3.5 pl-2.5 border border-border-soft rounded-[10px] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-surface)_92%,transparent),var(--color-surface-2))] transition-[border-color,box-shadow] duration-[120ms] hover:border-border focus-within:shadow-[0_0_0_1px_var(--color-accent-soft)] data-[state=active]:border-l-accent-soft data-[state=resolved]:opacity-75 data-[state=outdated]:border-l-2 data-[state=outdated]:border-l-warn"
      data-thread-key={threadKey}
      data-state={variant}
    >
      <header className="col-span-2 grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-x-2">
        <button
          type="button"
          className="w-6 h-6 inline-flex items-center justify-center border border-border-soft rounded-md bg-surface text-text-muted cursor-pointer transition-colors duration-[120ms] hover:text-text hover:border-border hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent-soft focus-visible:outline-offset-1"
          aria-expanded={expanded}
          aria-controls={sectionId}
          onClick={() => setExpanded(e => !e)}
        >
          {expanded
            ? <ChevronUp className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />
            : <ChevronDown className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />}
          <span className="sr-only">{expanded ? 'Collapse thread' : 'Expand thread'}</span>
        </button>
        <div className="inline-flex items-center gap-1.5 min-w-0 text-text-muted">
          {/* file / line はファイル系、review は会話系、group は dot のアイコン */}
          {snap.scope.type === 'group'
            ? <CircleDot className="w-3.5 h-3.5" strokeWidth={1.8} aria-hidden />
            : snap.scope.type === 'review'
              ? <MessagesSquare className="w-3.5 h-3.5" strokeWidth={1.8} aria-hidden />
              : <FileCode className="w-3.5 h-3.5" strokeWidth={1.8} aria-hidden />}
          <span className="font-mono text-xs text-text overflow-hidden text-ellipsis whitespace-nowrap">{anchorLabel}</span>
        </div>
        <div className="inline-flex items-center gap-2 text-text-dim text-2xs">
          <StatusPill variant={variant} />
          <span className="font-mono text-text-muted">
            {snap.messages.length} {snap.messages.length === 1 ? 'msg' : 'msgs'}
          </span>
          {lastMessage ? (
            <time className="font-mono" title={new Date(lastMessage.ts).toString()}>
              {relativeTime(lastMessage.ts)}
            </time>
          ) : null}
          {/* v5: outdated は spec で自動判定のみ。手動 resolve / reopen は user 操作で切替可能 */}
          {!snap.outdated ? (
            <button
              type="button"
              className={`${RESOLVE_BASE} ${RESOLVE_STATE}`}
              onClick={onToggleResolved}
              aria-pressed={resolved}
              title={resolved ? 'Reopen thread' : 'Mark thread as resolved'}
            >
              {resolved
                ? <CircleDot className="w-3 h-3" strokeWidth={2} aria-hidden />
                : <CheckCircle2 className="w-3 h-3" strokeWidth={2} aria-hidden />}
              <span>{resolved ? 'Reopen' : 'Resolve'}</span>
            </button>
          ) : null}
        </div>
      </header>

      {snippet ? <ConversationSnippet snippet={snippet} /> : null}

      {/* collapse 時の preview として title (= first message excerpt) を出し、expand 時は
          timeline と重複するため非表示にする。 */}
      {!expanded ? (
        <p className="col-start-2 m-0 text-sm leading-normal text-text font-medium [overflow-wrap:anywhere] break-words">{title}</p>
      ) : null}

      {expanded ? (
        <>
          <ol
            id={sectionId}
            role="region"
            aria-label="Thread messages"
            className="col-start-2 relative mt-1 pt-2 pb-1 pl-0 list-none border-t border-dashed border-border-soft before:content-[''] before:absolute before:left-[11px] before:top-7 before:bottom-4 before:w-px before:bg-border-soft"
          >
            {/* 最後の message が Claude の返信なら新着としてパルスで注目喚起する (各スレッド表示と同じ視覚言語) */}
            {snap.messages.map((msg, i) => (
              <ConversationMessage
                key={msg.id}
                msg={msg}
                highlight={msg.author === 'agent' && i === snap.messages.length - 1}
              />
            ))}
          </ol>
          {/* timeline 末尾の返信フォーム (GitHub PR conversation と同じ配置)。
              resolved / outdated でも表示する: outdated はアンカーコードが変わった事実の表示で
              あって会話継続を妨げる理由にならない (返信で resolved は open に戻るが outdated
              フラグは維持され、Outdated badge が状態を説明する)。 */}
          <ThreadReplyForm threadKey={threadKey} onSubmit={onReply} />
        </>
      ) : null}
    </article>
  )
}

// === supporting subcomponents ===================================================

// border-color は variant 側で排他に持つ (utility の同 property 競合回避)
const PILL_BASE =
  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-mono uppercase tracking-[0.06em] bg-surface-2 border'

const StatusPill: FC<{ variant: ThreadVariant }> = ({ variant }) => {
  if (variant === 'active') {
    return (
      <span className={`${PILL_BASE} text-accent border-accent/25`}>
        <CircleDot className="w-3 h-3" strokeWidth={2} aria-hidden />
        <span>Open</span>
      </span>
    )
  }
  if (variant === 'resolved') {
    return (
      <span className={`${PILL_BASE} text-add-fg border-add-fg/25`}>
        <CheckCircle2 className="w-3 h-3" strokeWidth={2} aria-hidden />
        <span>Resolved</span>
      </span>
    )
  }
  return (
    <span className={`${PILL_BASE} text-warn border-warn/25`}>
      <AlertTriangle className="w-3 h-3" strokeWidth={2} aria-hidden />
      <span>Outdated</span>
    </span>
  )
}

const ConversationSnippet: FC<{ snippet: LineSnippet }> = ({ snippet }) => (
  <div className="col-start-2 border border-border-soft rounded-md overflow-hidden bg-surface" data-line-type={snippet.target.type}>
    <div className="flex flex-col">
      {snippet.before ? <SnippetLine line={snippet.before} muted /> : null}
      <SnippetLine line={snippet.target} highlight />
      {snippet.after ? <SnippetLine line={snippet.after} muted /> : null}
    </div>
  </div>
)

const SnippetLine: FC<{ line: SnippetRow; muted?: boolean; highlight?: boolean }> = ({ line, muted, highlight }) => (
  <div
    className={`grid grid-cols-[40px_minmax(0,1fr)] items-center font-mono text-xs leading-[1.55]${
      line.type === 'addition' ? ' bg-add-bg/70' : line.type === 'deletion' ? ' bg-del-bg/70' : ''
    }${muted ? ' opacity-65' : ''}${highlight ? ' shadow-[inset_2px_0_0_0_var(--color-accent)]' : ''}`}
    data-row-type={line.type}
  >
    <span className="px-2 py-1 text-right text-text-dim border-r border-border-soft bg-surface-2/60 select-none">{line.line ?? ''}</span>
    <code className={`px-3 py-1 whitespace-pre overflow-x-auto [overflow-wrap:normal] ${
      line.type === 'addition' ? 'text-add-fg' : line.type === 'deletion' ? 'text-del-fg' : 'text-text'
    }`}>{line.raw || ' '}</code>
  </div>
)

const ConversationMessage: FC<{ msg: ThreadMessage; highlight?: boolean }> = ({ msg, highlight }) => {
  const Icon = msg.agentAction ? AGENT_ACTION_ICON[msg.agentAction.kind] : null
  const actionLabel = msg.agentAction ? AGENT_ACTION_LABEL[msg.agentAction.kind] : null
  // avatar の box-shadow (surface 色 3px) は timeline 縦線の上に乗ったとき線を「切る」ための縁取り
  const avatarClass = msg.author === 'agent'
    ? 'bg-accent text-surface shadow-[0_0_0_3px_var(--color-surface)]'
    : 'bg-surface-3 text-text border border-border shadow-[0_0_0_3px_var(--color-surface)]'
  return (
    <li
      className={`grid grid-cols-[24px_minmax(0,1fr)] gap-x-2.5 py-2${highlight ? ' thread-new-message' : ''}`}
      data-author={msg.author}
    >
      <span
        className={`relative w-6 h-6 rounded-full inline-flex items-center justify-center font-mono text-2xs font-semibold tracking-[0.05em] z-[1] ${avatarClass}`}
        aria-hidden
      >
        {msg.author === 'agent' ? 'C' : 'Y'}
      </span>
      <div className="min-w-0">
        <header className="flex items-center gap-2 mb-1 text-text-muted text-xs">
          <span className="text-text font-semibold">{msg.author === 'agent' ? 'Claude' : 'You'}</span>
          {Icon && actionLabel ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-px rounded bg-surface-2 text-accent text-2xs font-mono uppercase tracking-[0.04em]">
              <Icon className="w-3 h-3" strokeWidth={2} aria-hidden />
              <span>{actionLabel}</span>
            </span>
          ) : null}
          <time className="ml-auto text-text-dim font-mono text-2xs" title={new Date(msg.ts).toString()}>
            {relativeTime(msg.ts)}
          </time>
        </header>
        <p className="m-0 text-text text-sm leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere] break-words">{msg.body}</p>
      </div>
    </li>
  )
}

// === pure helpers ===============================================================

const AGENT_ACTION_ICON: Record<AgentAction['kind'], typeof MessageSquare> = {
  answer: MessageSquare,
  suggest: Lightbulb,
  apply: FileEdit,
  expand: Expand,
}
const AGENT_ACTION_LABEL: Record<AgentAction['kind'], string> = {
  answer: 'Answered',
  suggest: 'Suggested',
  apply: 'Applied',
  expand: 'Expanded',
}

function relativeTime(ts: number): string {
  const diff = Math.max(0, (Date.now() - ts) / 1000)
  if (diff < 45) return 'just now'
  if (diff < 90) return '1 min ago'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 5400) return '1 hr ago'
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`
  if (diff < 86400 * 2) return 'yesterday'
  return `${Math.floor(diff / 86400)} d ago`
}

function renderLineAnchor(file: string, line: number, endLine?: number): string {
  const base = basename(file)
  return endLine != null && endLine !== line
    ? `${base}:${line}-${endLine}`
    : `${base}:${line}`
}

type SnippetRow = { type: 'context' | 'deletion' | 'addition' | 'empty'; line?: number; raw: string }
type LineSnippet = {
  side: 'asIs' | 'toBe'
  file: string
  before?: SnippetRow
  target: SnippetRow
  after?: SnippetRow
}

// thread.scope (= line scope) を起点に、groups[].panels[] と rawPanels から rendered row を
// 線形に探して該当 line のコードを 1〜3 行抽出する。
function extractLineSnippet(
  scope: Extract<ThreadSnapshot['scope'], { type: 'line' }>,
  groups: ReadonlyArray<ActivityGroup>,
  rawPanels: ReadonlyArray<RenderedPanel>,
): LineSnippet | null {
  // 1st pass: groups[].panels から panelId 一致を探す
  let panel: RenderedPanel | undefined
  for (const g of groups) {
    panel = g.panels.find(p => p.panelId === scope.panelId)
    if (panel) break
  }
  // 2nd pass: rawPanels から探す (Diff タブ系)
  if (!panel) panel = rawPanels.find(p => p.panelId === scope.panelId)
  // 3rd pass: file path 一致で rawPanels を fallback (panelId が変わった場合の保険)
  if (!panel) {
    const isToBe = scope.side === 'toBe'
    panel = rawPanels.find(p => isToBe ? p.toBe?.file === scope.file : p.asIs?.file === scope.file)
  }
  if (!panel) return null

  // panel.segments[].rows から該当 line の row を探す
  const allRows: Array<{ type: SnippetRow['type']; line?: number; raw: string; idx: number }> = []
  let idx = 0
  for (const seg of panel.segments) {
    for (const row of seg.rows) {
      const cell = scope.side === 'asIs' ? row.asIs : row.toBe
      allRows.push({
        type: cell.type === 'empty' ? 'empty' : cell.type,
        line: cell.line,
        raw: cell.raw,
        idx,
      })
      idx++
    }
  }
  // 対象 line (endLine 範囲があれば中央) の row を見つける
  const targetLine = scope.endLine != null ? Math.floor((scope.line + scope.endLine) / 2) : scope.line
  const targetIdx = allRows.findIndex(r => r.line === targetLine)
  if (targetIdx === -1) return null
  const target = allRows[targetIdx]
  return {
    side: scope.side,
    file: scope.file,
    before: allRows[targetIdx - 1],
    target: { type: target.type, line: target.line, raw: target.raw },
    after: allRows[targetIdx + 1],
  }
}
