// 自動 collapse 判定: ファイル名パターンが build artifact / lockfile / minified に該当する
// panel を初期 collapsed で開くためのヘルパー。Guide / Diff 両タブから参照される。
//
// 設計判断:
//   - panel.toBe.file (なければ asIs.file) を入力に「これはレビューしなくていい類のファイル」を判定
//   - パターンは「典型的に diff レビュー対象から外したい」もの限定:
//       dist/ build/ out/ node_modules/ 配下 → build 成果物
//       *.min.js / *.min.css / *.min.mjs → minified
//       *-lock.* + 各種言語の lockfile → 依存解決の自動生成物
//   - 過剰除外を避けるため、ユーザーが Show diff で個別 expand 可能 (PanelBlock の userOverride)
//   - パターンは将来 UI から設定可能にするかもしれないが、現状はハードコード

const AUTO_COLLAPSE_PATTERNS: RegExp[] = [
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)out\//,
  /(^|\/)node_modules\//,
  /\.min\.(js|css|mjs)$/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|go\.sum)$/i,
]

export function shouldAutoCollapseFile(file: string | undefined): boolean {
  if (!file) return false
  return AUTO_COLLAPSE_PATTERNS.some((re) => re.test(file))
}
