// escapeJsonForScript の characterization test。
//
// contract:
//   - 出力に生の `<` が 1 文字も残らない (script data double escaped state の入口である
//     `<!--` / `<script` / 終端の `</script>` をまとめて封じる)
//   - エスケープは JSON 文字列リテラル内の文字表現を変えるだけで、JSON.parse の結果は不変
//   - U+2028 / U+2029 は \u エスケープに置換される
import { describe, expect, test } from 'vitest'
import { escapeJsonForScript } from '../src/template.js'

describe('escapeJsonForScript', () => {
  test('出力に生の `<` が残らない', () => {
    const json = JSON.stringify({ x: '<!--<script>alert(1)</script>-->' })
    const out = escapeJsonForScript(json)
    expect(out).not.toContain('<')
  })

  test('`</script>` 文字列が出力に現れない (要素早期終了の回帰テスト)', () => {
    const json = JSON.stringify({ code: 'foo</script><script>bar' })
    const out = escapeJsonForScript(json)
    expect(out.toLowerCase()).not.toContain('</script')
    expect(out.toLowerCase()).not.toContain('<script')
  })

  test('JSON.parse で round-trip しても原文が変わらない', () => {
    const payload = {
      html: '<!--<script>while(1){}</script>-->',
      plain: 'a < b && c > d',
      ls: 'line sep',
      ps: 'para sep',
    }
    const out = escapeJsonForScript(JSON.stringify(payload))
    expect(JSON.parse(out)).toEqual(payload)
  })

  test('U+2028 / U+2029 が生のまま出力に残らない', () => {
    const json = JSON.stringify({ x: '  ' })
    const out = escapeJsonForScript(json)
    expect(out).not.toContain(' ')
    expect(out).not.toContain(' ')
  })
})
