// shared 型定義 (v4.12.0 stacked PR 風 group ベース承認モデル)。client/server/cli が import する。
// 設計判断:
//   - panel 単位の Reviewed 概念を廃止し、group 単位の Approve / Request Changes に統合
//   - 全体の Approve/Reject ボタンは廃止、Submit Review 1 つに統一
//   - groupDecisions の分布から SKILL.md 側が「全 approved / 全 RC / mixed」を判定し linear-stack で
//     commit-per-group を作る (CLI は git 操作しない)
//   - Comment.scope の 'overall' は廃止し 'group' に統合 (情報密度向上、UI の colocate 設計)
//   - regen-group / restore.json モデルは維持し、再起動時に groupDecisions / groupComments /
//     lineCommentDrafts を seed して状態をシームレスに復元する
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
// Comment / Result (v4.12.0 stacked group モデル)
// =====================================================================

// group 単位の Approve / Request Changes 状態。
// null は client state のみで使う「未決定」を表し、ResultJson には載らない (Submit ボタンが
// 全 group decision 確定時のみ active 化する仕様のため)。
export type GroupDecision = 'approved' | 'request-changes'

// Comment shape (v4.12.0): scope は group か line の 2 択。overall は廃止。
//   - scope: { type: 'group', groupId } → group ヘッダのコメント欄に書かれた本文
//   - scope: { type: 'line', ... }      → panel 内の行 (または範囲) コメント
//     file を併記する理由は、grep で `jq '.comments[] | select(.scope.file=="x.ts")'` を
//     1 段引きできるようにするため + cross-file panel で side だけだとどの file の行か
//     逆引きが必要になるため。
export type Comment = {
  body: string
  scope:
    | { type: 'group'; groupId: string }
    | {
        type: 'line'
        panelId: string
        side: Side
        file: string
        line: number
        endLine?: number
      }
}

// v4.12.0: decision は 'submit' / 'timeout' / 'regen-group' の 3 値。
//   全体の Approve / Reject は廃止し、合否は groupDecisions の分布から SKILL.md が判定する
//   (全 approved → 全 commit / 全 RC → reject ルート / mixed → 先頭から approved を commit、
//    最初の RC で break、残り un-staged)。
//   - 'submit'     : ユーザーが Submit Review ボタンを押した (全 group decision 確定済み)
//   - 'timeout'    : CLI が 9 分タイムアウトで自爆 (groupDecisions は空オブジェクト)
//   - 'regen-group': context+ ボタン押下、close-relaunch + state restore モデルへ
export type ResultJson = {
  decision: 'submit' | 'timeout' | 'regen-group'
  // groupId → 'approved' | 'request-changes'。timeout 時のみ空オブジェクト。
  groupDecisions: Record<string, GroupDecision>
  // group scope と line scope のコメント。overall は廃止 (group に統合)。
  comments: Comment[]
  regenGroup?: {
    groupId: string
    // 現在その group が見せている panel 範囲。AI が「ここから ±N 行広げる」判断に使う。
    currentRanges: Array<{
      panelId: string
      asIs?: { file: string; ranges: DisplayRange[] }
      toBe?: { file: string; ranges: DisplayRange[] }
    }>
    // v4.14.0: ユーザーが inline textarea に書いた自由文 (任意)。
    // SKILL.md 側で AI への指示として活用する: 「foo() の caller も見たい」「呼び出しチェーン全部」など。
    // 空文字や未入力なら省略 (= 旧挙動の「range +5〜10 行拡張だけ」と同等)。
    note?: string
  }
  // v4.14.0: Submit 時に SubmitBar の textarea で書いた全体コメント (任意)。
  // SKILL.md 側で commit メッセージ生成や次アクション判断の参考にする。空文字なら省略。
  submitNote?: string
  // sessionStorage に残っていた未保存 draft 本文。key: `draft:${panelId}:${side}:${num}[:${end}]`
  // 再起動後に sessionStorage に書き戻して、書きかけが残る UX を担保する。
  lineCommentDrafts?: Record<string, string>
}

// v4.12.0: SKILL.md (bash) が CLI 再起動間で状態を中継するための JSON shape。
//   CLI の readRestoreState が defensive に読み込む。client/server 両方から参照できるよう
//   shared に export しておく (旧版は cli.ts ローカル型だった)。
export type RestoreState = {
  groupDecisions?: Record<string, GroupDecision>
  groupComments?: Record<string, string>
  comments?: Comment[]
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
  // 全 panel の panelId を flatten (nav scroll-spy 用)。Reviewed 集計は v4.12.0 で廃止。
  allPanels: string[]
  // staged モードなら true。PR モードで gh CLI 経由で base/head blob が取れたら true。
  expandable: boolean
  // v4.12.0 (refinement): Diff タブ用の「GitHub 風 file-by-file 差分」レンダー済み panel 集合。
  // 各要素は「1 ファイル = 1 panel (full file range)」で、Guide タブの AI グルーピングを介さず
  // 「すべての変更ファイルを順に俯瞰する」用途。Panel コンポーネントを再利用するので shiki ハイライト
  // と split-side-by-side、行コメント機能はそのまま使える。
  rawPanels: RenderedPanel[]
  // v4.12.0: context+ の close-relaunch から戻ってきたとき、CLI が --restore-state で読んだ
  // restore.json を pre-filter して ClientPayload に注入する。初回起動では全て undefined。
  //   - initialGroupDecisions  : group ごとの Approve / Request Changes 状態を復元
  //   - initialGroupComments   : group コメント欄の textarea 値を復元
  //   - initialComments        : line scope のコメントのみ (group scope は CLI が pre-filter で抜く)
  //   - initialLineCommentDrafts: 未保存の line comment draft (sessionStorage 復元用)
  initialGroupDecisions?: Record<string, GroupDecision>
  initialGroupComments?: Record<string, string>
  initialComments?: Comment[]
  initialLineCommentDrafts?: Record<string, string>
  // v4.12.0 (refinement): panel 読了マーカ (左 nav の dot click でトグルする視覚アシスト)。
  // group decision の真の評価軸とは別軸の「どこまで読んだか」追跡。regen-group で復元する。
  initialReviewedPanels?: string[]
}
