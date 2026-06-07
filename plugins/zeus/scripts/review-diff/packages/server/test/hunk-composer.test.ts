import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { composeHunks, parseDiff, type FileSource } from '@zeus/review-diff-server'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = (name: string) => resolve(__dirname, 'fixtures', name)

// 後段テストで使う「after / before の原文」を組み立てるヘルパ。
// composeHunks は source.after を行リストとして必要なので、十分な行数を用意する。
function makeLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join('\n')
}

// Case 1: pure-deletion を含む diff でも composeHunks が timeout せず返る (Critical #1 回帰防止)。
// fast-path 経路 (displayRanges 空 + bridgeable gap 無し) では元の file を参照同一で返す。
test('pure-deletion fast-path returns file as-is without infinite loop', () => {
  const diff = readFileSync(fixturePath('pure-deletion.diff'), 'utf8')
  const files = parseDiff(diff)
  const file = files[0]
  const source: FileSource = {
    before: makeLines('before', 20),
    after: makeLines('after', 20),
  }
  // pure-deletion (newLines === 0) と changed hunk (newStart=7, newLines=4) しかない。
  // positive hunks は 1 件なので bridgeable gap 無し → fast-path に乗る。
  const start = Date.now()
  const result = composeHunks({ file, source, autoBridgeThreshold: 10 })
  const elapsed = Date.now() - start
  expect(elapsed).toBeLessThan(2000)
  expect(result).toBe(file)
})

// Case 2: pure-deletion + AI 指定 range で、pure-deletion (range 外) が表示されないこと。
// 採用案 A: range 外の pure-deletion は表示外。
test('pure-deletion outside AI range is not rendered', () => {
  const diff = readFileSync(fixturePath('pure-deletion.diff'), 'utf8')
  const file = parseDiff(diff)[0]
  const source: FileSource = {
    before: makeLines('before', 20),
    after: makeLines('after', 20),
  }
  // 後続 changed hunk (newStart=7, newLines=4) のみを意識した range。
  // pure-deletion hunk は newStart=3 にあり range 外。
  const result = composeHunks({
    file,
    source,
    displayRanges: [{ start: 7, end: 10 }],
    autoBridgeThreshold: 0,
  })
  // pure-deletion の rows は左=deletion / 右=empty。merged 範囲内に紛れ込んでいないか確認。
  const allRows = result.hunks.flatMap((h) => h.rows)
  const hasPureDeletionRow = allRows.some(
    (r) => r.left.type === 'deletion' && r.left.raw.startsWith('// removed mid'),
  )
  expect(hasPureDeletionRow).toBe(false)
  // changed hunk 由来の addition は表示されていること (sanity)。
  expect(allRows.some((r) => r.right.type === 'addition')).toBe(true)
})

// Case 3: ai-context only range の left 行番号 / oldStart が cumulativeDelta で正しく
// after → before mapping される (Critical #2 治癒)。
test('ai-context-only range maps left line via cumulativeDelta', () => {
  // simple.diff: @@ -1,5 +1,6 @@ — newStart=1, newLines=6, oldStart=1, oldLines=5 → delta=+1
  const diff = readFileSync(fixturePath('simple.diff'), 'utf8')
  const file = parseDiff(diff)[0]
  const afterLines = makeLines('A', 30)
  const beforeLines = makeLines('B', 29)
  const source: FileSource = { before: beforeLines, after: afterLines }
  // changed hunk と被らない後方 range。
  // cumulativeDeltaAt(file.hunks, 15) は changed hunk (newStart=1, newLines=6, oldLines=5) が
  // 完全に afterLine=15 より前なので acc += (6 - 5) = 1。
  const result = composeHunks({
    file,
    source,
    displayRanges: [{ start: 15, end: 17 }],
    autoBridgeThreshold: 0,
  })
  // 該当 hunk: changed と被らない ai-context のみ。
  const aiHunk = result.hunks.find((h) => h.origin === 'ai-context')
  expect(aiHunk).toBeDefined()
  // delta=+1 → before 行 = after 行 - 1
  expect(aiHunk!.oldStart).toBe(14) // 15 - 1
  // 1 行目の left.line も同様。
  expect(aiHunk!.rows[0].left.line).toBe(14)
  // oldLines = (17 - 1) - (15 - 1) + 1 = 3
  expect(aiHunk!.oldLines).toBe(3)
})

// Case 4: addition-only changed hunk の oldStart / oldLines (A1 治癒)。
// fixture: @@ -5,0 +6,3 @@ — newStart=6, newLines=3, oldStart=5, oldLines=0.
// 進入時の cumulativeDelta は 0 (この hunk 自体は newStart+newLines=9 > 6 なので除外)。
// よって oldStart = 6 - 0 = 6, oldEnd = 8 - cumulativeDeltaAt(file.hunks, 9)。
// 当該 hunk は newStart+newLines=9 <= 9 で acc に積まれる → delta = (3-0) = 3。
// oldEnd = 8 - 3 = 5。oldLines = max(0, 5 - 6 + 1) = 0。
test('addition-only hunk: oldStart and oldLines via cumulativeDelta', () => {
  const diff = readFileSync(fixturePath('addition-only.diff'), 'utf8')
  const file = parseDiff(diff)[0]
  const source: FileSource = {
    before: makeLines('B', 20),
    after: makeLines('A', 23),
  }
  // displayRanges を changed と重ねて指定 → 非 fast-path 経路を踏む。
  const result = composeHunks({
    file,
    source,
    displayRanges: [{ start: 6, end: 8 }],
    autoBridgeThreshold: 0,
  })
  expect(result.hunks.length).toBe(1)
  const h = result.hunks[0]
  expect(h.newStart).toBe(6)
  expect(h.newLines).toBe(3)
  expect(h.oldStart).toBe(6)
  expect(h.oldLines).toBe(0)
})

// Case 5: fast-path 回帰 — displayRanges 空 + bridgeable gap 無しで元 file 参照を返す。
test('fast-path returns original file by reference', () => {
  const diff = readFileSync(fixturePath('simple.diff'), 'utf8')
  const file = parseDiff(diff)[0]
  const source: FileSource = {
    before: makeLines('B', 20),
    after: makeLines('A', 20),
  }
  const result = composeHunks({ file, source, autoBridgeThreshold: 10 })
  expect(result).toBe(file)
})

// Case 6: 非 fast-path で pure-deletion の newStart を含む displayRange を投げても
// 無限ループしない (C1 の真の回帰防止 — fast-path を踏まない経路で確認)。
test('pure-deletion newStart inside AI range does not infinite loop', () => {
  const diff = readFileSync(fixturePath('pure-deletion.diff'), 'utf8')
  const file = parseDiff(diff)[0]
  const source: FileSource = {
    before: makeLines('before', 20),
    after: makeLines('after', 20),
  }
  const start = Date.now()
  const result = composeHunks({
    file,
    source,
    // pure-deletion は newStart=3。range にこれを含めても無限ループしないこと。
    displayRanges: [{ start: 3, end: 10 }],
    autoBridgeThreshold: 0,
  })
  const elapsed = Date.now() - start
  expect(elapsed).toBeLessThan(2000)
  // 非 fast-path 経路を踏んでいる (= 元 file と別オブジェクト)。
  expect(result).not.toBe(file)
  // pure-deletion は採用案 A で表示外。
  const hasPureDeletionRow = result.hunks
    .flatMap((h) => h.rows)
    .some((r) => r.left.type === 'deletion' && r.left.raw.startsWith('// removed mid'))
  expect(hasPureDeletionRow).toBe(false)
})

// Case 7: addition-only hunk の後ろに context 行が続くケースで leftDelta が正しく更新される。
// reviewer 指摘 Critical: 旧実装は rows 逆引きで lastLeft が null になり leftDelta が
// 更新されず、後続 context 行の left.line が誤値になっていた。
// cumulativeDeltaAt ベース更新で治癒したことを確認する。
test('left line number stays correct after addition-only hunk', () => {
  // fixture の addition-only: newStart=6, newLines=3, oldStart=5, oldLines=0
  // → hunk 通過後 (cur=9) の delta は +3 (after は before より 3 行多い)
  const diff = readFileSync(fixturePath('addition-only.diff'), 'utf8')
  const file = parseDiff(diff)[0]
  const source: FileSource = {
    before: makeLines('B', 20),
    after: makeLines('A', 23),
  }
  // hunk + 後続 context 2 行まで range を伸ばす。
  const result = composeHunks({
    file,
    source,
    displayRanges: [{ start: 6, end: 10 }],
    autoBridgeThreshold: 0,
  })
  const h = result.hunks[0]
  // rows 末尾 2 行は cur=9, 10 の context 行。leftDelta=+3 なので left.line = 6, 7。
  // 旧実装では leftDelta が 0 のまま (lastLeft=null で未更新) で left.line = 9, 10 だった。
  const contextTail = h.rows.slice(-2)
  expect(contextTail[0].right.line).toBe(9)
  expect(contextTail[0].left.line).toBe(6)
  expect(contextTail[1].right.line).toBe(10)
  expect(contextTail[1].left.line).toBe(7)
})
