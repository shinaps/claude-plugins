// React アプリのエントリポイント。
// build.mjs の Step 1 esbuild がこれを IIFE 単一文字列にバンドルし、
// CLI バンドル側で __CLIENT_JS__ に注入 → HTML の <script> として inline 配信される。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { getPayload, startHeartbeat } from './lib/state.ts'
// CSS を entry に import する目的は「production build で dist/globals.css を生成させる」だけ。
// Vite library mode は entry の依存グラフに含まれる CSS だけを output asset に書き出すため、
// dev-entry.tsx の import だけでは build 時に CSS が出ない。runtime では cli の <style> inline 配信が
// 担うので、ここで import した CSS が IIFE bundle 内で link tag を作っても害は無い (実際は
// cssCodeSplit:false + 静的 link 注入無し設定で、ただ dist/globals.css にファイルだけが残る)。
import './globals.css'

// バンドルを焼いた時点で esbuild の `define` で literal に置換される。
// ブラウザでこのログが出ないなら、表示中のタブは古いセッション (cli を再起動していない / cache)。
declare const __BUILD_ID__: string
console.log('[review-diff] client bundle build:', typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'unknown')

// Phase 0 diagnostic: Long Animation Frames API でメインスレッドの長期ブロックを記録する。
// タブ切替で何が時間を消費しているか (script / layout / render / paint) を識別するため。
// 50ms 超のみログ (INP good の閾値、Long Task と同じ)。
// Chrome 123+ のみ動作 (Safari/Firefox は未対応、PerformanceObserver の supportedEntryTypes で gate)。
try {
  if (
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
  ) {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as Array<{
        duration: number
        renderStart: number
        startTime: number
        styleAndLayoutStart: number
        firstUIEventTimestamp: number
        blockingDuration: number
        scripts: Array<{
          name: string
          duration: number
          sourceURL: string
          sourceFunctionName: string
          sourceCharPosition: number
          invokerType: string
          forcedStyleAndLayoutDuration: number
        }>
      }>) {
        if (entry.duration < 50) continue
        const renderDur = entry.styleAndLayoutStart > 0
          ? Math.round(entry.styleAndLayoutStart - entry.renderStart)
          : 0
        const layoutDur = entry.styleAndLayoutStart > 0
          ? Math.round(entry.startTime + entry.duration - entry.styleAndLayoutStart)
          : 0
        const topScripts = (entry.scripts ?? [])
          .slice()
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 3)
          .map(s =>
            `${Math.round(s.duration)}ms ${s.invokerType ?? '?'} fsl=${Math.round(s.forcedStyleAndLayoutDuration ?? 0)}ms ${s.sourceFunctionName || '(anon)'} @ ${s.sourceURL || '(inline)'}`,
          )
        console.warn(
          `[LoAF] dur=${Math.round(entry.duration)}ms render=${renderDur}ms layout=${layoutDur}ms block=${Math.round(entry.blockingDuration ?? 0)}ms`,
          topScripts.length > 0 ? '\n  top scripts:\n    ' + topScripts.join('\n    ') : '',
        )
      }
    })
    obs.observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit)
    console.log('[review-diff] LoAF observer attached (Chrome 123+)')
  } else {
    console.log('[review-diff] LoAF not supported in this browser')
  }
} catch (e) {
  console.warn('[review-diff] LoAF setup failed:', e)
}

// グローバル pointerdown ロガー: 「ユーザーが何処を押下したか」「React の onPointerDown 経路に
// 入る前段で阻害されていないか」を観測するため、window レベル (capture phase) で全 pointerdown を
// ログする。出力例: target=SPAN(.text-token) td-closest=Yes data-side=right data-line=42
window.addEventListener('pointerdown', (e) => {
  const t = e.target as HTMLElement | null
  // <div class="cell-code"/.cell-ln> grid 構造に対応したセレクタ (旧 <table>/<td> ではない)。
  // [data-side][data-line-number] で gutter / code どちらの cell でも当たる。
  const codeCell = t?.closest?.('.cell-code[data-side]') as HTMLElement | null
  const cell = t?.closest?.('[data-side][data-line-number]') as HTMLElement | null
  const trigger = t?.closest?.('.line-comment-trigger') as HTMLElement | null
  const elsAtPoint = document.elementsFromPoint(e.clientX, e.clientY)
    .slice(0, 6)
    .map((el) => `${el.tagName}.${typeof el.className === 'string' ? el.className.toString().slice(0, 30) : ''}`)
    .join(' > ')
  const triggerRect = trigger?.getBoundingClientRect()
  const cellRect = cell?.getBoundingClientRect()
  const cellClass = cell?.className
  const c2 = cellRect ?? { left: 0, top: 0 }
  const trg2 = triggerRect ?? { left: 0, top: 0 }
  console.log(
    `[pd] xy=(${e.clientX | 0},${e.clientY | 0}) target=${t?.tagName}.${(t?.className ?? '').toString().slice(0,40)} cell=${cellClass}@(${c2.left | 0},${c2.top | 0}) inCellCode=${!!codeCell} inTrigger=${!!trigger} trigger@(${trg2.left | 0},${trg2.top | 0}) stack=[${elsAtPoint}]`
  )
}, true)

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

const payload = getPayload()

// v5: editor-link 機能の世界変数を設定。Panel.tsx 内 EditorLinkTrigger が参照する。
// editorAvailable=false なら EditorLinkTrigger は render されない (CR-3: command 漏らさず boolean だけ伝搬)。
if (typeof window !== 'undefined') {
  window.__reviewDiffEditorAvailable = payload.editorAvailable === true
  // v5: 永続化済みスレッドを Panel CommentRow / ActivityView Conversation で参照できるよう公開
  window.__reviewDiffThreads = payload.initialThreads ?? {}
}

// タブが閉じられたら CLI 側で「heartbeat 途絶 → 自発 exit」が走る前提なので、起動時に開始する。
// dev サーバ (HMR) 経由ではトークン無しで起動するので startHeartbeat が no-op になる安全策あり。
startHeartbeat()

createRoot(root).render(
  <StrictMode>
    <App payload={payload} />
  </StrictMode>,
)
