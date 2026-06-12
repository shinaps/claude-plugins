// 1 行ぶんの raw コードを Shiki でハイライトして inner HTML を返す。
// SplitBody (Panel.tsx) と UnifiedBody が同じハイライト経路を共有するためここに置く。
//
// decorations: intra-line (char-level) diff の変更文字範囲に class 付き span を被せる。
// Shiki がトークンを decoration 境界で分割してくれるため、シンタックスカラーと共存する。

import type { DecorationItem } from 'shiki/core'
import { getShiki } from './shiki-bundle'
import { escapeHtml } from './markdown'

export function highlightCode(raw: string, lang: string, decorations?: DecorationItem[]): string {
  try {
    const html = getShiki().codeToHtml(raw, {
      lang,
      theme: 'github-dark',
      ...(decorations && decorations.length > 0 ? { decorations } : {}),
    })
    const m = html.match(/<code[^>]*>([\s\S]*?)<\/code>/)
    return (m ? m[1] : escapeHtml(raw)).replace(/\n$/, '')
  } catch {
    // decorations 起因の throw (range 交差・範囲外 offset 等) でシンタックスハイライト
    // ごと失うのは過剰なので、まず decorations を捨てて再試行する (静かなフォールバック)。
    // 再帰は decorations なしの呼び出しに収束するため深さ最大 2 で止まる。
    if (decorations && decorations.length > 0) return highlightCode(raw, lang)
    return escapeHtml(raw)
  }
}
