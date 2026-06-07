// parse-git-diff を panel-renderer 用に薄く正規化する。
// 戻り値 FileChange は「変更行集合 (asIs/toBe) と path 情報」だけの軽量構造。
// 実際の行 LCS は panel-renderer 側で jsdiff diffArrays に任せる。
//
// なぜ Shiki を呼ばないか:
//   旧実装は行ごとに codeToHtml() を CLI bundle 内 (Node 側) で実行していたが、
//   GitHub/GitLab と同様にハイライトはクライアントの責務に倒した。
//   サーバは raw text + language hint だけを返し、ブラウザ側の Shiki が
//   レンダリング時にハイライトする。これで server bundle から Shiki + langs + themes が消える。

import parseGitDiff from 'parse-git-diff'

type AnyChange = {
  type: string
  content: string
  lineBefore?: number
  lineAfter?: number
}

type ChunkRange = { start: number; lines: number }

type AnyChunk = {
  type: string
  changes?: AnyChange[]
  fromFileRange?: ChunkRange
  toFileRange?: ChunkRange
}

type AnyFile = {
  type: string
  path?: string
  pathBefore?: string
  pathAfter?: string
  chunks?: AnyChunk[]
}

// =====================================================================
// v4.7.0 新 API: FileChange
// =====================================================================

// panel-renderer / coverage-validator が必要とする最小情報集合。
// hunks 構造は持たない (panel-renderer は asIs/toBe の raw source + ranges から
// jsdiff で改めて LCS を取るため)。
export type FileChange = {
  path: string
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary'
  language: string
  additions: number
  deletions: number
  // before 軸の変更行 (= deletion された行) の行番号集合
  asIsChangedLines: Set<number>
  // after 軸の変更行 (= addition された行) の行番号集合
  toBeChangedLines: Set<number>
  // 行単位の変更があるか (additions > 0 || deletions > 0)
  hasContentChange: boolean
  // rename / binary / mode-change のような構造的変更
  hasStructuralChange: boolean
  // 末尾改行のみの変化 (parse-git-diff の MessageLine "\ No newline at end of file" だけが
  // 出るケース)。coverage-validator はこのケースを skip + warn する。
  eolOnlyChange: boolean
}

export function parseDiff(diffText: string): FileChange[] {
  const parsed = parseGitDiff(diffText) as unknown as { files: AnyFile[] }
  return (parsed.files ?? []).map(fileToChange)
}

function fileToChange(f: AnyFile): FileChange {
  let status: FileChange['status'] = 'modified'
  if (f.type === 'AddedFile') status = 'added'
  else if (f.type === 'DeletedFile') status = 'deleted'
  else if (f.type === 'RenamedFile') status = 'renamed'

  const isBinary = (f.chunks ?? []).some(c => c.type === 'BinaryFilesChunk')
  if (isBinary) status = 'binary'

  const path = f.pathAfter ?? f.path ?? f.pathBefore ?? 'unknown'
  const oldPath = f.pathBefore && f.pathBefore !== path ? f.pathBefore : undefined
  const language = langForPath(path)

  if (isBinary) {
    return {
      path, oldPath, status, language,
      additions: 0, deletions: 0,
      asIsChangedLines: new Set<number>(),
      toBeChangedLines: new Set<number>(),
      hasContentChange: false,
      hasStructuralChange: true,
      eolOnlyChange: false,
    }
  }

  const asIsChangedLines = new Set<number>()
  const toBeChangedLines = new Set<number>()
  let additions = 0
  let deletions = 0
  // EOL-only 判定: addition/deletion が 0 で MessageLine のみが存在するチャンクの場合 true
  let sawMessageOnlyChunk = false

  for (const chunk of f.chunks ?? []) {
    if (chunk.type === 'BinaryFilesChunk') continue
    let chunkHadChange = false
    let chunkHadMessage = false
    for (const line of chunk.changes ?? []) {
      if (line.type === 'DeletedLine') {
        if (line.lineBefore != null) asIsChangedLines.add(line.lineBefore)
        deletions++
        chunkHadChange = true
      } else if (line.type === 'AddedLine') {
        if (line.lineAfter != null) toBeChangedLines.add(line.lineAfter)
        additions++
        chunkHadChange = true
      } else if (line.type === 'MessageLine') {
        chunkHadMessage = true
      }
    }
    if (!chunkHadChange && chunkHadMessage) sawMessageOnlyChunk = true
  }

  const hasContentChange = additions > 0 || deletions > 0
  const eolOnlyChange = !hasContentChange && sawMessageOnlyChunk
  // rename / binary は構造変更フラグも立てる (binary は上で early return 済)
  const hasStructuralChange = status === 'renamed' || status === 'binary'

  return {
    path, oldPath, status, language,
    additions, deletions,
    asIsChangedLines, toBeChangedLines,
    hasContentChange,
    hasStructuralChange,
    eolOnlyChange,
  }
}

// =====================================================================
// 拡張子 → 言語マッピング (共有)
// =====================================================================

const EXT_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', mdx: 'markdown',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  py: 'python', go: 'go', rs: 'rust',
  yaml: 'yaml', yml: 'yaml',
  html: 'html', htm: 'html', css: 'css',
}

const KNOWN = new Set(Object.values(EXT_MAP).concat(['dockerfile']))

export function langForPath(path: string): string {
  const base = path.split('/').pop() ?? ''
  if (base === 'Dockerfile' || base.endsWith('.dockerfile')) return 'dockerfile'
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  const lang = EXT_MAP[ext]
  return lang && KNOWN.has(lang) ? lang : 'plaintext'
}
