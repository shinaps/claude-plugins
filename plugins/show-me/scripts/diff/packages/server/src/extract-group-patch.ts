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
//
// 座標系 (重要):
//   - parse-git-diff の lineAfter は「全 group 適用後」のファイル座標。一方 linear-stack コミット
//     (SKILL.md) では group gN の patch は「HEAD + 先行 group g0..g(N-1) コミット済み」の index に
//     適用されるため、new 側ヘッダ (`+B`) は committed-prefix 座標へ変換して出力する。
//     変換は afterOffset (ファイル単位累積): 先行 group に属さない skip 行 = まだ index に存在しない
//     追加 (-1) / まだ index に残っている削除 (+1)。先行 group の行は lineAfter が既に織り込んで
//     いるため補正しない。どの group も claim しない行も commit されず index に無いので後続と同じ扱い。
//   - old 側 (`-A`) は補正しない: git apply は zero-context hunk の適用位置を new 側開始行のみで
//     決める (old 側開始行は位置決めに使われない) ため、full-diff 座標のままで害がない。

import parseGitDiff from 'parse-git-diff'
import type { SummaryJson, Panel, PanelSide, Group } from '@show-me/diff-shared'

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
  // mode 変更 (chmod) 時に付く。mode-only は ChangedFile + 空 chunks + oldMode/newMode で返る。
  oldMode?: string
  newMode?: string
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
  const { asIs: ownedAsIs, toBe: ownedToBe } = collectClaims([group])
  // 先行 group (index < idx) の claim 集合。afterOffset の補正対象判定に使う (冒頭コメント参照)。
  const priorClaims = collectClaims(summary.groups.slice(0, idx))

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
    // prior の lookup も own と同一のフォールバック規則にする。rename ファイルで prior が
    // 引けず空 Set になると、先行 group の skip 行まで補正対象に誤算入してしまうため。
    const priorAsIsLines = priorClaims.asIs.get(oldPath) ?? priorClaims.asIs.get(path) ?? new Set<number>()
    const priorToBeLines = priorClaims.toBe.get(path) ?? new Set<number>()

    // ファイル単位で各 chunk の Added/Deleted 行を group が claim しているかフィルタ
    // 出力は --unidiff-zero 形式: 連続する +/- 行を 1 hunk にまとめる。
    // afterOffset は chunk をまたいで効く (前の hunk で skip した行が後の hunk の位置をずらす)
    // ため、state はファイル単位で生成して全 chunk に同じものを渡す。
    const state: FilePatchState = { afterOffset: 0 }
    const hunks: string[] = []
    for (const chunk of file.chunks ?? []) {
      if (chunk.type === 'BinaryFilesChunk') continue
      const blocks = collectBlocksForChunk(
        chunk,
        { asIsLines, toBeLines },
        { asIsLines: priorAsIsLines, toBeLines: priorToBeLines },
        state,
      )
      for (const b of blocks) {
        hunks.push(formatHunk(b))
      }
    }

    // structural ownership: rename / mode 変更 / new-file の構造ヘッダは git index に 1 回しか
    // 適用できない。linear-stack では「このファイルを最初に commit する group (owner)」だけが
    // 構造ヘッダを carry し、後続 group (follower) は newPath ベースの通常 diff として emit する。
    // owner 判定を誤って両 group が rename ヘッダを出すと、2 commit 目の apply が
    // 「oldPath: does not exist in index」で必ず失敗する。
    const contentChanged = fileHasChangedLines(file)
    const modeChanged = file.oldMode != null && file.newMode != null && file.oldMode !== file.newMode
    // DeletedFile は ownership 対象外: 「deleted file mode」の正しい所有者は最後に削除し切る
    // group になり所有権が逆転するため、分割削除は別設計が必要 (現状未対応)。
    const isStructural = file.type === 'RenamedFile' || file.type === 'AddedFile' || modeChanged

    if (hunks.length === 0) {
      // 内容変更があるファイルの変更行を claim していない group (context-only 言及) は
      // 何も emit しない。構造ヘッダは変更行を claim した owner group 側で carry される。
      if (contentChanged || !isStructural) continue
      // structural-only ファイル (rename-only / mode-only): 変更行が無く claim ベースの
      // 所有権が決まらないため、最初に言及した group が構造変更を commit する。
      const priorMentioned =
        priorClaims.asIs.has(oldPath) || priorClaims.asIs.has(path) ||
        priorClaims.toBe.has(oldPath) || priorClaims.toBe.has(path)
      if (priorMentioned) continue
      out.push(formatFileHeader(file, { hasBody: false, carryStructural: true }))
      continue
    }

    const carryStructural = isStructural &&
      !priorClaimsAnyChangedLine(file, priorAsIsLines, priorToBeLines)
    out.push(formatFileHeader(file, { hasBody: true, carryStructural }))
    for (const h of hunks) out.push(h)
  }

  return { ok: true, patch: out.join('') }
}

// file の diff に Added/Deleted 行が 1 つでもあるか (= 内容変更の有無)。
// structural-only (rename-only / mode-only) との分岐判定に使う。
function fileHasChangedLines(file: AnyFile): boolean {
  for (const chunk of file.chunks ?? []) {
    for (const ch of chunk.changes ?? []) {
      if (ch.type === 'AddedLine' || ch.type === 'DeletedLine') return true
    }
  }
  return false
}

// 先行 group が file の変更行を 1 行でも claim 済みか。
// false = 自 group がこのファイルの最初の claim 者 (= structural ownership を持つ)。
// priorClaims の range は context 行も含むが、ここでは diff の実変更行
// (DeletedLine.lineBefore / AddedLine.lineAfter) との交差だけを見るので、
// context-only 言及の先行 group を owner と誤判定しない。
function priorClaimsAnyChangedLine(
  file: AnyFile,
  priorAsIsLines: Set<number>,
  priorToBeLines: Set<number>,
): boolean {
  for (const chunk of file.chunks ?? []) {
    for (const ch of chunk.changes ?? []) {
      if (ch.type === 'DeletedLine' && ch.lineBefore != null && priorAsIsLines.has(ch.lineBefore)) return true
      if (ch.type === 'AddedLine' && ch.lineAfter != null && priorToBeLines.has(ch.lineAfter)) return true
    }
  }
  return false
}

// groups の panels が claim する行集合を file 単位に集約する。
// asIs は oldPath キー / toBe は newPath キー (extractGroupPatch のファイルループの lookup 規則と対応)。
function collectClaims(groups: Group[]): {
  asIs: Map<string, Set<number>>
  toBe: Map<string, Set<number>>
} {
  const asIs = new Map<string, Set<number>>()
  const toBe = new Map<string, Set<number>>()
  const addSide = (map: Map<string, Set<number>>, side: PanelSide) => {
    const lines = map.get(side.file) ?? new Set<number>()
    for (const r of side.ranges) {
      for (let n = r.start; n <= r.end; n++) lines.add(n)
    }
    map.set(side.file, lines)
  }
  for (const g of groups) {
    for (const p of g.panels as Panel[]) {
      if (p.asIs) addSide(asIs, p.asIs)
      if (p.toBe) addSide(toBe, p.toBe)
    }
  }
  return { asIs, toBe }
}

// afterOffset: full-diff 座標 (lineAfter) を「HEAD + 先行 group コミット済み index」の座標へ
// 変換する累積補正。先行 group に属さない skip 行 (= まだ index に存在しない追加 / まだ index に
// 残っている削除) のぶんだけ new 側行番号がずれるため、ファイル先頭から累積する (冒頭コメント参照)。
type FilePatchState = { afterOffset: number }

type Block = {
  beforeStart: number // この block 内の最初の deletion 行の lineBefore (純粋 addition なら 後述の anchor)
  afterStart: number
  beforeLines: string[] // '-...\n' 形式
  afterLines: string[] // '+...\n' 形式
}

// 1 chunk 内の changes を walk して、group が claim している変更行を block 単位に集約する。
// 「連続して group が claim している変更行」のまとまり = 1 block = 1 hunk として出力する。
// 他 group が claim する変更行や Unchanged 行に当たったら block を切る。
// skip は必ず flush() を伴うため、block 生成後にその block の afterStart へ効く offset 変動は
// 起きない (= block 生成時点の state.afterOffset で確定してよい)。
function collectBlocksForChunk(
  chunk: AnyChunk,
  own: { asIsLines: Set<number>; toBeLines: Set<number> },
  prior: { asIsLines: Set<number>; toBeLines: Set<number> },
  state: FilePatchState,
): Block[] {
  const { asIsLines, toBeLines } = own
  const blocks: Block[] = []
  // 現在組み立て中の block。null = 未開始。
  let cur: Block | null = null
  // 直前に block へ push した claimed 行の側。"\ No newline at end of file" (MessageLine) は
  // 直前の +/- 行に従属するマーカーなので、この state で帰属先 (beforeLines/afterLines) を決める。
  // chunk を跨ぐマーカーは diff 仕様上存在しないため、chunk ローカル変数でリークを構造的に防ぐ。
  let lastClaimedSide: 'before' | 'after' | null = null
  // cursor: hunk header から推定する before/after 行の位置 (block 内で参照)
  let beforeCursor = chunk.fromFileRange?.start ?? 1
  let afterCursor = chunk.toFileRange?.start ?? 1
  // pure-addition の block で beforeStart として使う anchor (= 直前の context 行 の lineBefore、
  // hunk 先頭なら fromFileRange.start - 1)。
  // 0 未満に clamp する理由: AddedFile (新規ファイル) の hunk は fromFileRange.start = 0 で、
  // そのまま -1 すると `@@ --1,0 ...` という corrupt なヘッダになり git apply が読めない。
  // 新規ファイルの正規形は `@@ -0,0 +1,N @@`。
  let lastContextBefore = Math.max(0, (chunk.fromFileRange?.start ?? 1) - 1)

  const flush = () => {
    if (cur && (cur.beforeLines.length > 0 || cur.afterLines.length > 0)) {
      blocks.push(cur)
    }
    cur = null
  }

  for (const ch of chunk.changes ?? []) {
    if (ch.type === 'UnchangedLine') {
      flush()
      lastClaimedSide = null
      if (ch.lineBefore != null) lastContextBefore = ch.lineBefore
      beforeCursor = (ch.lineBefore ?? beforeCursor) + 1
      afterCursor = (ch.lineAfter ?? afterCursor) + 1
      continue
    }
    if (ch.type === 'MessageLine') {
      // "\ No newline at end of file" は直前の +/- 行に従属するマーカー。これを落とすと
      // git apply --recount が黙って改行付きで適用し、EOF 改行なしファイルの commit 内容が
      // staged と乖離する (apply は成功するため気付けない silent corruption)。
      // 直前行を claim していない場合 (他 group 所有で skip 済み) はその行自体が
      // この patch に無いので、マーカーも載せない (所有 group の patch 側に載る)。
      // parse-git-diff は content を trim 済みで返すため "\ " + content で行を再構成する
      // (git apply は先頭の "\" しか見ないので文言差は無害)。
      if (cur && lastClaimedSide === 'before') {
        cur.beforeLines.push(`\\ ${ch.content}\n`)
      } else if (cur && lastClaimedSide === 'after') {
        cur.afterLines.push(`\\ ${ch.content}\n`)
      }
      continue
    }
    if (ch.type === 'DeletedLine') {
      const before = ch.lineBefore ?? beforeCursor
      const claimed = asIsLines.has(before)
      if (!claimed) {
        flush()
        lastClaimedSide = null
        // 先行 group 以外の削除行は committed-prefix index にまだ残っているため、
        // これ以降の new 側行番号は full-diff 座標より 1 行下にずれる。
        if (!prior.asIsLines.has(before)) state.afterOffset += 1
        beforeCursor = before + 1
        continue
      }
      if (!cur) {
        cur = { beforeStart: before, afterStart: afterCursor + state.afterOffset, beforeLines: [], afterLines: [] }
      } else if (cur.beforeLines.length === 0) {
        // pure-addition で始まった block に最初の deletion が join した場合、
        // beforeStart は最初 lastContextBefore に anchor されているので、実 line に更新する。
        // これをしないと `--unidiff-zero` のヘッダ `@@ -<beforeStart>,1 +<afterStart>,N @@` が
        // 嘘の before 行番号を指して git apply が誤位置を削除する事故になる。
        cur.beforeStart = before
      }
      cur.beforeLines.push(`-${ch.content}\n`)
      lastClaimedSide = 'before'
      beforeCursor = before + 1
      continue
    }
    if (ch.type === 'AddedLine') {
      const after = ch.lineAfter ?? afterCursor
      const claimed = toBeLines.has(after)
      if (!claimed) {
        flush()
        lastClaimedSide = null
        // 先行 group 以外の追加行は committed-prefix index にまだ存在しないため、
        // これ以降の new 側行番号は full-diff 座標より 1 行上にずれる。
        if (!prior.toBeLines.has(after)) state.afterOffset -= 1
        afterCursor = after + 1
        continue
      }
      if (!cur) {
        const afterStart = after + state.afterOffset
        cur = {
          // beforeStart: 既に block 内に deletion がある場合は元の beforeStart、
          // 純粋 addition で先頭なら直前の context 行の lineBefore (= 挿入アンカー)。
          //
          // anchor 0 の特別扱い: git apply は old 側開始行 0 の hunk を match_beginning
          // (ファイル先頭への挿入を強制) として扱う。新規ファイル diff は context 行を
          // 持たず lastContextBefore が常に 0 のため、後続 group の挿入 (afterStart > 1)
          // が先頭に化けて内容が壊れる。位置決め自体は new 側 afterStart が担うので、
          // 実際の先頭挿入 (afterStart = 1) 以外は afterStart - 1 を anchor にする。
          beforeStart: lastContextBefore === 0 && afterStart > 1 ? afterStart - 1 : lastContextBefore,
          afterStart,
          beforeLines: [],
          afterLines: [],
        }
      }
      cur.afterLines.push(`+${ch.content}\n`)
      lastClaimedSide = 'after'
      afterCursor = after + 1
      continue
    }
  }
  flush()
  return blocks
}

// `@@ -<beforeStart>,<beforeCount> +<afterStart>,<afterCount> @@\n` + body
function formatHunk(b: Block): string {
  // beforeLines/afterLines には "\ No newline at end of file" マーカー行が混ざるため、
  // ヘッダの行数カウントは実際の -/+ 行だけを数える (マーカーは "\" 始まりで誤判定しない)。
  const beforeCount = b.beforeLines.filter((l) => l.startsWith('-')).length
  const afterCount = b.afterLines.filter((l) => l.startsWith('+')).length
  // pure-addition (beforeCount=0) で beforeStart は anchor 行 (insertion 直前の context 行) を使う
  // unified diff のお作法。git apply --unidiff-zero --recount で吸収される。
  const header = `@@ -${b.beforeStart},${beforeCount} +${b.afterStart},${afterCount} @@\n`
  return header + b.beforeLines.join('') + b.afterLines.join('')
}

// ファイル header (`diff --git a/X b/Y`、rename/mode/new-file header、---/+++)。
//   - carryStructural=true (owner): rename from/to・old/new mode・new file mode を出力する。
//     mode 行は rename 行より前 (git の実出力順)。
//   - carryStructural=false (follower): owner の commit で index は既に newPath / 新 mode に
//     なっているため、`diff --git a/path b/path` + 通常 ---/+++ のみ。oldPath を参照すると
//     「does not exist in index」で apply が落ちるので一切使わない。
// 内容変更がある場合 (hasBody=true) のみ --- / +++ を出力する。
function formatFileHeader(file: AnyFile, opts: { hasBody: boolean; carryStructural: boolean }): string {
  const path = file.pathAfter ?? file.path ?? file.pathBefore ?? ''
  const oldPath = file.pathBefore ?? path
  const headerOldPath = opts.carryStructural ? oldPath : path
  const modeChanged = file.oldMode != null && file.newMode != null && file.oldMode !== file.newMode
  const lines: string[] = []
  lines.push(`diff --git a/${headerOldPath} b/${path}\n`)
  if (opts.carryStructural && modeChanged) {
    lines.push(`old mode ${file.oldMode}\n`)
    lines.push(`new mode ${file.newMode}\n`)
  }
  if (opts.carryStructural && file.type === 'RenamedFile') {
    // similarity index は元の patch から取れないので省略。git apply は無くても通る。
    lines.push(`rename from ${oldPath}\n`)
    lines.push(`rename to ${path}\n`)
  }
  if (opts.carryStructural && file.type === 'AddedFile') {
    lines.push('new file mode 100644\n')
  } else if (file.type === 'DeletedFile') {
    lines.push('deleted file mode 100644\n')
  }
  // hasBody=true なら --- / +++ ヘッダが必要 (hunks の前提)。
  // structural-only (hasBody=false) の場合は省略可。
  if (opts.hasBody) {
    if (opts.carryStructural && file.type === 'AddedFile') {
      lines.push('--- /dev/null\n')
      lines.push(`+++ b/${path}\n`)
    } else if (file.type === 'DeletedFile') {
      lines.push(`--- a/${oldPath}\n`)
      lines.push('+++ /dev/null\n')
    } else {
      lines.push(`--- a/${headerOldPath}\n`)
      lines.push(`+++ b/${path}\n`)
    }
  }
  return lines.join('')
}
