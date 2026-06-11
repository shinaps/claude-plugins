// 1 行ぶんの raw コードを Shiki でハイライトして inner HTML を返す。
// SplitBody (Panel.tsx) と UnifiedBody が同じハイライト経路を共有するためここに置く。

import { getShiki } from './shiki-bundle'
import { escapeHtml } from './markdown'

export function highlightCode(raw: string, lang: string): string {
  try {
    const html = getShiki().codeToHtml(raw, { lang, theme: 'github-dark' })
    const m = html.match(/<code[^>]*>([\s\S]*?)<\/code>/)
    return (m ? m[1] : escapeHtml(raw)).replace(/\n$/, '')
  } catch {
    return escapeHtml(raw)
  }
}
