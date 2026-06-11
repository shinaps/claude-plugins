// matchMedia ベースの media query hook。
//
// unified/split の切替を CSS media query ではなく JS 判定にする理由: split mode は
// 行高同期 ResizeObserver や横スクロール mirror などの重い effect 群を持つため、
// 表示だけ CSS で隠しても effect と DOM が生き続ける。JS 判定で component ごと
// 差し替えることで、狭幅時に split の処理を完全に止める。
//
// この判定はローカル/リモートを問わず適用する: 768px 未満では split の各列が
// 実質 ~187px になり物理的に読めないため、狭幅ウィンドウでは unified の方が正しい。

import { useEffect, useState } from 'react'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    // mount 〜 effect 実行の間に状態が変わっている可能性があるので一度同期する
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}
