// CSS.escape の薄いラッパー (querySelector の attribute selector 値エスケープ用)。
// フォールバックは「英数と _ - 以外を全部エスケープ」の広い挙動に寄せる:
// quoted attribute selector では " と \ だけで足りるが、unquoted や id selector に
// 流用されても壊れない安全側に統一する。
export function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
  return s.replace(/[^A-Za-z0-9_-]/g, '\\$&')
}
