// React アプリのエントリポイント。
// build.mjs の Step 1 esbuild がこれを IIFE 単一文字列にバンドルし、
// CLI バンドル側で __CLIENT_JS__ に注入 → HTML の <script> として inline 配信される。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { getPayload } from './state.ts'

// バンドルを焼いた時点で esbuild の `define` で literal に置換される。
// ブラウザでこのログが出ないなら、表示中のタブは古いセッション (cli を再起動していない / cache)。
declare const __BUILD_ID__: string
console.log('[review-diff] client bundle build:', typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'unknown')

// グローバル pointerdown ロガー: 「ユーザーが何処を押下したか」「React の onPointerDown 経路に
// 入る前段で阻害されていないか」を観測するため、window レベル (capture phase) で全 pointerdown を
// ログする。出力例: target=SPAN(.text-token) td-closest=Yes data-side=right data-line=42
window.addEventListener('pointerdown', (e) => {
  const t = e.target as HTMLElement | null
  const td = t?.closest?.('td.code[data-side]') as HTMLElement | null
  const trigger = t?.closest?.('.line-comment-trigger') as HTMLElement | null
  const modal = t?.closest?.('.modal-dialog')
  const actionBar = t?.closest?.('.action-bar')
  // クリック座標とその直下にある全要素を「文字列で」一行ログ。配列の展開不要。
  const elsAtPoint = document.elementsFromPoint(e.clientX, e.clientY)
    .slice(0, 6)
    .map((el) => `${el.tagName}.${typeof el.className === 'string' ? el.className.toString().slice(0, 30) : ''}`)
    .join(' > ')
  const triggerRect = trigger?.getBoundingClientRect()
  const tdRect = (t?.closest?.('td') as HTMLElement | null)?.getBoundingClientRect()
  const tdClass = (t?.closest?.('td') as HTMLElement | null)?.className
  const td2 = tdRect ?? { left: 0, top: 0 }
  const trg2 = triggerRect ?? { left: 0, top: 0 }
  console.log(
    `[pd] xy=(${e.clientX | 0},${e.clientY | 0}) target=${t?.tagName}.${(t?.className ?? '').toString().slice(0,40)} td=${tdClass}@(${td2.left | 0},${td2.top | 0}) inTdCode=${!!td} inTrigger=${!!trigger} trigger@(${trg2.left | 0},${trg2.top | 0}) stack=[${elsAtPoint}]`
  )
}, true)

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

const payload = getPayload()

createRoot(root).render(
  <StrictMode>
    <App payload={payload} />
  </StrictMode>,
)
