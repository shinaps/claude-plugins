// shared 型定義 (v4.7.0 panel model 完全版)。client/server/cli/channel 全てが import する。
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

export type ResultJson = {
  decision: 'approve' | 'reject' | 'timeout'
  reviewedPanels: string[]
  comments: Comment[]
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
  // cross-file の異言語ペア (例: .js → .ts) をハイライトするため asIs/toBe 別持ち。
  // unified モードでは toBeLanguage を優先 (新コードを正しく見せたい意図)、split モードは左右で別言語。
  asIsLanguage?: string
  toBeLanguage?: string
  segments: RenderedSegment[]
  asIsTotal?: number
  toBeTotal?: number
  sourcesUnavailable?: SourcesUnavailable
}

// CLI が summary.groups[i] を 1:1 で変換した中間表現。
// groupId は cli.ts 側で `g${index}` を生成して載せる (W-1: title 重複でも衝突しない安定 ID)。
// groupTitle は notification content に "group_title" 属性として乗せる用途で別 field 化。
export type RenderedGroup = {
  groupId: string
  groupTitle?: string
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
  // Claude Code Channels 経由の context+/- が利用可能か。CLI が --channels-enabled で受けて
  // template に流す。false なら client は context+/- ボタンを disabled で描画する。
  channelsEnabled: boolean
  // この CLI process を識別する短い hex ID。~/.claude/zeus/review-diffs/active/<sessionId>.json
  // のファイル名と一致する。channel-server.js が SSE 購読を session ごとに分離するために使う。
  sessionId: string
  // browser → Hub (POST /feedback、GET /events/browser) で使う token。
  // 既存の /, /source, /result 用 token とは別 token (channels endpoint だけ独立 token)。
  // channelsEnabled=false でも文字列が入る (空文字)。
  browserToken: string
}

// =====================================================================
// Channels feedback / panels-updated events
// =====================================================================

// useChannelSSE → /feedback POST → eventBus.publish('feedback-sent') で流すペイロード。
// currentRanges は Claude Code が context+/- の意味 (今どこを見せている → どこを足したい/削りたい)
// を判断できるよう、現 group の panels の asIs.ranges/toBe.ranges を集約したもの。
export type FeedbackEvent = {
  sessionId: string
  groupId: string
  // groupTitle は cli.ts が ClientPayload に載せた値を client がそのまま POST に同梱する。
  // mcp-server が notification の group_title 属性に流すための取っ掛かりで、g${index} という
  // 構造性ゼロな groupId を Claude にとって読みやすく補完する用途。空 title なら omit/empty。
  groupTitle?: string
  direction: 'more' | 'less'
  currentRanges: Array<{
    panelId: string
    asIs?: { file: string; ranges: DisplayRange[] }
    toBe?: { file: string; ranges: DisplayRange[] }
  }>
}

// channel-server.js → /channel/inbox POST → eventBus.publish('panels-updated')
// で流すペイロード。groupId 単位で panels[] を差し替える (cross-group ではない)。
export type PanelsUpdatedEvent = {
  groupId: string
  panels: Panel[]
}
