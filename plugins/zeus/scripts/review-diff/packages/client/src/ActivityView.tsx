// Activity タブの content view。
// 「コードレビューに入る前に diff の規模・構造・進捗を 3 秒で把握する入口画面」というコンセプトで
// Editorial Dashboard 風に再構築:
//   - 大型 display number で diff 規模を即座に伝える (Files / Additions / Deletions / Progress)
//   - 言語・レイヤ別の proportional bar で「この PR は何が中心か」を視覚的に表現 (本タブの差別化点)
//   - 各 group の decision dot + file chip 列で進捗と影響範囲を一目で
//
// 設計判断:
//   - Section 単位を eyebrow + 細い divider 線で延々と区切る編集者デザイン (Linear/Vercel 系)
//   - 配色は既存 token のみ (purple accent + add-fg green + warn amber + del-fg red + neutral grays)
//   - 数値はすべて tabular-nums の mono で表記し「計器盤」の重力感を出す
//   - 大型 title は tracking-tight で「読み物」より「告知」感を強める
//
// 入力は App.tsx から「現状 state を素直に渡す」だけ。ActivityView 自身は state を持たず純粋に表示する。

import type { FC, ReactNode } from 'react'
import { useMemo } from 'react'
import type { GroupDecision, RenderedPanel } from '@zeus/review-diff-shared'
import {
  computeDiffStats,
  groupFiles,
  type Bucket,
  type FileChangeKind,
  type GroupFileInfo,
} from './activity-summary'

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
}

// 段別 bar segment の色サイクル。purple → green → amber → red → cool gray の順で
// 視覚的にも意味的にも distinct な並び (1 番目が一番強調されるので最大 bucket は accent 色)。
const SEGMENT_COLORS = [
  'bg-accent',
  'bg-add-fg',
  'bg-warn',
  'bg-del-fg',
  'bg-text-muted',
  'bg-text-dim',
] as const

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

export const ActivityView: FC<ActivityViewProps> = ({
  title,
  metaHtml,
  overallHtml,
  rawPanels,
  groups,
  groupDecisions,
  approvedCount,
  rcCount,
  onJumpToGroup,
}) => {
  // diff 規模は同じ payload では不変 → mount 時 1 回計算 (rawPanels 参照は安定)。
  const stats = useMemo(() => computeDiffStats(rawPanels), [rawPanels])
  const totalGroups = groups.length
  const reviewedGroups = approvedCount + rcCount
  const reviewedPercent = totalGroups > 0
    ? Math.round((reviewedGroups / totalGroups) * 100)
    : 0

  // Files セルの sub-text: "+3 added · 12 modified · 1 deleted" のように 0 件を省略して短く。
  const fileBreakdown = [
    stats.filesAdded > 0    ? `${stats.filesAdded} added`       : null,
    stats.filesModified > 0 ? `${stats.filesModified} modified` : null,
    stats.filesDeleted > 0  ? `${stats.filesDeleted} deleted`   : null,
    stats.filesRenamed > 0  ? `${stats.filesRenamed} renamed`   : null,
  ].filter(Boolean).join(' · ') || 'no changes'

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

          <StatsDashboard
            filesTotal={stats.filesTotal}
            fileBreakdown={fileBreakdown}
            linesAdded={stats.linesAdded}
            linesDeleted={stats.linesDeleted}
            reviewedGroups={reviewedGroups}
            totalGroups={totalGroups}
            approvedCount={approvedCount}
            rcCount={rcCount}
          />

          {stats.byLanguage.length > 0 ? (
            <BreakdownSection label="Languages" buckets={stats.byLanguage} />
          ) : null}

          {stats.byLayer.length > 0 ? (
            <BreakdownSection label="Layers" buckets={stats.byLayer} />
          ) : null}

          {overallHtml ? (
            <Section label="Overview">
              {/* markdown BEM 維持: globals.css の prose 用 token 上書き scope */}
              <div
                className="markdown prose prose-invert prose-sm max-w-none text-[13.5px] leading-[1.65]"
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
        </div>
      </div>
    </div>
  )
}

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
      <span className="text-[10px] tracking-[0.22em] uppercase text-accent font-semibold">
        AI Review
      </span>
      <span className="h-px flex-1 bg-border-soft" aria-hidden />
      <span
        className="text-[10px] tracking-[0.18em] uppercase font-mono tabular-nums text-text-dim"
        title={`${reviewedGroups} of ${totalGroups} groups reviewed`}
      >
        {reviewedPercent}% reviewed
      </span>
    </div>
    {/* 巨大 title: tracking-[-0.025em] でぎっしり感を出す。leading は 1.08 で行間を詰めて重力感 */}
    <h1 className="m-0 text-[40px] leading-[1.08] font-semibold tracking-[-0.025em] text-text">
      {title}
    </h1>
    {metaHtml ? (
      <div
        className="mt-5 text-[12.5px] text-text-muted font-mono"
        dangerouslySetInnerHTML={{ __html: metaHtml }}
      />
    ) : null}
  </header>
)

// === Stats Dashboard ==========================================================
// 4 列の「計器盤」。grid + gap-px + parent bg で cell 間に 1px の hairline を作る。
// 各セルは label (eyebrow) + 大型 mono number + 小型 sub-text + 任意の bottom 要素。

const StatsDashboard: FC<{
  filesTotal: number
  fileBreakdown: string
  linesAdded: number
  linesDeleted: number
  reviewedGroups: number
  totalGroups: number
  approvedCount: number
  rcCount: number
}> = ({
  filesTotal, fileBreakdown, linesAdded, linesDeleted,
  reviewedGroups, totalGroups, approvedCount, rcCount,
}) => (
  <div className="grid grid-cols-4 gap-px bg-border-soft border border-border-soft rounded-xl overflow-hidden mb-14">
    <StatCell label="Files" big={filesTotal.toLocaleString()} sub={fileBreakdown} />
    <StatCell
      label="Additions"
      big={`+${linesAdded.toLocaleString()}`}
      bigColor="text-add-fg"
      sub="lines"
    />
    <StatCell
      label="Deletions"
      // 真の minus sign (U+2212) を使ってタイポグラフィを整える
      big={`−${linesDeleted.toLocaleString()}`}
      bigColor="text-del-fg"
      sub="lines"
    />
    <StatCell
      label="Progress"
      big={`${reviewedGroups}/${totalGroups}`}
      sub={`${approvedCount} approved · ${rcCount} rc`}
    >
      <ProgressBar reviewedGroups={reviewedGroups} totalGroups={totalGroups} />
    </StatCell>
  </div>
)

const StatCell: FC<{
  label: string
  big: string
  bigColor?: string
  sub: string
  children?: ReactNode
}> = ({ label, big, bigColor, sub, children }) => (
  <div className="bg-surface px-6 py-5 min-w-0">
    <div className="text-[10px] tracking-[0.18em] uppercase font-semibold text-text-dim mb-3">
      {label}
    </div>
    {/* 30px+ の display number。font-mono + tabular-nums で計器の安定感、tracking で凝縮感 */}
    <div
      className={`text-[30px] leading-none font-semibold tabular-nums tracking-[-0.02em] font-mono ${bigColor ?? 'text-text'}`}
    >
      {big}
    </div>
    <div className="mt-2 text-[11px] text-text-muted tabular-nums truncate" title={sub}>
      {sub}
    </div>
    {children}
  </div>
)

const ProgressBar: FC<{ reviewedGroups: number; totalGroups: number }> = ({
  reviewedGroups, totalGroups,
}) => {
  const percent = totalGroups > 0 ? (reviewedGroups / totalGroups) * 100 : 0
  return (
    <div className="mt-3 h-1 bg-surface-3 rounded-full overflow-hidden">
      <div
        className="h-full bg-accent rounded-full transition-[width] duration-300 ease-out"
        style={{ width: `${percent}%` }}
        aria-label={`${Math.round(percent)}% reviewed`}
      />
    </div>
  )
}

// === Breakdown (Languages / Layers) ==========================================
// このタブの「差別化点」: bucket を proportional segment bar で表現し、diff 構成を視覚化する。
// GitHub の language bar に着想を得つつ、単一 PR / diff レベルで使えるよう作り直し。

const BreakdownSection: FC<{ label: string; buckets: ReadonlyArray<Bucket> }> = ({
  label, buckets,
}) => (
  <Section label={label}>
    {/* bar 本体: rounded-full + inset ring で「楔のような」幾何感を出す。
        segment 間は左 border (background/50% opacity) で hairline 分割。 */}
    <div
      className="flex h-2.5 rounded-full overflow-hidden bg-surface-3 ring-1 ring-inset ring-border-soft"
      role="img"
      aria-label={`${label} breakdown`}
    >
      {buckets.map((b, i) => (
        <div
          key={b.label}
          className={`${SEGMENT_COLORS[i % SEGMENT_COLORS.length]} transition-[flex-basis] duration-300 ease-out ${i === 0 ? '' : 'border-l border-background/50'}`}
          style={{ flexBasis: `${b.percent * 100}%` }}
          title={`${b.label}: ${b.count} files (${Math.round(b.percent * 100)}%)`}
        />
      ))}
    </div>
    {/* legend chips: bar の色と一致する小さい正方形 + label + count。flex-wrap で広い PR でも収まる */}
    <ul className="list-none m-0 mt-4 flex flex-wrap gap-x-5 gap-y-2 p-0">
      {buckets.map((b, i) => (
        <li
          key={b.label}
          className="inline-flex items-center gap-2 text-[11.5px] text-text-muted"
        >
          <span
            className={`inline-block w-2 h-2 rounded-[2px] ${SEGMENT_COLORS[i % SEGMENT_COLORS.length]}`}
            aria-hidden
          />
          <span className="text-text font-mono">{b.label}</span>
          <span className="text-text-dim tabular-nums font-mono">{b.count}</span>
        </li>
      ))}
    </ul>
  </Section>
)

// === Section wrapper ==========================================================
// eyebrow (small caps) + 細い divider 線で section を区切る編集者風レイアウト。
// 全 section が同じ frame を持つので、縦に並べると「目次のような」リズムが出る。

const Section: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <section className="mb-12">
    <div className="flex items-center gap-3 mb-5">
      <span className="text-[10px] tracking-[0.22em] uppercase font-semibold text-text-dim">
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
            <span className="font-mono text-[12px] tabular-nums text-text-dim min-w-[24px] mt-[2px]">
              {indexLabel}
            </span>
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              <span className="text-[14px] font-medium text-text leading-snug">
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
            <span className="text-[10.5px] tabular-nums font-mono text-text-dim mt-[3px] shrink-0">
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
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[5px] font-mono text-[10.5px] leading-[1.4] ${meta.chipBg} ${meta.chipText}`}
      title={`${meta.longLabel}: ${info.fullPath}`}
    >
      <span className="text-[8.5px] font-semibold tracking-wider opacity-70">
        {meta.letter}
      </span>
      <span>{info.display}</span>
    </span>
  )
}
