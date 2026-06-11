// path 文字列のための小さなユーティリティ。
// Node の path モジュールはブラウザ bundle に入れたくないため自前実装する。

// 最後の '/' より後ろを返す。'/' が無ければそのまま、末尾 '/' なら空文字。
// 注意: diff/DiffTab.tsx の basenameFromIntent とは別契約 — あちらは rename 矢印表記
// "old → new" を new 側に分解してからこの関数に委譲する。矢印分解は intent 表示
// 固有の責務なので、この関数自体には持ち込まない。
export function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? path : path.slice(idx + 1)
}
