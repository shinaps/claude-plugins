import type { Side, DisplayRange } from './types'

export * from './types'

// ファイル末尾の \n で空行が 1 行多く数えられるのを避けるため、最後が \n なら 1 減らす。
// (git show / GitHub Contents API の raw / source.after / source.before すべてが
//  末尾 \n 付きで返ってくる前提)。CLI / server / client で同じ式を使うことで
//  「片方では N 行、もう片方では N+1 行」のズレが起きない。
export function countLines(text: string): number {
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

// =====================================================================
// panel model ヘルパ
//
// DOM data-* 属性の値は HTML5 仕様上は preserve されるが、既存 data-line-number 等が
// 全小文字なので慣習統一として 'asis'/'tobe' を使う。TS 内部は Side ('asIs' | 'toBe')
// のまま保持し、DOM 書き出し時に sideToAttr で正規化する。読み戻しは attrToSide。
// =====================================================================

export function sideToAttr(s: Side): 'asis' | 'tobe' {
  return s === 'asIs' ? 'asis' : 'tobe'
}

export function attrToSide(s: string): Side | null {
  if (s === 'asis') return 'asIs'
  if (s === 'tobe') return 'toBe'
  return null
}

// 複数 range をフラットな行集合に展開する。validateCoverage / lineCommentKey で
// 「panel 内のどの行が含まれるか」を即座に判定するために使う。
// range は inclusive / 1-based 前提 (DisplayRange の契約と一致)。
export function unionRanges(ranges: DisplayRange[]): Set<number> {
  const out = new Set<number>()
  for (const r of ranges) {
    for (let n = r.start; n <= r.end; n++) out.add(n)
  }
  return out
}

export function rangesContain(ranges: DisplayRange[], line: number): boolean {
  return ranges.some(r => r.start <= line && line <= r.end)
}
