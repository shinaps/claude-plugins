// 単一 HTML を組み立てる。React アプリは esbuild Step 1 でバンドルされた IIFE 文字列
// (CLIENT_JS) をそのまま <script> に流し込み、#root にマウントする。
//
// なぜ React を inline で流し込むか:
//   外部リソース取得を一切させない CSP (default-src 'none') を維持したいため。
//   全アセット (CSS / JS / データ) を 1 HTML に閉じ込めることで、配信物が分散せず
//   再現性も高くなる (差分審査の現場で URL を渡すだけで全部見える)。

import type { ClientPayload } from '@show-me/diff-shared'
import { CLIENT_JS, MARKED_JS, DOMPURIFY_JS, CSS_STRING } from './inline-assets'

export type BuildHtmlInput = ClientPayload

export function buildHtml(payload: BuildHtmlInput): string {
  const dataJson = JSON.stringify(payload)
  // 複数プロジェクトのレビュータブを並行して開いたとき、ブラウザのタブ一覧だけで
  // どのリポジトリか判別できるよう、プロジェクト名をタイトル先頭に置く。
  const title = payload.project ? `${payload.project.name} · show-me` : 'show-me'
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS_STRING}</style>
</head>
<body>
<div id="root"></div>
<script id="payload" type="application/json">${escapeJsonForScript(dataJson)}</script>
<script>${MARKED_JS}</script>
<script>${DOMPURIFY_JS}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// JSON 内の `<` を一律 \u003c 形式の Unicode エスケープにする。`</script>` による要素の早期終了に加え、
// `<!--` + `<script` の組で HTML tokenizer が script data double escaped state に入り、
// #payload の本物の終端 </script> が呑み込まれて後続の inline script が全滅する (白画面)
// 事故も `<` 全置換で同時に封じる。JSON で `<` は文字列リテラル内にしか現れないため、
// 全置換しても JSON.parse の結果は不変で round-trip 安全。
// U+2028 / U+2029 (LS/PS) は JSON では合法だが古い JS パーサーには改行扱いされるため、
// \u エスケープに置換しておく (textContent 経由で取り出される時の保険)。
export function escapeJsonForScript(s: string): string {
  return s
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
