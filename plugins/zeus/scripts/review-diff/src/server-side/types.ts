// server-side / client が共有する型定義。
// React コンポーネントは ParsedFile.hunks[].rows をそのまま受け取り、Shiki ハイライト済み span を
// dangerouslySetInnerHTML で展開する。

export type SummaryJson = {
  mode: 'staged' | 'pr'
  pr: PrMeta | null
  overallSummary: string
  groups: Group[]
}

// 1 ファイルが複数の目的にまたがる場合、Group ごとに該当 hunk だけを表示できるよう
// union 型にしてある。string なら「ファイル全体を含める」、object なら hunks 指定。
export type GroupFileRef = string | { path: string; hunks: number[] }

export type Group = {
  title: string
  description: string
  files: GroupFileRef[]
}

export type PrMeta = {
  number: number
  title: string
  body: string
  author: { login?: string } | string
  baseRefName?: string
  headRefName?: string
  // baseRefOid / headRefOid / headRepository は PR モードでの unchanged 行 lazy 展開のために
  // gh CLI 経由で base/head の blob を取得する際に必要。SKILL.md Phase 2 の gh pr view で
  // --json に明示的に含めることで取れる。古い pr-meta.json (これらフィールド無し) でも
  // CLI 側が空文字列で fallback するため optional のまま。
  baseRefOid?: string
  headRefOid?: string
  headRepository?: { nameWithOwner: string }
  additions?: number
  deletions?: number
  changedFiles?: number
}

// レビュー UI が収集するコメント。
// 後方互換:
//   - file === null && line 無し  → overall コメント
//   - file !== null && line 無し  → ファイル全体に対するコメント
//   - file !== null && line あり  → 行コメント (side-by-side の左右どちら + 行番号)
// 既存の reject ハンドリング側は body を読むだけなので、line を追加しても安全に通る。
export type Comment = {
  file: string | null
  body: string
  line?: { side: 'left' | 'right'; number: number }
}

export type ResultJson = {
  decision: 'approve' | 'reject' | 'timeout'
  reviewedFiles: string[]
  comments: Comment[]
}

export type SideBySideRow = {
  left: { type: 'context' | 'deletion' | 'empty'; line?: number; html: string }
  right: { type: 'context' | 'addition' | 'empty'; line?: number; html: string }
}

// parse-git-diff の chunk 単位。oldStart/newStart は 1-based の元ファイル行番号。
// unchanged-lines バナーから「次の hunk まで何行 unchanged を fetch すべきか」を
// 計算するため、新旧両方の開始行と長さをそのまま持っておく。
export type Hunk = {
  index: number               // parse-git-diff の chunks 順、0-based
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  rows: SideBySideRow[]
}

export type ParsedFile = {
  path: string
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary'
  language: string
  additions: number
  deletions: number
  totalLines: number          // 全 hunks の rows 数合計
  hunks: Hunk[]
}

// React アプリ側が <script id="payload"> から JSON.parse で受け取るペイロード。
export type ClientPayload = {
  summary: SummaryJson
  prMeta: PrMeta | null
  files: ParsedFile[]
  allFiles: string[]
  // staged モードなら true (CLI が git show でファイル原文を保持しているので /source 経由で
  // unchanged 行を遅延展開できる)。PR モードでは fallback (バナーは表示するがクリック不可)。
  expandable: boolean
}
