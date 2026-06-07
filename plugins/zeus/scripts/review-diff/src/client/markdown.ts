// marked + DOMPurify を window グローダ経由で呼ぶラッパー。
// なぜ import せず window から取るか:
//   marked / DOMPurify は UMD 文字列としてサーバーから配信される (CSP 環境で
//   外部 script を許可しない方針)。React bundle 側で import すると同じライブラリを
//   2 回バンドルしてしまうので、グローバルに既に存在する想定で参照する。

type Marked = { parse: (md: string) => string }
type Purify = { sanitize: (html: string) => string }

declare global {
  interface Window {
    marked?: Marked
    DOMPurify?: Purify
  }
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]!)
}

export function renderMarkdown(md: string): string {
  if (!md) return ''
  const marked = window.marked
  const purify = window.DOMPurify
  if (!marked || !purify) return escapeHtml(md)
  try {
    return purify.sanitize(marked.parse(md))
  } catch {
    return escapeHtml(md)
  }
}
