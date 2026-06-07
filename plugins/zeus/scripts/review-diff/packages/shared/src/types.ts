// shared 型定義 (v4.8.0 panel model)。client/server/cli が import する。
// v4.8.0 で Channels インフラ + unified mode を全廃し、context+ は close-relaunch +
// state restore モデルに変更。FeedbackEvent / PanelsUpdatedEvent は消滅し、ResultJson に
// 'regen-group' decision + restore 用 lineCommentDrafts を追加した。
// server-only の SourcesMap / FileSource は packages/server/src/server.ts 内で別途定義。

// =====================================================================
// 基本型
// =====================================================================

export type Side = 'asIs' | 'toBe'

// 1-based / inclusive。SummaryJson.groups[].panels[].asIs/toBe.ranges の要素型。
export type DisplayRange = { start: number; end: number }

export type PrMeta = {
  number: number
  title: string
  body: string
  author: { login?: string } | string
  baseRefName?: string
  headRefName?: string
  // baseRefOid / headRefOid / headRepository は PR モードでの unchanged 行 lazy 展開のために
  // gh CLI 経由で base/head の blob を取得する際に必要。
  baseRefOid?: string
  headRefOid?: string
  headRepository?: { nameWithOwner: string }
  additions?: number
  deletions?: number
  changedFiles?: number
}

// =====================================================================
// Panel schema
// =====================================================================

export type PanelSide = {
  file: string
  ranges: DisplayRange[]
}

// Panel = as-is/to-be ペアを 1 つ表現する最小単位。
// asIs か toBe の少なくとも一方は必須 (validateSummarySchema 側で refine 検証)。
// panelId は AI 指定 or CLI が sha1({asIs, toBe}).slice(0,10) で自動生成する。
//   - intent を hash 対象に含めないのは、context+/- 再生成で intent 文を書き直しても
//     asIs/toBe が同じなら panelId が不変であることを保証するため (コメント / draft 維持)。
export type Panel = {
  panelId: string
  intent: string
  asIs?: PanelSide
  toBe?: PanelSide
}

export type Group = {
  title: string
  description: string
  panels: Panel[]
}

export type SummaryJson = {
  schemaVersion: 1
  mode: 'staged' | 'pr'
  pr: PrMeta | null
  overallSummary: string
  groups: Group[]
}

// =====================================================================
// Comment / Result
// =====================================================================

// v4.7.0 Comment shape (scope union 化、null マジック値撤廃)。
//   - scope: { type: 'overall' }  → オーバーオールコメント
//   - scope: { type: 'line', ... } → panel 内の行 (または範囲) コメント
//     file を併記する理由は、grep で `jq '.comments[] | select(.scope.file=="x.ts")'` を
//     1 段引きできるようにするため + cross-file panel で side だけだとどの file の行か
//     逆引きが必要になるため。
export type Comment = {
  body: string
  scope:
    | { type: 'overall' }
    | {
        type: 'line'
        panelId: string
        side: Side
        file: string
        line: number
        endLine?: number
      }
}

// v4.8.0: decision に 'regen-group' を追加。
//   context+ ボタン押下時、ブラウザ側で現状 state (Reviewed + line comments + 未保存 draft) を
//   回収して POST /result で送り、CLI を一度終了させる (window.close 連動)。
//   SKILL.md が summary.json の該当 group の panels を「より広い context」で再生成して、
//   restore state を渡しつつ Skill('zeus:review-diff') を再起動する設計。
//   approve / reject / timeout では regenGroup は undefined。
//   lineCommentDrafts は regen 時の seed として使われる (approve / reject では無視可)。
export type ResultJson = {
  decision: 'approve' | 'reject' | 'timeout' | 'regen-group'
  reviewedPanels: string[]
  comments: Comment[]
  regenGroup?: {
    groupId: string
    // 現在その group が見せている panel 範囲。AI が「ここから ±N 行広げる」判断に使う。
    currentRanges: Array<{
      panelId: string
      asIs?: { file: string; ranges: DisplayRange[] }
      toBe?: { file: string; ranges: DisplayRange[] }
    }>
  }
  // sessionStorage に残っていた未保存 draft 本文。key: `draft:${panelId}:${side}:${num}[:${end}]`
  // 再起動後に sessionStorage に書き戻して、書きかけが残る UX を担保する。
  lineCommentDrafts?: Record<string, string>
}

// =====================================================================
// レンダリング中間表現 (CLI → ブラウザ payload)
// =====================================================================

export type SideBySideRow = {
  asIs: { type: 'context' | 'deletion' | 'empty'; line?: number; raw: string }
  toBe: { type: 'context' | 'addition' | 'empty'; line?: number; raw: string }
}

export type RenderedSegment = {
  asIsRange?: DisplayRange
  toBeRange?: DisplayRange
  rows: SideBySideRow[]
}

// Panel の源データである before/after 原文 (asIs/toBe sources) が取得できなかったことを
// UI で明示するための discriminated union。null マジック値の代わりにバナー kind を持たせる。
//   - 'pr-fetch-failed': PR モードで base/head blob 取得失敗 (gh CLI 認証切れ / PR closed 等)
//   - 'unknown-file'   : panel が言及した file path が working tree / sources Map に存在しない
//                        (AI が summary.json の file path を typo した可能性)
// asIs / toBe どちらの side が欠落したかを bool で持つ (両側欠落のケースもある)。
export type SourcesUnavailable =
  | { kind: 'pr-fetch-failed'; asIs?: boolean; toBe?: boolean }
  | { kind: 'unknown-file'; asIs?: boolean; toBe?: boolean }

export type RenderedPanel = Panel & {
  // cross-file の異言語ペア (例: .js → .ts) を split 表示で左右別言語ハイライトするため別持ち。
  // v4.8.0 で unified mode 廃止、split 一本化したが「将来の zoom-in view 等で別言語別表示」を
  // するなら同じフィールド構造が再利用できるので残す。
  asIsLanguage?: string
  toBeLanguage?: string
  segments: RenderedSegment[]
  asIsTotal?: number
  toBeTotal?: number
  sourcesUnavailable?: SourcesUnavailable
}

// CLI が summary.groups[i] を 1:1 で変換した中間表現。
// groupId は cli.ts 側で `g${index}` を生成して載せる (W-1: title 重複でも衝突しない安定 ID)。
// v4.8.0 で Channels notification 経路が消えたので、旧 groupTitle (notification 属性用) は廃止。
export type RenderedGroup = {
  groupId: string
  title: string
  description: string
  panels: RenderedPanel[]
}

export type ClientPayload = {
  schemaVersion: 1
  summary: SummaryJson
  prMeta: PrMeta | null
  groups: RenderedGroup[]
  // 全 panel の panelId を flatten (App.tsx の Reviewed 集計 / nav 用)
  allPanels: string[]
  // staged モードなら true。PR モードで gh CLI 経由で base/head blob が取れたら true。
  expandable: boolean
  // v4.8.0: context+ の close-relaunch から戻ってきたとき、CLI が --restore-state で読んだ
  // restore.json を ClientPayload に注入する。初回起動 (restore なし) では全て undefined。
  // App.tsx の useState 初期化 + useLineComments の seed として消費される。
  initialReviewedPanels?: string[]
  initialLineCommentDrafts?: Record<string, string>
  initialComments?: Comment[]
}
