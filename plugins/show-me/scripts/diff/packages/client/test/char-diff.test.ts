// changedRanges / intraLineDecorations (文字単位 intra-line diff) の contract:
//   - char diff + cleanupSemantic で「変更された文字範囲」を old 側 del / new 側 ins として返す
//   - range は常に互いに素 (重複・隣接マージ済み) かつ空 range (start === end) を含まない
//     (Shiki decorations が部分交差で throw / 空 range で空 span を生むため)
//   - offset は UTF-16 code unit (Shiki decorations と同じ単位)
//   - 長大行 (INTRA_LINE_MAX_LENGTH 超) はスキップして空 = 行全体ハイライトへフォールバック

import { describe, test, expect } from 'vitest'
import {
  changedRanges,
  intraLineDecorations,
  INTRA_LINE_MAX_LENGTH,
  type CharRange,
} from '../src/lib/char-diff'

// 全テスト横断の invariant: start < end (空 range なし)、sort 済み、互いに素 (隣接もマージ済み)
function assertDisjoint(ranges: CharRange[]) {
  for (const r of ranges) {
    expect(r.start).toBeLessThan(r.end)
  }
  for (let i = 0; i + 1 < ranges.length; i++) {
    expect(ranges[i].end).toBeLessThan(ranges[i + 1].start)
  }
}

function slices(line: string, ranges: CharRange[]): string[] {
  return ranges.map((r) => line.slice(r.start, r.end))
}

// 「何が濃い背景になるか」を [...] マーカーで可視化する。
// range の数値比較だけだとレビュー時にハイライトの見え方を想像できないため、
// 期待値を人間が読める形で固定する (UI の見た目品質をテストでレビュー可能にする)
function markRanges(line: string, ranges: CharRange[]): string {
  let out = ''
  let pos = 0
  for (const r of ranges) {
    out += line.slice(pos, r.start) + '[' + line.slice(r.start, r.end) + ']'
    pos = r.end
  }
  return out + line.slice(pos)
}

describe('changedRanges', () => {
  test('リネーム: 変更された文字範囲だけが range になる', () => {
    const oldLine = 'const a = getUser(x).name'
    const newLine = 'const a = fetchUser(x).displayName'
    const { del, ins } = changedRanges(oldLine, newLine)
    assertDisjoint(del)
    assertDisjoint(ins)
    // del range は old 側にのみ存在する文字、ins range は new 側にのみ存在する文字を指す
    expect(del.length).toBeGreaterThan(0)
    expect(ins.length).toBeGreaterThan(0)
    // 共通 prefix 'const a = ' は range に含まれない
    expect(del[0].start).toBeGreaterThanOrEqual('const a = '.length)
    expect(ins[0].start).toBeGreaterThanOrEqual('const a = '.length)
  })

  test('挿入のみ: del が空、ins が追加部分を指す', () => {
    const { del, ins } = changedRanges('doFetch(url)', 'doFetch(url, { retry: 3 })')
    expect(del).toEqual([])
    assertDisjoint(ins)
    expect(slices('doFetch(url, { retry: 3 })', ins)).toEqual([', { retry: 3 }'])
  })

  test('削除のみ: ins が空、del が削除部分を指す', () => {
    const { del, ins } = changedRanges('doFetch(url, { retry: 3 })', 'doFetch(url)')
    expect(ins).toEqual([])
    assertDisjoint(del)
    expect(slices('doFetch(url, { retry: 3 })', del)).toEqual([', { retry: 3 }'])
  })

  test('サロゲートペア: 絵文字を分断しない', () => {
    const oldLine = "const icon = '👍 ok'"
    const newLine = "const icon = '🎉 ok'"
    const { del, ins } = changedRanges(oldLine, newLine)
    assertDisjoint(del)
    assertDisjoint(ins)
    // 絵文字 (code unit 2 個) が丸ごと range に入り、slice しても壊れた文字にならない
    expect(slices(oldLine, del)).toEqual(['👍'])
    expect(slices(newLine, ins)).toEqual(['🎉'])
  })

  test('日本語: cleanupSemantic が意味の塊で range を返し offset がズレない', () => {
    const oldLine = '// ユーザー情報を取得して名前を返す'
    const newLine = '// ユーザー情報をフェッチして表示名を返す'
    const { del, ins } = changedRanges(oldLine, newLine)
    expect(slices(oldLine, del)).toEqual(['取得して名前'])
    expect(slices(newLine, ins)).toEqual(['フェッチして表示名'])
  })

  test('同一行: 両方空', () => {
    expect(changedRanges('same line', 'same line')).toEqual({ del: [], ins: [] })
  })

  test('完全相違行: 低類似度フォールバックで両方空 (行全体ハイライトに任せる)', () => {
    const oldLine = 'return legacyRender(tree)'
    const newLine = 'const html = await pipeline.process(input)'
    expect(changedRanges(oldLine, newLine)).toEqual({ del: [], ins: [] })
  })

  test('類似度境界: 共通部分が短い側の半分以上なら intra-line を出す', () => {
    // ちょうど半分 (equal 4 / min 8): 表示する側に倒す
    const half = changedRanges('abcdWXYZ', 'abcd1234')
    expect(half.del.length).toBeGreaterThan(0)
    expect(half.ins.length).toBeGreaterThan(0)
    // 半分未満 (equal 3 / min 8): フォールバック
    expect(changedRanges('abcWXYZQ', 'abc12345')).toEqual({ del: [], ins: [] })
  })

  test('類似度判定は空白を数えない: 共通がインデントだけの短い行ペアはフォールバック', () => {
    // 文字数ベースだと `  )` (3 文字) との min が小さすぎて「共通の空白 2 文字」で
    // 類似と誤判定され、無関係なコード行のほぼ全体が濃くなっていた
    expect(changedRanges('  )', "    side === 'asIs'")).toEqual({ del: [], ins: [] })
  })

  test('空文字列との組み合わせ: 非空側の全体が range、空側は空', () => {
    const a = changedRanges('', 'added line')
    expect(a.del).toEqual([])
    expect(a.ins).toEqual([{ start: 0, end: 'added line'.length }])
    const b = changedRanges('removed line', '')
    expect(b.ins).toEqual([])
    expect(b.del).toEqual([{ start: 0, end: 'removed line'.length }])
  })

  test('閾値境界: ちょうど MAX では計算され、+1 でスキップされる', () => {
    // off-by-one を固定する: 閾値変更時にどちら側の挙動が変わったか検知できるよう両側を置く
    const atMax = 'a'.repeat(INTRA_LINE_MAX_LENGTH - 1) + 'X'
    const atMaxChanged = 'a'.repeat(INTRA_LINE_MAX_LENGTH - 1) + 'Y'
    const computed = changedRanges(atMax, atMaxChanged)
    expect(computed.del.length).toBeGreaterThan(0)
    expect(computed.ins.length).toBeGreaterThan(0)

    const overMax = 'a'.repeat(INTRA_LINE_MAX_LENGTH + 1)
    expect(changedRanges(overMax, 'short')).toEqual({ del: [], ins: [] })
    expect(changedRanges('short', overMax)).toEqual({ del: [], ins: [] })
  })
})

// ハイライトの見た目品質を [...] マーカーで固定する可視化テスト。
// これが変わったらライブラリ更新等で UI の見え方が変わったということなので、
// 期待値の更新前に「人間が読みやすくなったか / 悪化したか」を判断すること。
describe('ハイライト可視化 (何が濃い背景になるか)', () => {
  test('1 文字変更 (バージョン上げ): 変わった数字だけが濃くなる', () => {
    const oldLine = '  "version": "1.1.0",'
    const newLine = '  "version": "1.2.0",'
    const { del, ins } = changedRanges(oldLine, newLine)
    expect(markRanges(oldLine, del)).toBe('  "version": "1.[1].0",')
    expect(markRanges(newLine, ins)).toBe('  "version": "1.[2].0",')
  })

  test('引数追加: 追加部分だけが 1 塊で濃くなる', () => {
    const oldLine = 'doFetch(url)'
    const newLine = 'doFetch(url, { retry: 3 })'
    const { del, ins } = changedRanges(oldLine, newLine)
    expect(markRanges(oldLine, del)).toBe('doFetch(url)')
    expect(markRanges(newLine, ins)).toBe('doFetch(url[, { retry: 3 }])')
  })

  test('日本語コメント書き換え: 意味の塊で濃くなる', () => {
    const oldLine = '// ユーザー情報を取得して名前を返す'
    const newLine = '// ユーザー情報をフェッチして表示名を返す'
    const { del, ins } = changedRanges(oldLine, newLine)
    expect(markRanges(oldLine, del)).toBe('// ユーザー情報を[取得して名前]を返す')
    expect(markRanges(newLine, ins)).toBe('// ユーザー情報を[フェッチして表示名]を返す')
  })

  test('リネーム: cleanupSemantic 後も短い断片が残る (char-level の既知の見え方)', () => {
    // g→f のような 1 文字差のリネームでは「et」「User(id).」等の長い共通部分が
    // 吸収されずに残り、濃い背景が断片化する。これは厳密文字単位を選んだ仕様上の挙動で、
    // 見た目品質を変える場合 (word 境界スナップ等) はこの期待値の変化として現れる
    const oldLine = 'const userName = getUser(id).name'
    const newLine = 'const userName = fetchUser(id).displayName'
    const { del, ins } = changedRanges(oldLine, newLine)
    expect(markRanges(oldLine, del)).toBe('const userName = [g]etUser(id).[n]ame')
    expect(markRanges(newLine, ins)).toBe('const userName = [f]et[ch]User(id).[displayN]ame')
  })

  test('全面書き換え: 低類似度フォールバックで何も濃くしない (行全体の薄い背景のみ)', () => {
    // 位置対応ペアが全く別内容の行を組んだとき、char diff の偶然一致は
    // 「ハイライト位置が間違っている」ように見えるため intra-line を出さない
    const oldLine = 'return legacyRender(tree)'
    const newLine = 'const html = await pipeline.process(input)'
    const { del, ins } = changedRanges(oldLine, newLine)
    expect(markRanges(oldLine, del)).toBe(oldLine)
    expect(markRanges(newLine, ins)).toBe(newLine)
  })

  test('別内容の行ペア (コードとコメント): 何も濃くしない', () => {
    const oldLine = '  const html = useMemo('
    const newLine = '  // 同一 SideBySideRow に deletion と addition が同居している行だけが対象'
    const { del, ins } = changedRanges(oldLine, newLine)
    expect(markRanges(oldLine, del)).toBe(oldLine)
    expect(markRanges(newLine, ins)).toBe(newLine)
  })

  test('フィールド追加: 挿入が前方の語に歪まず追加部分そのものが濃くなる', () => {
    // cleanupSemantic の空白境界寄せで "raw:[ string; pairRaw?:] string" に歪んでいた
    // ケース。セグメント数が減らないときは raw diff の自然な境界を使うことで、
    // 追加した "; pairRaw?: string" がそのまま濃くなる
    const oldLine = "  | { kind: 'deletion'; oldLine?: number; raw: string }"
    const newLine = "  | { kind: 'deletion'; oldLine?: number; raw: string; pairRaw?: string }"
    const { del, ins } = changedRanges(oldLine, newLine)
    expect(markRanges(oldLine, del)).toBe(oldLine)
    expect(markRanges(newLine, ins)).toBe(
      "  | { kind: 'deletion'; oldLine?: number; raw: string[; pairRaw?: string] }",
    )
  })
})

describe('intraLineDecorations', () => {
  test("side='del' は old 行の削除 range に char-del class を付ける", () => {
    const decos = intraLineDecorations('getUser(id)', 'fetchUser(id)', 'del')
    expect(decos.length).toBeGreaterThan(0)
    for (const d of decos) {
      expect(d.properties).toEqual({ class: 'char-del' })
    }
  })

  test("side='add' は new 行の挿入 range に char-add class を付ける", () => {
    const decos = intraLineDecorations('getUser(id)', 'fetchUser(id)', 'add')
    expect(decos.length).toBeGreaterThan(0)
    for (const d of decos) {
      expect(d.properties).toEqual({ class: 'char-add' })
    }
  })

  test('スキップ時 (長大行) は空配列', () => {
    const overMax = 'a'.repeat(INTRA_LINE_MAX_LENGTH + 1)
    expect(intraLineDecorations(overMax, 'short', 'del')).toEqual([])
    expect(intraLineDecorations(overMax, 'short', 'add')).toEqual([])
  })

  test('差分なしの行ペアは空配列', () => {
    expect(intraLineDecorations('same', 'same', 'del')).toEqual([])
    expect(intraLineDecorations('same', 'same', 'add')).toEqual([])
  })
})
