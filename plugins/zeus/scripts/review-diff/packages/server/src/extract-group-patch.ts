// extractGroupPatch: 指定 group の panels が claim する変更行だけを含む unified diff (--unidiff-zero 互換) を生成する。
//
// 設計判断:
//   - SKILL.md (bash) が `node dist/cli.js extract-group-patch --summary ... --diff ... --group g0`
//     を呼んで stdout 経由で受け取る。CLI ではなく server レイヤに実装を置くことで vitest で
//     ユニットテスト可能にする (CLI 層は parseArgs と process I/O だけ)。
//   - 出力は --unidiff-zero 互換 (context 行 0)。context が混じると複数 group が同じ context 行を
//     共有する設計と衝突するため。git apply 時は `--unidiff-zero --recount` を付ける前提。
//   - 同一 hunk 内に他 group の変更行が混じる場合、他 group の Added/Deleted 行は出力に含めない
//     (context 行への降格も不要、--unidiff-zero では context そのものを書かないため、単に skip)。
//   - rename + 内容変更: rename header (`rename from old` / `rename to new`) を維持する。
//   - 空 patch (= group の panels が一切変更行を claim しない、context-only group): stdout に
//     空文字列を出して exit 0。SKILL.md が「空なら commit skip」する。

import parseGitDiff from 'parse-git-diff'
import type { SummaryJson, Panel } from '@zeus/review-diff-shared'

// parse-git-diff の AnyFile / AnyChunk / AnyChange は型 export されていないため独自定義 (diff-parser と同形)。
type AnyChange = {
  type: 'AddedLine' | 'DeletedLine' | 'UnchangedLine' | 'MessageLine'
  content: string
  lineBefore?: number
  lineAfter?: number
}
type AnyChunk = {
  type: string
  changes?: AnyChange[]
  fromFileRange?: { start: number; lines: number }
  toFileRange?: { start: number; lines: number }
}
type AnyFile = {
  type: 'AddedFile' | 'DeletedFile' | 'ChangedFile' | 'RenamedFile'
  path?: string
  pathBefore?: string
  pathAfter?: string
  chunks?: AnyChunk[]
}

export type ExtractGroupPatchInput = {
  summary: SummaryJson
  diffText: string
  groupId: string
}

export type ExtractGroupPatchResult = {
  ok: boolean
  patch: string
  error?: string
}

export function extractGroupPatch(input: ExtractGroupPatchInput): ExtractGroupPatchResult {
  const { summary, groupId, diffText } = input

  // groupId は 'g${i}' 形式。summary.groups[index] を引く。
  const m = /^g(\d+)$/.exec(groupId)
  if (!m) {
    return { ok: false, patch: '', error: `invalid groupId format: ${groupId} (expected 'g<index>')` }
  }
  const idx = Number.parseInt(m[1], 10)
  const group = summary.groups[idx]
  if (!group) {
    return { ok: false, patch: '', error: `group not found at index ${idx}` }
  }

  // 該当 group の panels から (file, side, lineSet) を集約。
  // asIs.file は rename の場合 oldPath、それ以外は path と一致するよう AI に書いてもらう前提。
  const ownedAsIs = new Map<string, Set<number>>() // asIs.file → owned before-lines
  const ownedToBe = new Map<string, Set<number>>() // toBe.file → owned after-lines
  for (const p of group.panels as Panel[]) {
    if (p.asIs) {
      const s = ownedAsIs.get(p.asIs.file) ?? new Set<number>()
      for (const r of p.asIs.ranges) {
        for (let n = r.start; n <= r.end; n++) s.add(n)
      }
      ownedAsIs.set(p.asIs.file, s)
    }
    if (p.toBe) {
      const s = ownedToBe.get(p.toBe.file) ?? new Set<number>()
      for (const r of p.toBe.ranges) {
        for (let n = r.start; n <= r.end; n++) s.add(n)
      }
      ownedToBe.set(p.toBe.file, s)
    }
  }

  // panels が言及する全 file (asIs と toBe を union) を集めて、diff から該当 file 部分のみ抽出する。
  const filesOfInterest = new Set<string>()
  for (const f of ownedAsIs.keys()) filesOfInterest.add(f)
  for (const f of ownedToBe.keys()) filesOfInterest.add(f)

  const parsed = parseGitDiff(diffText) as unknown as { files: AnyFile[] }
  const out: string[] = []

  for (const file of parsed.files ?? []) {
    const path = file.pathAfter ?? file.path ?? file.pathBefore ?? ''
    const oldPath = file.pathBefore ?? path
    // panel が言及する file かチェック (asIs=oldPath, toBe=path どちらでも該当する可能性あり)
    if (!filesOfInterest.has(path) && !filesOfInterest.has(oldPath)) continue

    const asIsLines = ownedAsIs.get(oldPath) ?? ownedAsIs.get(path) ?? new Set<number>()
    const toBeLines = ownedToBe.get(path) ?? new Set<number>()

    // ファイル単位で各 chunk の Added/Deleted 行を group が claim しているかフィルタ
    // 出力は --unidiff-zero 形式: 連続する +/- 行を 1 hunk にまとめる。
    const hunks: string[] = []
    for (const chunk of file.chunks ?? []) {
      if (chunk.type === 'BinaryFilesChunk') continue
      const blocks = collectBlocksForChunk(chunk, asIsLines, toBeLines)
      for (const b of blocks) {
        hunks.push(formatHunk(b))
      }
    }

    // 空 patch (group がこの file の変更行を一切 claim していない) は skip
    if (hunks.length === 0 && file.type !== 'RenamedFile') continue
    // rename-only (内容変更なし) の group claim 判定:
    //   - file.type === 'RenamedFile' で hunks 空 → rename だけ commit する用途 (現状未対応)
    //   - hunks 空 + rename でもない → 完全 skip

    out.push(formatFileHeader(file, hunks.length > 0))
    for (const h of hunks) out.push(h)
  }

  return { ok: true, patch: out.join('') }
}

type Block = {
  beforeStart: number // この block 内の最初の deletion 行の lineBefore (純粋 addition なら 後述の anchor)
  afterStart: number
  beforeLines: string[] // '-...\n' 形式
  afterLines: string[] // '+...\n' 形式
}

// 1 chunk 内の changes を walk して、group が claim している変更行を block 単位に集約する。
// 「連続して group が claim している変更行」のまとまり = 1 block = 1 hunk として出力する。
// 他 group が claim する変更行や Unchanged 行に当たったら block を切る。
function collectBlocksForChunk(
  chunk: AnyChunk,
  asIsLines: Set<number>,
  toBeLines: Set<number>,
): Block[] {
  const blocks: Block[] = []
  // 現在組み立て中の block。null = 未開始。
  let cur: Block | null = null
  // cursor: hunk header から推定する before/after 行の位置 (block 内で参照)
  let beforeCursor = chunk.fromFileRange?.start ?? 1
  let afterCursor = chunk.toFileRange?.start ?? 1
  // pure-addition の block で beforeStart として使う anchor (= 直前の context 行 の lineBefore、
  // hunk 先頭なら fromFileRange.start - 1)
  let lastContextBefore = (chunk.fromFileRange?.start ?? 1) - 1

  const flush = () => {
    if (cur && (cur.beforeLines.length > 0 || cur.afterLines.length > 0)) {
      blocks.push(cur)
    }
    cur = null
  }

  for (const ch of chunk.changes ?? []) {
    if (ch.type === 'UnchangedLine') {
      flush()
      if (ch.lineBefore != null) lastContextBefore = ch.lineBefore
      beforeCursor = (ch.lineBefore ?? beforeCursor) + 1
      afterCursor = (ch.lineAfter ?? afterCursor) + 1
      continue
    }
    if (ch.type === 'MessageLine') {
      // "\ No newline at end of file" 等の info メッセージ。block には含めない。
      continue
    }
    if (ch.type === 'DeletedLine') {
      const before = ch.lineBefore ?? beforeCursor
      const claimed = asIsLines.has(before)
      if (!claimed) {
        flush()
        beforeCursor = before + 1
        continue
      }
      if (!cur) {
        cur = { beforeStart: before, afterStart: afterCursor, beforeLines: [], afterLines: [] }
      } else if (cur.beforeLines.length === 0) {
        // pure-addition で始まった block に最初の deletion が join した場合、
        // beforeStart は最初 lastContextBefore に anchor されているので、実 line に更新する。
        // これをしないと `--unidiff-zero` のヘッダ `@@ -<beforeStart>,1 +<afterStart>,N @@` が
        // 嘘の before 行番号を指して git apply が誤位置を削除する事故になる。
        cur.beforeStart = before
      }
      cur.beforeLines.push(`-${ch.content}\n`)
      beforeCursor = before + 1
      continue
    }
    if (ch.type === 'AddedLine') {
      const after = ch.lineAfter ?? afterCursor
      const claimed = toBeLines.has(after)
      if (!claimed) {
        flush()
        afterCursor = after + 1
        continue
      }
      if (!cur) {
        cur = {
          // beforeStart: 既に block 内に deletion がある場合は元の beforeStart、
          // 純粋 addition で先頭なら直前の context 行の lineBefore (= 挿入アンカー)
          beforeStart: lastContextBefore,
          afterStart: after,
          beforeLines: [],
          afterLines: [],
        }
      }
      cur.afterLines.push(`+${ch.content}\n`)
      afterCursor = after + 1
      continue
    }
  }
  flush()
  return blocks
}

// `@@ -<beforeStart>,<beforeCount> +<afterStart>,<afterCount> @@\n` + body
function formatHunk(b: Block): string {
  const beforeCount = b.beforeLines.length
  const afterCount = b.afterLines.length
  // pure-addition (beforeCount=0) で beforeStart は anchor 行 (insertion 直前の context 行) を使う
  // unified diff のお作法。git apply --unidiff-zero --recount で吸収される。
  const header = `@@ -${b.beforeStart},${beforeCount} +${b.afterStart},${afterCount} @@\n`
  return header + b.beforeLines.join('') + b.afterLines.join('')
}

// ファイル header (`diff --git a/X b/Y`、rename header、index、---/+++)。
// 内容変更がある場合 (hasBody=true) のみ index / ---/+++ を出力する。
function formatFileHeader(file: AnyFile, hasBody: boolean): string {
  const path = file.pathAfter ?? file.path ?? file.pathBefore ?? ''
  const oldPath = file.pathBefore ?? path
  const lines: string[] = []
  lines.push(`diff --git a/${oldPath} b/${path}\n`)
  if (file.type === 'RenamedFile') {
    // similarity index は元の patch から取れないので省略。git apply は無くても通る。
    lines.push(`rename from ${oldPath}\n`)
    lines.push(`rename to ${path}\n`)
  }
  if (file.type === 'AddedFile') {
    lines.push('new file mode 100644\n')
  } else if (file.type === 'DeletedFile') {
    lines.push('deleted file mode 100644\n')
  }
  // hasBody=true なら --- / +++ ヘッダが必要 (hunks の前提)。
  // rename-only (hasBody=false) の場合は省略可。
  if (hasBody) {
    if (file.type === 'AddedFile') {
      lines.push('--- /dev/null\n')
      lines.push(`+++ b/${path}\n`)
    } else if (file.type === 'DeletedFile') {
      lines.push(`--- a/${oldPath}\n`)
      lines.push('+++ /dev/null\n')
    } else {
      lines.push(`--- a/${oldPath}\n`)
      lines.push(`+++ b/${path}\n`)
    }
  }
  return lines.join('')
}
