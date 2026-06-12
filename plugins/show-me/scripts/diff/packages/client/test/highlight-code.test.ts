// highlightCode + Shiki decorations の contract:
//   - decorations を渡すと char-add / char-del class の span が Shiki color span と共存する
//   - 不正な decorations (範囲外 offset) でも throw せず decorations なしで再試行する
//   - Shiki の「部分交差 range は throw」は公式未文書のソース挙動なので、
//     ここで直接検知しておき Shiki 更新で挙動が変わったら気付けるようにする

import { describe, test, expect } from 'vitest'
import { highlightCode } from '../src/lib/highlight-code'
import { getShiki } from '../src/lib/shiki-bundle'

describe('highlightCode + decorations', () => {
  test('decorations の range に class 付き span が生え、Shiki color span と共存する', () => {
    const raw = 'const userName = fetchUser(id)'
    const html = highlightCode(raw, 'typescript', [
      { start: 17, end: 22, properties: { class: 'char-add' } },
    ])
    expect(html).toContain('char-add')
    // シンタックスカラー (style="color:...") も維持されている
    expect(html).toMatch(/style="color:#/)
  })

  test('decorations なしの従来呼び出しは挙動が変わらない', () => {
    const raw = 'const x = 1'
    expect(highlightCode(raw, 'typescript')).toBe(highlightCode(raw, 'typescript', []))
  })

  test('範囲外 offset の decorations は throw せず、シンタックスハイライト済み HTML に戻る', () => {
    const raw = 'abc'
    const html = highlightCode(raw, 'typescript', [
      { start: 0, end: raw.length + 5, properties: { class: 'char-add' } },
    ])
    // フォールバックは escapeHtml ではなく decorations なしの Shiki 再試行であること
    expect(html).toContain('abc')
    expect(html).not.toContain('char-add')
    expect(html).toMatch(/<span/)
  })

  test('Shiki 更新検知: 部分交差 range は codeToHtml が throw する (現行 v4 のソース挙動)', () => {
    // highlightCode 経由ではなく Shiki を直接呼ぶ。このテストが落ちたら Shiki の交差制約が
    // 変わったということなので、char-diff.ts の mergeRanges の前提を見直すこと。
    expect(() =>
      getShiki().codeToHtml('abcdefghij', {
        lang: 'typescript',
        theme: 'github-dark',
        decorations: [
          { start: 0, end: 5, properties: { class: 'a' } },
          { start: 3, end: 8, properties: { class: 'b' } },
        ],
      }),
    ).toThrow()
  })
})
