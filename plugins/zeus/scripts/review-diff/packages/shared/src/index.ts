import type { GroupFileRef, DisplayRange } from './types'

export * from './types'

// ファイル末尾の \n で空行が 1 行多く数えられるのを避けるため、最後が \n なら 1 減らす。
// (git show / GitHub Contents API の raw / source.after / source.before すべてが
//  末尾 \n 付きで返ってくる前提)。CLI の afterTotal と hunk-composer の afterMax が
//  ズレて phantom 空 row が出るのを防ぐため、両者で同じ式を使う。
export function countLines(text: string): number {
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

// GroupFileRef の判別を一箇所に集約する。`in` 演算子だけだと displayRanges: undefined のような
// 不正値で誤判定するため、必ず Array.isArray を併用する。CLI と client で同じヘルパーを通すことで
// 「片方では hunks 経路、もう片方では all 経路」の非対称が起きるのを防ぐ (W1)。
export type RefKind =
  | { kind: 'all'; path: string }
  | { kind: 'hunks'; path: string; hunks: number[] }
  | { kind: 'ranges'; path: string; displayRanges: DisplayRange[] }

export function getRefKind(ref: GroupFileRef): RefKind {
  if (typeof ref === 'string') return { kind: 'all', path: ref }
  if ('displayRanges' in ref && Array.isArray(ref.displayRanges) && ref.displayRanges.length > 0) {
    return { kind: 'ranges', path: ref.path, displayRanges: ref.displayRanges }
  }
  if ('hunks' in ref && Array.isArray(ref.hunks)) {
    return { kind: 'hunks', path: ref.path, hunks: ref.hunks }
  }
  return { kind: 'all', path: ref.path }
}
