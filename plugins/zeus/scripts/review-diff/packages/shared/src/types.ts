// shared 型定義 (stacked PR 風 group ベース承認モデル + コメントスレッド v5)。client/server/cli が import する。
// 設計判断:
//   - panel 単位の Reviewed 概念を廃止し、group 単位の Approve / Request Changes に統合
//   - 全体の Approve/Reject ボタンは廃止、Submit Review 1 つに統一 (v5 で 3 ボタン Approve/RC/Comment へ)
//   - groupDecisions の分布から SKILL.md 側が「全 approved / 全 RC / mixed」を判定し linear-stack で
//     commit-per-group を作る (CLI は git 操作しない)
//   - Comment.scope の 'overall' は廃止し 'group' に統合 (情報密度向上、UI の colocate 設計)
//   - regen-group / restore.json モデルは維持し、再起動時に groupDecisions / groupComments /
//     lineCommentDrafts を seed して状態をシームレスに復元する
//   - v5 でコメントを Thread 構造 (user/agent のメッセージ列) に拡張、SubmitBar に Comment ボタン追加
//   - v5 で restore.json schema v2 を導入 (旧 v1 comments[] は CLI が auto-migrate)
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
  // v5 では gh pr checkout でローカル worktree を用意するため lazy blob 取得は不要だが、
  // base ref 名と base SHA は changed-files 取得 / git show <baseSha>:path 経路で使う。
  baseRefOid?: string
  headRefOid?: string
  headRepository?: { nameWithOwner: string }
  additions?: number
  deletions?: number
  changedFiles?: number
}

// 複数プロジェクトのレビュータブを同時に開いたとき、どのリポジトリのレビューかを
// ブラウザタブ / ヘッダでぱっと見で識別するための情報。git から引けなければ null。
export type ProjectInfo = {
  // リポジトリルートの directory 名 (git rev-parse --show-toplevel の basename)
  name: string
  // detached HEAD では null
  branch: string | null
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
// Comment / Thread (v5 コメントスレッド)
// =====================================================================

// group 単位の Approve / Request Changes 状態。
// null は client state のみで使う「未決定」を表し、ResultJson には載らない。
// v5 では SubmitBar に Comment ボタンが追加されたが、Comment は review 全体の reviewKind 側に
// 載るのであって、group 単位の decision としては 'comment' は導入しない (FR-1-5)。
export type GroupDecision = 'approved' | 'request-changes'

// v5 で review 全体の種別。groupDecisions と独立して動く。
//   - 'approve'         : 全 group を approved 扱いにして linear-stack commit
//   - 'request-changes' : 修正対応 (commit せず Claude に戻す)
//   - 'comment'         : commit せず Claude が全 open スレッドに自動返信
export type ReviewKind = 'approve' | 'request-changes' | 'comment'

// 旧 Comment 型 (v4 互換)。v5 でも restore.json v1 → v2 migration の入力として残す。
// 新 UI は ThreadSnapshot 経由で読み書きする。
export type Comment = {
  body: string
  scope:
    | { type: 'group'; groupId: string }
    | { type: 'file'; file: string }
    | {
        type: 'line'
        panelId: string
        side: Side
        file: string
        line: number
        endLine?: number
      }
}

// スレッドメッセージの著者。'user' は人間レビュアー、'agent' は Claude。
export type ThreadMessageAuthor = 'user' | 'agent'

// agent (Claude) がスレッドへの返信時に併記する「対応種別」。
//   - 'answer'  : 質問への回答のみ (実ファイル変更なし)
//   - 'suggest' : 修正提案 (本文 + diff サンプル、適用はしていない)
//   - 'apply'   : 実ファイルを書き換えた (apply 後の outdated 判定対象)
//   - 'expand'  : panel 範囲拡張 (context+ 相当)
export type AgentAction =
  | { kind: 'answer' }
  | { kind: 'suggest'; diffSample?: string }
  | { kind: 'apply'; files: { path: string; summary: string }[] }
  | { kind: 'expand'; addedPanelIds: string[] }

// スレッド内の 1 メッセージ。id は crypto.randomUUID() で生成 (Node 20+ globalThis.crypto 標準)。
export type ThreadMessage = {
  id: string
  author: ThreadMessageAuthor
  body: string
  ts: number
  agentAction?: AgentAction
}

// スレッドの anchor。line / group / file / review のいずれか。'overall' は v4 で廃止済み。
// file scope は「特定の行ではなくファイル全体への指摘」(設計方針・命名・ファイル分割など) 用。
// review scope は「レビュー全体への申し送り・指摘」用 (SubmitBar の textarea = この thread への入力)。
// anchor が 1 つしかないため payload を持たない。
export type ThreadScope =
  | { type: 'group'; groupId: string }
  | { type: 'file'; file: string }
  | { type: 'review' }
  | {
      type: 'line'
      panelId: string
      side: Side
      file: string
      line: number
      endLine?: number
    }

// スレッドの状態。persistence と runtime で同じ形 (immutable、setState で新インスタンス置換)。
//   - resolved          : GitHub PR 互換の resolve/reopen 状態 (Approve 警告に使う)
//   - outdated          : apply 後の自動判定 + outdatedOverride 補正で更新される
//   - outdatedOverride  : 'force' = 強制 true、'keep' = 強制 false、未指定なら自動判定結果を採用
export type ThreadSnapshot = {
  scope: ThreadScope
  messages: ThreadMessage[]
  resolved: boolean
  outdated: boolean
  outdatedOverride?: 'force' | 'keep'
}

// =====================================================================
// Script Gate (機能 3)
// =====================================================================

// 1 スクリプトの実行結果。
//   - 'passed'   : exit 0
//   - 'failed'   : exit != 0 or spawn error
//   - 'skipped'  : matchFiles に一致するファイルがなかった / timeout
export type ScriptResult = {
  name: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  exitCode?: number | null
  stdoutTail?: string
  stderrTail?: string
  reason?: 'no matchFiles hit' | 'timeout' | 'spawn error'
}

// CLI が script-results.json に書き出すペイロード (CLI 起動時に Read → ClientPayload 注入)。
export type ScriptResultsPayload = {
  ranAt: number
  results: ScriptResult[]
}

// review-diff.config.json の scripts[] エントリ。
//   - matchFiles : staged diff の変更ファイルと picomatch で照合、ヒットなしなら skip
//   - timeoutMs  : SIGTERM 送信までの猶予 (未指定なら DEFAULT_SCRIPT_TIMEOUT_MS = 60000)
export type ScriptConfig = {
  name: string
  command: string
  matchFiles: string[]
  timeoutMs?: number
}

// =====================================================================
// Editor Preset (機能 2)
// =====================================================================

export type EditorKind = 'vscode' | 'cursor' | 'idea' | 'zed' | 'sublime' | 'custom'

// EditorPreset は server 側のみで保持される (CR-3: editor command をクライアントに漏らさない)。
// CLI が config から preset を解決し、startServer({ editorPreset }) で server に注入。
//   - command   : `{path}` `{line}` プレースホルダ展開後に spawn される shell 文字列
//   - urlScheme : v5 は一刀構成 (CLI command のみ) で実行時には未使用、type 互換のため残す
export type EditorPreset = {
  kind: EditorKind
  command: string
  urlScheme: string | null
}

// review-diff.config.json 全体スキーマ。
//   - editor は省略可 (省略時はエディタリンク無効化 = ClientPayload.editorAvailable=false)
//   - scripts は省略可 (省略時はゲートをスキップ)
export type ReviewDiffConfig = {
  editor?: { kind: EditorKind; command?: string; urlScheme?: string }
  scripts?: ScriptConfig[]
}

// =====================================================================
// Result / Restore (v5)
// =====================================================================

// decision は CLI が stdout に吐く ResultJson のトップフィールド。
//   - 'submit'        : 通常の Approve / Request Changes Submit (linear-stack commit ルートへ)
//   - 'timeout'       : heartbeat 切れ自爆 (groupDecisions / threads は空でも可)
//   - 'regen-group'   : context+ 押下、close-relaunch + restore
//   - 'comment-reply' : v5 新値。reviewKind='comment' Submit 時、Claude が thread に返信して再起動するルート
export type Decision = 'submit' | 'timeout' | 'regen-group' | 'comment-reply'

export type ResultJson = {
  decision: Decision
  // v5 で必須化。review 全体の種別。timeout 時は 'comment' を入れて構造を揃える (SKILL.md は decision で判定)。
  reviewKind: ReviewKind
  // groupId → 'approved' | 'request-changes'。timeout 時のみ空オブジェクト。
  groupDecisions: Record<string, GroupDecision>
  // v5 で必須化 (空オブジェクトでも明示)。threadKey() ベースで thread state を載せる。
  threads: Record<string, ThreadSnapshot>
  // 旧形式互換、optional に降格 (v4 readers がいた場合の degradation 用、v5 自身は読まない)。
  comments?: Comment[]
  regenGroup?: {
    groupId: string
    // 現在その group が見せている panel 範囲。AI が「ここから ±N 行広げる」判断に使う。
    currentRanges: Array<{
      panelId: string
      asIs?: { file: string; ranges: DisplayRange[] }
      toBe?: { file: string; ranges: DisplayRange[] }
    }>
    // ユーザーが inline textarea に書いた自由文 (任意)。
    note?: string
  }
  // Submit 時に SubmitBar の textarea で書いた全体コメント (任意)。
  submitNote?: string
  // sessionStorage に残っていた未保存 draft 本文。
  lineCommentDrafts?: Record<string, string>
}

// SKILL.md (bash) と CLI 間で状態を中継する restore.json v2 形式。
//   v1 (comments[]) は CLI の readRestoreState() が auto-migrate して threads に変換する。
export type RestoreStateV2 = {
  schemaVersion: 2
  groupDecisions?: Record<string, GroupDecision>
  groupComments?: Record<string, string>
  // v5 のスレッド永続化。空でも明示推奨。
  threads?: Record<string, ThreadSnapshot>
  lineCommentDrafts?: Record<string, string>
  reviewKind?: ReviewKind
}

// 旧 v1 RestoreState (CLI が auto-migrate 入力として読む)。
//   v4 までは schemaVersion フィールドが無かったので、未指定 = v1 とみなす。
export type RestoreStateV1 = {
  schemaVersion?: 1
  groupDecisions?: Record<string, GroupDecision>
  groupComments?: Record<string, string>
  comments?: Comment[]
  lineCommentDrafts?: Record<string, string>
}

// v5 では CLI 内部で常に v2 構造として扱うため、エイリアスを v2 に向ける。
// 旧名 RestoreState を import している既存コードのために残す。
export type RestoreState = RestoreStateV2

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
//   - 'pr-fetch-failed': PR モードで base/head blob 取得失敗
//   - 'unknown-file'   : panel が言及した file path が working tree / sources Map に存在しない
//                        (AI が summary.json の file path を typo した可能性)
export type SourcesUnavailable =
  | { kind: 'pr-fetch-failed'; asIs?: boolean; toBe?: boolean }
  | { kind: 'unknown-file'; asIs?: boolean; toBe?: boolean }

export type RenderedPanel = Panel & {
  asIsLanguage?: string
  toBeLanguage?: string
  segments: RenderedSegment[]
  asIsTotal?: number
  toBeTotal?: number
  sourcesUnavailable?: SourcesUnavailable
}

// CLI が summary.groups[i] を 1:1 で変換した中間表現。
// groupId は cli.ts 側で `g${index}` を生成して載せる (W-1: title 重複でも衝突しない安定 ID)。
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
  project: ProjectInfo | null
  groups: RenderedGroup[]
  // 全 panel の panelId を flatten (nav scroll-spy 用)。
  allPanels: string[]
  // v5 では PR モードも gh pr checkout でローカル worktree を持つので常に true 寄り。
  expandable: boolean
  // Diff タブ用の「GitHub 風 file-by-file 差分」レンダー済み panel 集合。
  rawPanels: RenderedPanel[]
  // context+ / comment-reply の close-relaunch から戻ってきたとき、CLI が --restore-state で読んだ
  // restore.json (v2) を pre-filter して ClientPayload に注入する。初回起動では全て undefined。
  initialGroupDecisions?: Record<string, GroupDecision>
  initialGroupComments?: Record<string, string>
  // v4 互換: line scope のみの Comment[] (CLI が v1 restore.json を読んだとき seed として使う)。
  initialComments?: Comment[]
  initialLineCommentDrafts?: Record<string, string>
  // v5 で新規。restore.json v2 の threads をそのまま seed する。
  initialThreads?: Record<string, ThreadSnapshot>
  // v5 で新規。前回 submit 時の reviewKind を seed する (SubmitBar の初期 active ボタン制御)。
  initialReviewKind?: ReviewKind
  // v5 で新規。Phase 4.5 (script gate) を通過したときの結果。Activity タブの Pre-flight 表示用。
  scriptResults?: ScriptResultsPayload
  // v5 で新規。editor preset が設定されているか (= EditorLinkTrigger を描画するか)。
  // CR-3: editor command は server 側にしか保持されないので、boolean だけ伝搬する。
  editorAvailable: boolean
}
