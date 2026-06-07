// parse-git-diff を side-by-side 表示用の行ペアに変換する。
//
// なぜ Shiki を呼ばないか:
//   旧実装は行ごとに codeToHtml() を CLI bundle 内 (Node 側) で実行していたが、
//   GitHub/GitLab と同様にハイライトはクライアントの責務に倒した。
//   サーバは raw text + language hint だけを ParsedFile に詰め、ブラウザ側の Shiki が
//   レンダリング時にハイライトする。これで server bundle から Shiki + langs + themes が消える。
//
// なぜ side-by-side を CLI 側で作るか:
// - HTML 側で diff を再パースすると、ブラウザに重いロジックを抱え込ませることになる
// - サーバー側で一度構造化してしまえば後段は単純な DOM 構築だけで済む
//
// なぜ hunk 単位の構造にしたか:
// - 1 ファイルが複数の Group にまたがるケース (目的別ファイル分割) で、Group ごとに
//   「該当 hunk だけ」をレンダリングできるようにするため
// - hunks 間の「⇕ N unchanged lines」バナーを描画する際、各 hunk の oldStart/newStart
//   が必要

import parseGitDiff from 'parse-git-diff'
import type { Hunk, ParsedFile, SideBySideRow } from '@zeus/review-diff-shared'

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

export function parseDiff(diffText: string): ParsedFile[] {
  const parsed = parseGitDiff(diffText) as unknown as { files: AnyFile[] }
  return (parsed.files ?? []).map((f) => fileToParsed(f))
}

function fileToParsed(f: AnyFile): ParsedFile {
  let status: ParsedFile['status'] = 'modified'
  if (f.type === 'AddedFile') status = 'added'
  else if (f.type === 'DeletedFile') status = 'deleted'
  else if (f.type === 'RenamedFile') status = 'renamed'

  // parse-git-diff はバイナリ差分を BinaryFilesChunk として表現する。
  // バイナリは行ハイライトも side-by-side 表示も無意味なので status だけ立てて中身は捨てる。
  const isBinary = (f.chunks ?? []).some((c) => c.type === 'BinaryFilesChunk')
  if (isBinary) status = 'binary'

  const path = f.pathAfter ?? f.path ?? f.pathBefore ?? 'unknown'
  const oldPath = f.pathBefore && f.pathBefore !== path ? f.pathBefore : undefined
  const language = langForPath(path)

  const hunks: Hunk[] = []
  let additions = 0
  let deletions = 0
  let totalLines = 0

  if (!isBinary) {
    let hunkIndex = 0
    for (const chunk of f.chunks ?? []) {
      if (chunk.type === 'BinaryFilesChunk') continue
      const rows = chunkToRows(chunk)
      const fromRange = chunk.fromFileRange ?? { start: 0, lines: 0 }
      const toRange = chunk.toFileRange ?? { start: 0, lines: 0 }
      hunks.push({
        index: hunkIndex,
        oldStart: fromRange.start,
        oldLines: fromRange.lines,
        newStart: toRange.start,
        newLines: toRange.lines,
        rows,
        origin: 'changed',
      })
      totalLines += rows.length
      hunkIndex++
      for (const line of chunk.changes ?? []) {
        if (line.type === 'AddedLine') additions++
        else if (line.type === 'DeletedLine') deletions++
      }
    }
  }

  return {
    path,
    oldPath,
    status,
    language,
    additions,
    deletions,
    hunks,
    totalLines,
  }
}

function chunkToRows(chunk: AnyChunk): SideBySideRow[] {
  // 連続する deletion / addition を貯めて、unchanged 行に遭遇したタイミングで
  // 「ペアにできるだけ並べる」方針で flush する (側面同士をズラさないため)。
  const rows: SideBySideRow[] = []
  let dels: AnyChange[] = []
  let adds: AnyChange[] = []

  const flush = () => {
    const max = Math.max(dels.length, adds.length)
    for (let i = 0; i < max; i++) {
      const d = dels[i]
      const a = adds[i]
      rows.push({
        left: d
          ? { type: 'deletion', line: d.lineBefore, raw: stripTrailingNl(d.content) }
          : { type: 'empty', raw: '' },
        right: a
          ? { type: 'addition', line: a.lineAfter, raw: stripTrailingNl(a.content) }
          : { type: 'empty', raw: '' },
      })
    }
    dels = []
    adds = []
  }

  for (const line of chunk.changes ?? []) {
    if (line.type === 'DeletedLine') dels.push(line)
    else if (line.type === 'AddedLine') adds.push(line)
    else if (line.type === 'UnchangedLine' || line.type === 'MessageLine') {
      flush()
      if (line.type === 'UnchangedLine') {
        const raw = stripTrailingNl(line.content)
        rows.push({
          left: { type: 'context', line: line.lineBefore, raw },
          right: { type: 'context', line: line.lineAfter, raw },
        })
      }
    }
  }
  flush()
  return rows
}

function stripTrailingNl(s: string): string {
  return s.replace(/\n$/, '')
}

// 拡張子 → Shiki の言語 ID マッピング。
// client 側 Shiki に lang として渡す前提なので、Shiki が受け付ける ID 体系に揃える。
// Dockerfile のように拡張子を持たないファイルは basename で別途判定する。
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
