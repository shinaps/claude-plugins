// extractGroupPatch のテスト。
// 検証軸:
//   - 単一 group の panel が claim する変更行のみ抽出
//   - 1 hunk 内に複数 group の変更行がある場合、他 group の行は出力に含めない
//   - rename + 内容変更で rename header 維持
//   - 空 patch (= group が変更行を claim しない context-only) → 空文字列

import { test, expect } from 'vitest'
import { extractGroupPatch } from '@zeus/review-diff-server'
import type { SummaryJson } from '@zeus/review-diff-shared'

// helper: 最小 SummaryJson を組み立てる
function makeSummary(groups: SummaryJson['groups']): SummaryJson {
  return {
    schemaVersion: 1,
    mode: 'staged',
    pr: null,
    overallSummary: '',
    groups,
  }
}

const SIMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,6 @@
 export function foo() {
-  return 1
+  return 2
+  // changed
 }

 export const x = 0
`

test('1. 単一 group / 単一 panel: 変更行のみ抽出 (--unidiff-zero)', () => {
  // この diff の変更行は asIs line 2 (deletion) / toBe line 2-3 (addition)
  const summary = makeSummary([
    {
      title: 'g0',
      description: '',
      panels: [
        {
          panelId: 'p1',
          intent: 'change return',
          asIs: { file: 'src/foo.ts', ranges: [{ start: 2, end: 2 }] },
          toBe: { file: 'src/foo.ts', ranges: [{ start: 2, end: 3 }] },
        },
      ],
    },
  ])
  const r = extractGroupPatch({ summary, diffText: SIMPLE_DIFF, groupId: 'g0' })
  expect(r.ok).toBe(true)
  expect(r.patch).toContain('diff --git a/src/foo.ts b/src/foo.ts')
  expect(r.patch).toContain('--- a/src/foo.ts')
  expect(r.patch).toContain('+++ b/src/foo.ts')
  expect(r.patch).toContain('-  return 1')
  expect(r.patch).toContain('+  return 2')
  expect(r.patch).toContain('+  // changed')
  // unified-zero: context 行は含まない
  expect(r.patch).not.toContain(' export function foo()')
  expect(r.patch).not.toContain(' export const x = 0')
})

test('2. 1 hunk 内に複数 group の変更行 → 他 group の行は出力に含まれない', () => {
  // g0 は asIs:2 (return 1 → return 2) のみ claim
  // g1 は toBe:3 (// changed 追加) のみ claim
  const summary = makeSummary([
    {
      title: 'g0',
      description: '',
      panels: [
        {
          panelId: 'p1',
          intent: 'change return',
          asIs: { file: 'src/foo.ts', ranges: [{ start: 2, end: 2 }] },
          toBe: { file: 'src/foo.ts', ranges: [{ start: 2, end: 2 }] },
        },
      ],
    },
    {
      title: 'g1',
      description: '',
      panels: [
        {
          panelId: 'p2',
          intent: 'add comment',
          toBe: { file: 'src/foo.ts', ranges: [{ start: 3, end: 3 }] },
        },
      ],
    },
  ])
  // g0 を抽出: line 2 deletion + line 2 addition のみ
  const r0 = extractGroupPatch({ summary, diffText: SIMPLE_DIFF, groupId: 'g0' })
  expect(r0.ok).toBe(true)
  expect(r0.patch).toContain('-  return 1')
  expect(r0.patch).toContain('+  return 2')
  expect(r0.patch).not.toContain('+  // changed') // g1 の変更行は含まない

  // g1 を抽出: line 3 addition のみ
  const r1 = extractGroupPatch({ summary, diffText: SIMPLE_DIFF, groupId: 'g1' })
  expect(r1.ok).toBe(true)
  expect(r1.patch).toContain('+  // changed')
  expect(r1.patch).not.toContain('-  return 1')
  expect(r1.patch).not.toContain('+  return 2')
})

test('3. rename + 内容変更 → rename header 維持', () => {
  const RENAME_DIFF = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 90%
rename from src/old-name.ts
rename to src/new-name.ts
index 1111111..2222222 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,3 +1,3 @@
 export function hello() {
-  return 'hi'
+  return 'hello'
 }
`
  const summary = makeSummary([
    {
      title: 'g0',
      description: '',
      panels: [
        {
          panelId: 'p1',
          intent: 'rename + content',
          asIs: { file: 'src/old-name.ts', ranges: [{ start: 2, end: 2 }] },
          toBe: { file: 'src/new-name.ts', ranges: [{ start: 2, end: 2 }] },
        },
      ],
    },
  ])
  const r = extractGroupPatch({ summary, diffText: RENAME_DIFF, groupId: 'g0' })
  expect(r.ok).toBe(true)
  expect(r.patch).toContain('rename from src/old-name.ts')
  expect(r.patch).toContain('rename to src/new-name.ts')
  expect(r.patch).toContain('--- a/src/old-name.ts')
  expect(r.patch).toContain('+++ b/src/new-name.ts')
  expect(r.patch).toContain("-  return 'hi'")
  expect(r.patch).toContain("+  return 'hello'")
})

test('4. 空 patch (group が変更行を claim しない、context-only) → 空文字列', () => {
  // g0 は line 5 (= context 行) のみ claim、変更行 (2-3) は touch しない
  const summary = makeSummary([
    {
      title: 'g0',
      description: '',
      panels: [
        {
          panelId: 'p1',
          intent: 'context only',
          asIs: { file: 'src/foo.ts', ranges: [{ start: 5, end: 5 }] },
          toBe: { file: 'src/foo.ts', ranges: [{ start: 6, end: 6 }] },
        },
      ],
    },
  ])
  const r = extractGroupPatch({ summary, diffText: SIMPLE_DIFF, groupId: 'g0' })
  expect(r.ok).toBe(true)
  expect(r.patch).toBe('')
})

// === 座標系 (afterOffset) のヘッダ検証 ==========================================
// linear-stack commit では group gN の patch は「HEAD + 先行 group コミット済み」の index に
// 適用されるため、new 側ヘッダは committed-prefix 座標でなければならない。
// ヘッダ行全体を厳密比較する: new 側 (+B) の補正だけでなく、old 側 (-A) を
// 誤って補正してしまう改変も検出するため。

// base 30 行 (L1..L30)。
//   上方: L10 の後に A1..A5 を追加 (toBe 11-15)
//   下方: L20 の後に B1..B3 を追加 (toBe 26-28)
const TWO_HUNK_DIFF = `diff --git a/src/two.ts b/src/two.ts
index 1111111..2222222 100644
--- a/src/two.ts
+++ b/src/two.ts
@@ -8,6 +8,11 @@
 L8
 L9
 L10
+A1
+A2
+A3
+A4
+A5
 L11
 L12
 L13
@@ -18,6 +23,9 @@
 L18
 L19
 L20
+B1
+B2
+B3
 L21
 L22
 L23
`

function hunkHeaders(patch: string): string[] {
  return patch.split('\n').filter(l => l.startsWith('@@'))
}

test('U1. 後続 group の上方追加ぶん、自 group の下方 hunk の +B が補正される (incident 再現)', () => {
  // g0 (先頭コミット) = 下方 B 行、g1 (後続) = 上方 A 行。
  // g0 適用時は HEAD のままなので B1 は L20 直後 = 新 21 行目。
  // full-diff 座標 (+26) のままだと 5 行下に無音誤挿入される (v5.5.0 incident の構造)。
  const summary = makeSummary([
    {
      title: 'g0',
      description: '',
      panels: [
        { panelId: 'p1', intent: 'add B', toBe: { file: 'src/two.ts', ranges: [{ start: 26, end: 28 }] } },
      ],
    },
    {
      title: 'g1',
      description: '',
      panels: [
        { panelId: 'p2', intent: 'add A', toBe: { file: 'src/two.ts', ranges: [{ start: 11, end: 15 }] } },
      ],
    },
  ])
  const r = extractGroupPatch({ summary, diffText: TWO_HUNK_DIFF, groupId: 'g0' })
  expect(r.ok).toBe(true)
  expect(hunkHeaders(r.patch)).toEqual(['@@ -20,0 +21,3 @@'])
})

test('U2. 先行 group の上方追加は補正しない (+B は full-diff 座標のまま) — own-delta 退行ガード', () => {
  // g0 (先行) = 上方 A 行、g1 (後続) = 下方 B 行。
  // g1 適用時は g0 コミット済みなので A1..A5 は index に存在し、lineAfter (26) が既に正しい。
  // 「自 group の行だけで afterStart を再計算する」(own-delta) 方式に書き換えると
  // ここが +21 になり g1 が 5 行上に壊れる。このアサートはその退行を固定するゲート。
  const summary = makeSummary([
    {
      title: 'g0',
      description: '',
      panels: [
        { panelId: 'p1', intent: 'add A', toBe: { file: 'src/two.ts', ranges: [{ start: 11, end: 15 }] } },
      ],
    },
    {
      title: 'g1',
      description: '',
      panels: [
        { panelId: 'p2', intent: 'add B', toBe: { file: 'src/two.ts', ranges: [{ start: 26, end: 28 }] } },
      ],
    },
  ])
  const r = extractGroupPatch({ summary, diffText: TWO_HUNK_DIFF, groupId: 'g1' })
  expect(r.ok).toBe(true)
  expect(hunkHeaders(r.patch)).toEqual(['@@ -20,0 +26,3 @@'])
})

test('U3. 後続 group の上方削除ぶん、自 group の下方 hunk の +B が +1 補正される', () => {
  // base 30 行。L10 を削除 (g1, 後続)、L20 の後に B1 追加 (g0, 先頭)。
  // g0 適用時は HEAD のまま (L10 はまだ残っている) ので B1 = 新 21 行目。
  // full-diff の lineAfter (20) のままだと 1 行上にずれる。
  const DEL_DIFF = `diff --git a/src/del.ts b/src/del.ts
index 1111111..2222222 100644
--- a/src/del.ts
+++ b/src/del.ts
@@ -8,6 +8,5 @@
 L8
 L9
-L10
 L11
 L12
 L13
@@ -18,6 +17,7 @@
 L18
 L19
 L20
+B1
 L21
 L22
 L23
`
  const summary = makeSummary([
    {
      title: 'g0',
      description: '',
      panels: [
        { panelId: 'p1', intent: 'add B', toBe: { file: 'src/del.ts', ranges: [{ start: 20, end: 20 }] } },
      ],
    },
    {
      title: 'g1',
      description: '',
      panels: [
        { panelId: 'p2', intent: 'del L10', asIs: { file: 'src/del.ts', ranges: [{ start: 10, end: 10 }] } },
      ],
    },
  ])
  const r = extractGroupPatch({ summary, diffText: DEL_DIFF, groupId: 'g0' })
  expect(r.ok).toBe(true)
  expect(hunkHeaders(r.patch)).toEqual(['@@ -20,0 +21,1 @@'])
})

test('U4. 同一 hunk 内の後続 group 行も自 group の後続 block の +B に効く', () => {
  // base: L1..L5。final: L1 X1 X2 L2 Y1 L3 L4 L5。
  // g0 = Y1 (toBe 5)、g1 = X1 X2 (toBe 2-3)。
  // g0 適用時は X が無いので Y1 = 新 3 行目 (L1 L2 Y1)。
  const ONE_HUNK_DIFF = `diff --git a/src/one.ts b/src/one.ts
index 1111111..2222222 100644
--- a/src/one.ts
+++ b/src/one.ts
@@ -1,5 +1,8 @@
 L1
+X1
+X2
 L2
+Y1
 L3
 L4
 L5
`
  const summary = makeSummary([
    {
      title: 'g0',
      description: '',
      panels: [
        { panelId: 'p1', intent: 'add Y', toBe: { file: 'src/one.ts', ranges: [{ start: 5, end: 5 }] } },
      ],
    },
    {
      title: 'g1',
      description: '',
      panels: [
        { panelId: 'p2', intent: 'add X', toBe: { file: 'src/one.ts', ranges: [{ start: 2, end: 3 }] } },
      ],
    },
  ])
  const r = extractGroupPatch({ summary, diffText: ONE_HUNK_DIFF, groupId: 'g0' })
  expect(r.ok).toBe(true)
  expect(hunkHeaders(r.patch)).toEqual(['@@ -2,0 +3,1 @@'])
})

test('5. 不正な groupId → error', () => {
  const summary = makeSummary([])
  const r = extractGroupPatch({ summary, diffText: SIMPLE_DIFF, groupId: 'invalid' })
  expect(r.ok).toBe(false)
  expect(r.error).toContain('invalid groupId format')
})

test('6. 存在しない group index → error', () => {
  const summary = makeSummary([])
  const r = extractGroupPatch({ summary, diffText: SIMPLE_DIFF, groupId: 'g5' })
  expect(r.ok).toBe(false)
  expect(r.error).toContain('group not found')
})
