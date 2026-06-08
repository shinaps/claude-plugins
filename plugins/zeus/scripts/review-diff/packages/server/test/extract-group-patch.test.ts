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
