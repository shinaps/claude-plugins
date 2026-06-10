// nav resizer の幅計算 (clamp + 整数 px 化) の characterization test。
// pointer capture + rAF を伴う drag 全体は happy-dom で再現できないため、
// 純粋関数に切り出した境界条件だけをここで固定する。

import { describe, expect, it } from 'vitest'
import { clampNavWidth } from '../src/guide/useNavResizer'

describe('clampNavWidth', () => {
  it('範囲内の値はそのまま返す', () => {
    expect(clampNavWidth(240)).toBe(240)
    expect(clampNavWidth(360)).toBe(360)
    expect(clampNavWidth(480)).toBe(480)
  })

  it('下限 240px 未満は 240 に clamp する', () => {
    expect(clampNavWidth(239)).toBe(240)
    expect(clampNavWidth(0)).toBe(240)
    expect(clampNavWidth(-100)).toBe(240)
  })

  it('上限 480px 超は 480 に clamp する', () => {
    expect(clampNavWidth(481)).toBe(480)
    expect(clampNavWidth(10000)).toBe(480)
  })

  it('小数は整数 px に丸める (同値 skip 判定を px 単位にするため)', () => {
    expect(clampNavWidth(300.4)).toBe(300)
    expect(clampNavWidth(300.5)).toBe(301)
  })

  it('境界ぎりぎりの小数も clamp 後に丸める', () => {
    expect(clampNavWidth(239.6)).toBe(240)
    expect(clampNavWidth(480.4)).toBe(480)
  })
})
