// 行ペア (deletion/addition) の文字単位 diff を計算し、Shiki decorations 用の
// 互いに素な offset range に変換する純関数群。
// 粒度の判断 (char diff + cleanupSemantic) をこのモジュールに閉じ込めることで、
// 将来 word-level へ切り替える場合もここだけ差し替えれば済む。
//
// offset の単位は UTF-16 code unit。diff-match-patch の出力 length も Shiki decorations の
// offset も同じ単位なので、累積加算した値をそのまま渡せる (code point 換算は持ち込まない)。

import { makeDiff, cleanupSemantic, DIFF_DELETE, DIFF_INSERT, DIFF_EQUAL } from '@sanity/diff-match-patch'
import type { DecorationItem } from 'shiki/core'

export type CharRange = { start: number; end: number }

// これ以上長い行は char diff をスキップして行全体ハイライトに留める。
// minified JS / lockfile 等の長大行では intra-line の視認価値が薄く、
// 通常のコード行 (数百文字) を十分カバーする 1,000 文字を上限とする。
// 計算時間の防御は makeDiff の timeout (1 秒) が第二段として別にあるため、
// この閾値は性能ではなく「ハイライトの視認価値」で切る。
export const INTRA_LINE_MAX_LENGTH = 1000

// 行ペアの文字単位差分を「old 側の削除 range / new 側の挿入 range」として返す。
// スキップ条件 (長大行 / 低類似度) と計算失敗時はどちらも空配列 = decorations なし。
// 呼び出し側は空配列をそのまま highlightCode に渡さないため、従来の
// 行全体ハイライトに静かにフォールバックする (FR-7)。
export function changedRanges(oldLine: string, newLine: string): { del: CharRange[]; ins: CharRange[] } {
  if (oldLine.length > INTRA_LINE_MAX_LENGTH || newLine.length > INTRA_LINE_MAX_LENGTH) {
    return { del: [], ins: [] }
  }
  try {
    // timeout の単位は秒。@sanity/diff-match-patch は `opts.timeout || 1` の falsy 判定で
    // 0 を 1 秒に倒すため、明示的に 1 を渡して「1 秒で粗い diff に切り上げる」意図を固定する。
    const rawDiffs = makeDiff(oldLine, newLine, { timeout: 1 })

    // 低類似度フォールバック: 共通部分が短い側の半分に満たない行ペアは「全く別内容の行」
    // とみなし、intra-line を出さず行全体ハイライトに留める。位置対応ペアリングは
    // ブロック内の行数がずれると無関係な行同士を組むことがあり、その char diff は
    // 偶然一致した文字の縞模様になって「ハイライト位置が間違っている」ように見えるため。
    // 空白を除いて数えるのは、`  )` のような短い行とコード行のペアで「共通のインデント」
    // だけを根拠に類似と誤判定し、無関係な行のほぼ全体が濃くなるのを防ぐため。
    const equalNonWs = rawDiffs.reduce(
      (s, [op, text]) => (op === DIFF_EQUAL ? s + nonWsLength(text) : s),
      0,
    )
    if (equalNonWs * 2 < Math.min(nonWsLength(oldLine), nonWsLength(newLine))) {
      return { del: [], ins: [] }
    }

    // cleanupSemantic は短い equal 断片を変更側に吸収できたとき (= 変更セグメント数が
    // 減るとき) だけ採用する。減らない場合は境界の空白寄せだけが起きて、最小 diff の
    // 自然な挿入位置 (例: "raw: string" の後の "; pairRaw?: string" 追加) が
    // "raw:[ string; pairRaw?:] string" のように前方の語へ歪むため raw をそのまま使う。
    const cleaned = cleanupSemantic(rawDiffs)
    const diffs = changeSegmentCount(cleaned) < changeSegmentCount(rawDiffs) ? cleaned : rawDiffs

    const del: CharRange[] = []
    const ins: CharRange[] = []
    let o = 0
    let n = 0
    for (const [op, text] of diffs) {
      if (op === DIFF_EQUAL) {
        o += text.length
        n += text.length
      } else if (op === DIFF_DELETE) {
        if (text.length > 0) del.push({ start: o, end: o + text.length })
        o += text.length
      } else if (op === DIFF_INSERT) {
        if (text.length > 0) ins.push({ start: n, end: n + text.length })
        n += text.length
      }
    }
    return { del: mergeRanges(del), ins: mergeRanges(ins) }
  } catch {
    // diff 計算が落ちても表示は壊さない: range なし = 行全体ハイライトのまま
    return { del: [], ins: [] }
  }
}

// 空白を除いた文字数。類似度判定 (低類似度フォールバック) 専用。
function nonWsLength(s: string): number {
  return s.replace(/\s/g, '').length
}

// 変更 (delete / insert) セグメントの個数。cleanupSemantic の採用判定に使う。
function changeSegmentCount(diffs: ReadonlyArray<readonly [number, string]>): number {
  return diffs.reduce((n, [op]) => (op === DIFF_EQUAL ? n : n + 1), 0)
}

// range を互いに素 (重複・隣接なし) に整える。
// Shiki decorations は部分交差 range で throw し、空 range (start === end) は
// throw せず class 付き空 span を黙って生成するため、ここで両方を構造的に排除する。
// 入力は changedRanges の走査順 (= start 昇順) で来る前提。
function mergeRanges(ranges: CharRange[]): CharRange[] {
  const out: CharRange[] = []
  for (const r of ranges) {
    if (r.start >= r.end) continue
    const last = out[out.length - 1]
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end)
    } else {
      out.push({ ...r })
    }
  }
  return out
}

// 行ペアから「side 側の行に当てる decorations」を生成する。
//   side='del' → oldRaw 行に対する削除 range (class: char-del)
//   side='add' → newRaw 行に対する挿入 range (class: char-add)
// range が無ければ空配列 (decorations なし扱い)。
export function intraLineDecorations(
  oldRaw: string,
  newRaw: string,
  side: 'del' | 'add',
): DecorationItem[] {
  const { del, ins } = changedRanges(oldRaw, newRaw)
  const ranges = side === 'del' ? del : ins
  const cls = side === 'del' ? 'char-del' : 'char-add'
  return ranges.map(({ start, end }) => ({ start, end, properties: { class: cls } }))
}
