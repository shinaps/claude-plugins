// Panel ごとの表示モード (split / unified) を panelId 単位で localStorage に永続化する hook。
//
// 設計判断:
//   - 初期値は split (asIs/toBe 並列)。GitHub PR / Linear の初期表示と一致するため迷わない。
//   - localStorage key は `panel-mode:${panelId}`。panelId は intent 除外の sha1 hash で
//     安定化されているため、context+/- で intent を書き直しても同じ key を引き続ける。
//   - panelId は zod 側で `^[A-Za-z0-9 _-]+$` に sanitize 済みなので、localStorage key に
//     特殊文字が紛れ込む心配はない。
//   - storage 不利用環境 (Safari private / 容量超過) では try/catch で握り潰し、
//     state だけが揮発的に保持される (= リロードで初期化される) を許容する。

import { useCallback, useState } from 'react'

export type PanelMode = 'split' | 'unified'

const STORAGE_KEY_PREFIX = 'panel-mode:'

export function usePanelToggle(panelId: string): {
  mode: PanelMode
  toggle: () => void
  setMode: (m: PanelMode) => void
} {
  const [mode, setModeState] = useState<PanelMode>(() => readStored(panelId))

  const setMode = useCallback((next: PanelMode) => {
    setModeState(next)
    writeStored(panelId, next)
  }, [panelId])

  const toggle = useCallback(() => {
    setModeState(prev => {
      const next: PanelMode = prev === 'split' ? 'unified' : 'split'
      writeStored(panelId, next)
      return next
    })
  }, [panelId])

  return { mode, toggle, setMode }
}

function readStored(panelId: string): PanelMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY_PREFIX + panelId)
    if (v === 'unified') return 'unified'
    if (v === 'split') return 'split'
  } catch { /* storage unavailable */ }
  return 'split'
}

function writeStored(panelId: string, mode: PanelMode): void {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + panelId, mode)
  } catch { /* storage unavailable / quota exceeded — degrade to in-memory */ }
}
