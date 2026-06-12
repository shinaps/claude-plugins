// SideBySideRow[] (split 用の行ペア整列) を unified 表示用の単一カラム行列に変換する純関数。
//
// 変換則: 連続する変更チャンク内では deletion 全部 → addition 全部の順で flush する。
// SideBySideRow は「行ペア」で整列されているため、素朴に flatten すると -/+/-/+ が交互に
// 並んで読めない。GitHub の unified diff と同じ「削除ブロックの直後に追加ブロック」の
// 読み味に並べ替える。context 行 (または empty のみの行) がチャンク境界になる。

import type { SideBySideRow } from '@show-me/diff-shared'

export type UnifiedRow =
  // context は old/new 両方の行番号を保持する。コメント anchor の lookup で
  // asIs(oldLine) と toBe(newLine) の両側を引く必要があるため (split では context 行も
  // 両 side にコメントが付けられる)。
  //
  // pairRaw: 同一 SideBySideRow でペアだった相手側 (addition ⇔ deletion) の raw。
  // この変換は左右ペア情報を展開して捨てるため、intra-line (char-level) diff 用に
  // ペアのテキストだけをここに残す。相手側が empty の余り行では付与しない。
  | { kind: 'context'; oldLine?: number; newLine?: number; raw: string }
  | { kind: 'deletion'; oldLine?: number; raw: string; pairRaw?: string }
  | { kind: 'addition'; newLine?: number; raw: string; pairRaw?: string }

export function toUnifiedRows(rows: SideBySideRow[]): UnifiedRow[] {
  const out: UnifiedRow[] = []
  let delBuf: UnifiedRow[] = []
  let addBuf: UnifiedRow[] = []
  const flush = () => {
    if (delBuf.length > 0 || addBuf.length > 0) {
      out.push(...delBuf, ...addBuf)
      delBuf = []
      addBuf = []
    }
  }
  for (const row of rows) {
    const isDel = row.asIs.type === 'deletion'
    const isAdd = row.toBe.type === 'addition'
    if (!isDel && !isAdd) {
      flush()
      // 片側 panel (asIs only / toBe only) では context が片 side にしか無いことがあるため、
      // どちらか一方でも context なら 1 行として出す。両側 empty は出力なし。
      if (row.asIs.type === 'context' || row.toBe.type === 'context') {
        out.push({
          kind: 'context',
          ...(row.asIs.type === 'context' && row.asIs.line != null ? { oldLine: row.asIs.line } : {}),
          ...(row.toBe.type === 'context' && row.toBe.line != null ? { newLine: row.toBe.line } : {}),
          raw: row.toBe.type === 'context' ? row.toBe.raw : row.asIs.raw,
        })
      }
      continue
    }
    if (isDel) {
      delBuf.push({
        kind: 'deletion',
        ...(row.asIs.line != null ? { oldLine: row.asIs.line } : {}),
        raw: row.asIs.raw,
        ...(isAdd ? { pairRaw: row.toBe.raw } : {}),
      })
    }
    if (isAdd) {
      addBuf.push({
        kind: 'addition',
        ...(row.toBe.line != null ? { newLine: row.toBe.line } : {}),
        raw: row.toBe.raw,
        ...(isDel ? { pairRaw: row.asIs.raw } : {}),
      })
    }
  }
  flush()
  return out
}
