// toUnifiedRows (SideBySideRow[] → unified 行列変換) の contract:
//   - 連続変更チャンク内では deletion 全部 → addition 全部の順で flush (GitHub unified の読み味)
//   - context 行 (または empty のみの行) がチャンク境界
//   - context 行は oldLine / newLine 両方を保持 (コメント anchor の両 side lookup 用)
//   - 両側 empty の行は出力に含めない

import { describe, test, expect } from 'vitest'
import type { SideBySideRow } from '@show-me/diff-shared'
import { toUnifiedRows } from '../src/lib/unified'

const ctx = (oldLine: number, newLine: number, raw: string): SideBySideRow => ({
  asIs: { type: 'context', line: oldLine, raw },
  toBe: { type: 'context', line: newLine, raw },
})
const change = (oldLine: number, newLine: number, delRaw: string, addRaw: string): SideBySideRow => ({
  asIs: { type: 'deletion', line: oldLine, raw: delRaw },
  toBe: { type: 'addition', line: newLine, raw: addRaw },
})
const delOnly = (oldLine: number, raw: string): SideBySideRow => ({
  asIs: { type: 'deletion', line: oldLine, raw },
  toBe: { type: 'empty', raw: '' },
})
const addOnly = (newLine: number, raw: string): SideBySideRow => ({
  asIs: { type: 'empty', raw: '' },
  toBe: { type: 'addition', line: newLine, raw },
})

describe('toUnifiedRows', () => {
  test('del+add のペア行チャンクは deletion 群 → addition 群に並べ替える', () => {
    const rows = [
      ctx(1, 1, 'a'),
      change(2, 2, 'old1', 'new1'),
      change(3, 3, 'old2', 'new2'),
      ctx(4, 4, 'b'),
    ]
    expect(toUnifiedRows(rows)).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, raw: 'a' },
      { kind: 'deletion', oldLine: 2, raw: 'old1' },
      { kind: 'deletion', oldLine: 3, raw: 'old2' },
      { kind: 'addition', newLine: 2, raw: 'new1' },
      { kind: 'addition', newLine: 3, raw: 'new2' },
      { kind: 'context', oldLine: 4, newLine: 4, raw: 'b' },
    ])
  })

  test('deletion-only / addition-only チャンクはそのままの順で出る', () => {
    expect(toUnifiedRows([delOnly(5, 'gone'), delOnly(6, 'gone2')])).toEqual([
      { kind: 'deletion', oldLine: 5, raw: 'gone' },
      { kind: 'deletion', oldLine: 6, raw: 'gone2' },
    ])
    expect(toUnifiedRows([addOnly(7, 'born'), addOnly(8, 'born2')])).toEqual([
      { kind: 'addition', newLine: 7, raw: 'born' },
      { kind: 'addition', newLine: 8, raw: 'born2' },
    ])
  })

  test('context がチャンク境界になり、チャンクごとに独立して並べ替えられる', () => {
    const rows = [
      change(1, 1, 'o1', 'n1'),
      ctx(2, 2, 'mid'),
      change(3, 3, 'o2', 'n2'),
      addOnly(4, 'n3'),
    ]
    expect(toUnifiedRows(rows)).toEqual([
      { kind: 'deletion', oldLine: 1, raw: 'o1' },
      { kind: 'addition', newLine: 1, raw: 'n1' },
      { kind: 'context', oldLine: 2, newLine: 2, raw: 'mid' },
      { kind: 'deletion', oldLine: 3, raw: 'o2' },
      { kind: 'addition', newLine: 3, raw: 'n2' },
      { kind: 'addition', newLine: 4, raw: 'n3' },
    ])
  })

  test('両側 empty の行は出力されない', () => {
    const rows: SideBySideRow[] = [
      ctx(1, 1, 'a'),
      { asIs: { type: 'empty', raw: '' }, toBe: { type: 'empty', raw: '' } },
      ctx(2, 2, 'b'),
    ]
    expect(toUnifiedRows(rows)).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, raw: 'a' },
      { kind: 'context', oldLine: 2, newLine: 2, raw: 'b' },
    ])
  })

  test('片側 panel (asIs のみ context) でも 1 行として出る', () => {
    const rows: SideBySideRow[] = [
      { asIs: { type: 'context', line: 10, raw: 'only-old' }, toBe: { type: 'empty', raw: '' } },
    ]
    expect(toUnifiedRows(rows)).toEqual([
      { kind: 'context', oldLine: 10, raw: 'only-old' },
    ])
  })
})
