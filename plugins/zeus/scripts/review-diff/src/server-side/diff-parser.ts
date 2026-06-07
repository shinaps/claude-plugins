// parse-git-diff を Shiki シンタックスハイライトと合体させ、
// side-by-side 表示用の行ペアを hunk 単位で組み立てる。
//
// なぜ side-by-side を CLI 側で作るか:
// - HTML 側で diff を再パースすると、ブラウザに重いロジックを抱え込ませることになる
// - サーバー側で一度シンタックスハイライトしてしまえば後段は単純な DOM 構築だけで済む
//
// なぜ hunk 単位の構造にしたか:
// - 1 ファイルが複数の Group にまたがるケース (目的別ファイル分割) で、Group ごとに
//   「該当 hunk だけ」をレンダリングできるようにするため
// - hunks 間の「⇕ N unchanged lines」バナーを描画する際、各 hunk の oldStart/newStart
//   が必要

import parseGitDiff from 'parse-git-diff'
import type { HighlighterCore } from 'shiki/core'
import type { Hunk, ParsedFile, SideBySideRow } from './types.js'
import { langForPath } from './shiki-bundle.js'

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

export function parseDiff(diffText: string, shiki: HighlighterCore): ParsedFile[] {
  const parsed = parseGitDiff(diffText) as unknown as { files: AnyFile[] }
  return (parsed.files ?? []).map((f) => fileToParsed(f, shiki))
}

function fileToParsed(f: AnyFile, shiki: HighlighterCore): ParsedFile {
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
      const rows = chunkToRows(chunk, language, shiki)
      const fromRange = chunk.fromFileRange ?? { start: 0, lines: 0 }
      const toRange = chunk.toFileRange ?? { start: 0, lines: 0 }
      hunks.push({
        index: hunkIndex,
        oldStart: fromRange.start,
        oldLines: fromRange.lines,
        newStart: toRange.start,
        newLines: toRange.lines,
        rows,
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

function chunkToRows(chunk: AnyChunk, language: string, shiki: HighlighterCore): SideBySideRow[] {
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
          ? { type: 'deletion', line: d.lineBefore, html: highlight(d.content, language, shiki) }
          : { type: 'empty', html: '' },
        right: a
          ? { type: 'addition', line: a.lineAfter, html: highlight(a.content, language, shiki) }
          : { type: 'empty', html: '' },
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
        const html = highlight(line.content, language, shiki)
        rows.push({
          left: { type: 'context', line: line.lineBefore, html },
          right: { type: 'context', line: line.lineAfter, html },
        })
      }
    }
  }
  flush()
  return rows
}

function highlight(code: string, lang: string, shiki: HighlighterCore): string {
  // Shiki は <pre><code>…</code></pre> で包んで返すので、行内の span 列だけを抜き取る。
  // 失敗してもプレーンテキストにフォールバックして UI を壊さない。
  try {
    const html = shiki.codeToHtml(code, { lang, theme: 'github-dark' })
    const m = html.match(/<code[^>]*>([\s\S]*?)<\/code>/)
    return (m ? m[1] : escapeHtml(code)).replace(/\n$/, '')
  } catch {
    return escapeHtml(code)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  )
}
