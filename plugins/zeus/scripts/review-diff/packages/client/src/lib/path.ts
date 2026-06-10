// path 文字列のための小さなユーティリティ。
// Node の path モジュールはブラウザ bundle に入れたくないため自前実装する。

// 最後の '/' より後ろを返す。'/' が無ければそのまま、末尾 '/' なら空文字。
// 注意: App.tsx の basename(intentOrPath) とは別物 — あちらは rename 矢印表記
// "old → new" の new 側を採用するセマンティクスを持つため統合しない。
export function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? path : path.slice(idx + 1)
}
