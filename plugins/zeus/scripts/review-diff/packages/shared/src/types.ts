// shared 型定義。client/server/cli 全てが import する。
// server-only の SourcesMap / FileSource は packages/server/src/server.ts 内で別途定義。

export type SummaryJson = {
  mode: 'staged' | 'pr'
  pr: PrMeta | null
  overallSummary: string
  groups: Group[]
}

// 意味的レビュー範囲指定。after ファイル (= 変更後) の行番号で範囲を指定する。
// changed 行を含むかどうかは問わない: range が hunk と被ったら自動で包含、被らなければ
// 「AI が文脈として見せたい unchanged 範囲」として展開される。範囲は inclusive, 1-based。
export type DisplayRange = { start: number; end: number }

// 1 ファイルが複数の目的にまたがる場合、Group ごとに該当範囲だけを表示できるよう union 型にしてある。
//   - string: ファイル全体を含める
//   - { path, hunks: [...] }: parse-git-diff の chunk index で範囲指定 (low-level, 後方互換)
//   - { path, displayRanges: [...] }: after 行範囲で「ここを見せて」と AI が意味的に指示 (推奨)
// displayRanges と hunks の併用は不可。両方ある場合は displayRanges を優先する。
export type GroupFileRef =
  | string
  | { path: string; hunks: number[] }
  | { path: string; displayRanges: DisplayRange[] }

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
  // gh CLI 経由で base/head の blob を取得する際に必要。
  baseRefOid?: string
  headRefOid?: string
  headRepository?: { nameWithOwner: string }
  additions?: number
  deletions?: number
  changedFiles?: number
}

// レビュー UI が収集するコメント。
// 後方互換:
//   - file === null && line 無し                       → overall コメント
//   - file !== null && line 無し                       → ファイル全体に対するコメント
//   - file !== null && line.number のみ                → 単一行コメント
//   - file !== null && line.number + line.endNumber    → 行範囲コメント (number <= endNumber)
export type Comment = {
  file: string | null
  body: string
  line?: { side: 'left' | 'right'; number: number; endNumber?: number }
}

export type ResultJson = {
  decision: 'approve' | 'reject' | 'timeout'
  reviewedFiles: string[]
  comments: Comment[]
}

// 重要な変更: server から Shiki を撤去したため、
// row.{left,right}.html (シンタックスハイライト済み HTML) ではなく raw (生コード文字列) を保持。
// client 側で Shiki により codeToHtml を呼んでレンダリング時にハイライトする。
export type SideBySideRow = {
  left: { type: 'context' | 'deletion' | 'empty'; line?: number; raw: string }
  right: { type: 'context' | 'addition' | 'empty'; line?: number; raw: string }
}

// 「この Hunk がどう生まれたか」の出自。UI は origin に応じて視覚処理を変える:
//   - 'changed': 通常の差分 hunk (一番強調)
//   - 'ai-context': AI が displayRanges で「文脈として見せる」と指定した範囲
//   - 'auto-bridge': hunk 間の小さい gap (≤ threshold) を埋めるための自動展開
// origin 省略時は 'changed' とみなす (後方互換)。
export type HunkOrigin = 'changed' | 'ai-context' | 'auto-bridge'

// parse-git-diff の chunk 単位。oldStart/newStart は 1-based の元ファイル行番号。
// unchanged-lines バナーから「次の hunk まで何行 unchanged を fetch すべきか」を
// 計算するため、新旧両方の開始行と長さをそのまま持っておく。
export type Hunk = {
  index: number               // 表示単位順の番号 (composeHunks 後で再採番)。0-based
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  rows: SideBySideRow[]
  origin?: HunkOrigin
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
  // after 側 (= 新ファイル) の総行数。最後の hunk の末尾 〜 ファイル末尾までの unchanged 行範囲を
  // バナー化するために必要。取得失敗 / 削除ファイル / sources 取得失敗時は undefined のままにし、
  // クライアント側は末尾バナーを省略する。
  afterTotal?: number
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
