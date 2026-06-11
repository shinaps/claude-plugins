// panel-renderer: AC-11 必須 5 ケース + ranges 不一致 + cross-file 異言語の計 7 ケース。

import { test, expect } from 'vitest'
import { renderPanel, type SourcesMap } from '@show-me/diff-server'
import type { Panel } from '@show-me/diff-shared'

function srcMap(entries: Array<[string, { before?: string; after?: string }]>): SourcesMap {
  const m: SourcesMap = new Map()
  for (const [file, src] of entries) {
    m.set(file, { before: src.before ?? '', after: src.after ?? '' })
  }
  return m
}

test('1. pure-addition (asIs 不在): rows all have asIs.type=empty / toBe.type=addition', () => {
  const sources = srcMap([['new.ts', { after: 'a\nb\nc' }]])
  const panel: Panel = {
    panelId: 'p1', intent: 'add',
    toBe: { file: 'new.ts', ranges: [{ start: 1, end: 3 }] },
  }
  const r = renderPanel(panel, sources)
  expect(r.segments.length).toBe(1)
  const rows = r.segments[0].rows
  expect(rows.length).toBe(3)
  for (const row of rows) {
    expect(row.asIs.type).toBe('empty')
    expect(row.toBe.type).toBe('addition')
  }
  expect(r.toBeLanguage).toBe('typescript')
  expect(r.asIsLanguage).toBeUndefined()
})

test('2. pure-deletion (toBe 不在): rows all have asIs.type=deletion / toBe.type=empty', () => {
  const sources = srcMap([['gone.ts', { before: 'a\nb\nc' }]])
  const panel: Panel = {
    panelId: 'p2', intent: 'delete',
    asIs: { file: 'gone.ts', ranges: [{ start: 1, end: 3 }] },
  }
  const r = renderPanel(panel, sources)
  const rows = r.segments[0].rows
  expect(rows.length).toBe(3)
  for (const row of rows) {
    expect(row.asIs.type).toBe('deletion')
    expect(row.toBe.type).toBe('empty')
  }
})

test('3. cross-file same-language: asIsLanguage/toBeLanguage 両方 ts', () => {
  const sources = srcMap([
    ['a.ts', { before: 'function foo() { return 1 }' }],
    ['b.ts', { after: 'function foo() { return 1 }' }],
  ])
  const panel: Panel = {
    panelId: 'p3', intent: 'move',
    asIs: { file: 'a.ts', ranges: [{ start: 1, end: 1 }] },
    toBe: { file: 'b.ts', ranges: [{ start: 1, end: 1 }] },
  }
  const r = renderPanel(panel, sources)
  expect(r.asIsLanguage).toBe('typescript')
  expect(r.toBeLanguage).toBe('typescript')
  // 内容が等しいので 1 context row
  expect(r.segments[0].rows.length).toBe(1)
  expect(r.segments[0].rows[0].asIs.type).toBe('context')
  expect(r.segments[0].rows[0].toBe.type).toBe('context')
})

test('4. multiple ranges (asIs=2, toBe=2): 2 segments, index ペアリング', () => {
  const sources = srcMap([
    ['a.ts', { before: 'l1\nl2\nl3\nl4\nl5\nl6', after: 'l1\nx\nl3\nl4\ny\nl6' }],
  ])
  const panel: Panel = {
    panelId: 'p4', intent: 'two-spots',
    asIs: { file: 'a.ts', ranges: [{ start: 2, end: 2 }, { start: 5, end: 5 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 2, end: 2 }, { start: 5, end: 5 }] },
  }
  const r = renderPanel(panel, sources)
  expect(r.segments.length).toBe(2)
  expect(r.segments[0].asIsRange).toEqual({ start: 2, end: 2 })
  expect(r.segments[1].asIsRange).toEqual({ start: 5, end: 5 })
})

test('5. context-only (asIs/toBe identical → 全 row context)', () => {
  const sources = srcMap([
    ['a.ts', { before: 'a\nb\nc', after: 'a\nb\nc' }],
  ])
  const panel: Panel = {
    panelId: 'p5', intent: 'show context',
    asIs: { file: 'a.ts', ranges: [{ start: 1, end: 3 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 1, end: 3 }] },
  }
  const r = renderPanel(panel, sources)
  for (const row of r.segments[0].rows) {
    expect(row.asIs.type).toBe('context')
    expect(row.toBe.type).toBe('context')
  }
})

test('6. ranges 不一致 (asIs=3, toBe=2): segments 3 件、最後の segment は toBe 側 empty', () => {
  const sources = srcMap([
    ['a.ts', { before: 'aa\nbb\ncc\ndd\nee', after: 'aa\ncc' }],
  ])
  const panel: Panel = {
    panelId: 'p6', intent: 'asym',
    asIs: {
      file: 'a.ts',
      ranges: [{ start: 1, end: 1 }, { start: 3, end: 3 }, { start: 5, end: 5 }],
    },
    toBe: {
      file: 'a.ts',
      ranges: [{ start: 1, end: 1 }, { start: 2, end: 2 }],
    },
  }
  const r = renderPanel(panel, sources)
  expect(r.segments.length).toBe(3)
  // 最後の segment は toBeRange 未指定
  expect(r.segments[2].toBeRange).toBeUndefined()
  // 最後 segment の全 row は toBe 側 empty
  for (const row of r.segments[2].rows) {
    expect(row.toBe.type).toBe('empty')
  }
})

test('7. cross-file different-language: asIsLanguage=javascript, toBeLanguage=typescript', () => {
  const sources = srcMap([
    ['a.js', { before: 'function foo() { return 1 }' }],
    ['a.ts', { after: 'function foo(): number { return 1 }' }],
  ])
  const panel: Panel = {
    panelId: 'p7', intent: 'js→ts',
    asIs: { file: 'a.js', ranges: [{ start: 1, end: 1 }] },
    toBe: { file: 'a.ts', ranges: [{ start: 1, end: 1 }] },
  }
  const r = renderPanel(panel, sources)
  expect(r.asIsLanguage).toBe('javascript')
  expect(r.toBeLanguage).toBe('typescript')
})
