// summary-schema.ts: zod 検証 + legacy 検出 + panelId 補完 + 重複 suffix の 8 ケース。

import { test, expect } from 'vitest'
import { validateSummarySchema, SchemaError } from '@zeus/review-diff-server'

const validBase = {
  schemaVersion: 1 as const,
  mode: 'staged' as const,
  pr: null,
  overallSummary: 'test',
  groups: [
    {
      title: 'g1',
      description: '',
      panels: [
        {
          panelId: 'mypanel',
          intent: 'change foo',
          asIs: { file: 'a.ts', ranges: [{ start: 1, end: 5 }] },
          toBe: { file: 'a.ts', ranges: [{ start: 1, end: 7 }] },
        },
      ],
    },
  ],
}

test('1. valid schema passes and returns summary', () => {
  const { summary } = validateSummarySchema(validBase)
  expect(summary.groups[0].panels[0].panelId).toBe('mypanel')
  expect(summary.mode).toBe('staged')
})

test('2. legacy schema (groups[].files) is rejected with migration message', () => {
  const legacy = {
    mode: 'staged',
    pr: null,
    overallSummary: '',
    groups: [
      { title: 'g', description: '', files: ['a.ts'] },
    ],
  }
  expect(() => validateSummarySchema(legacy)).toThrowError(SchemaError)
  try {
    validateSummarySchema(legacy)
  } catch (e) {
    expect((e as Error).message).toContain('legacy')
    expect((e as Error).message).toContain('SKILL.md Phase 4')
  }
})

test('3. missing schemaVersion → zod fails', () => {
  const noVer = { ...validBase } as { schemaVersion?: 1 }
  delete noVer.schemaVersion
  expect(() => validateSummarySchema(noVer)).toThrowError(SchemaError)
})

test('4. empty panel.intent → zod fails', () => {
  const bad = JSON.parse(JSON.stringify(validBase))
  bad.groups[0].panels[0].intent = ''
  expect(() => validateSummarySchema(bad)).toThrowError(SchemaError)
})

test('5. panel without asIs and toBe → refine fails', () => {
  const bad = JSON.parse(JSON.stringify(validBase))
  delete bad.groups[0].panels[0].asIs
  delete bad.groups[0].panels[0].toBe
  expect(() => validateSummarySchema(bad)).toThrowError(SchemaError)
})

test('6. empty ranges array → zod fails', () => {
  const bad = JSON.parse(JSON.stringify(validBase))
  bad.groups[0].panels[0].asIs.ranges = []
  expect(() => validateSummarySchema(bad)).toThrowError(SchemaError)
})

test('7. duplicate panelId gets numeric suffix instead of failing', () => {
  const dup = JSON.parse(JSON.stringify(validBase))
  // 同 ID を 3 つ並べる
  dup.groups[0].panels = [
    { panelId: 'shared', intent: 'a', toBe: { file: 'a.ts', ranges: [{ start: 1, end: 1 }] } },
    { panelId: 'shared', intent: 'b', toBe: { file: 'b.ts', ranges: [{ start: 1, end: 1 }] } },
    { panelId: 'shared', intent: 'c', toBe: { file: 'c.ts', ranges: [{ start: 1, end: 1 }] } },
  ]
  const { summary } = validateSummarySchema(dup)
  expect(summary.groups[0].panels.map(p => p.panelId)).toEqual(['shared', 'shared-1', 'shared-2'])
})

test('8. empty panelId is auto-generated as p-<hash>; intent差異は同一 asIs/toBe で同一 ID', () => {
  // intent を除外した hash 設計の検証: 同 asIs/toBe で intent だけ違う 2 panel は
  // sanitized 時点で衝突するため、suffix が付与される (= 自動生成された ID が等しい)。
  const input = JSON.parse(JSON.stringify(validBase))
  input.groups[0].panels = [
    { panelId: '', intent: 'first description', toBe: { file: 'x.ts', ranges: [{ start: 1, end: 1 }] } },
    { panelId: '', intent: 'second description', toBe: { file: 'x.ts', ranges: [{ start: 1, end: 1 }] } },
  ]
  const { summary } = validateSummarySchema(input)
  const ids = summary.groups[0].panels.map(p => p.panelId)
  expect(ids[0]).toMatch(/^p-[a-f0-9]{10}$/)
  // 2 つ目は同じ hash + suffix
  expect(ids[1]).toBe(`${ids[0]}-1`)
})
