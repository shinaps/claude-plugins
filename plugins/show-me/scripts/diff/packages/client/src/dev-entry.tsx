// Vite dev サーバー用のエントリポイント。
// 本番 index.tsx は HTML に inline 埋め込みされる payload を JSON.parse するが、
// dev では sample-data.ts のモック payload を import して直接 props に渡す。
// CSS は `import './globals.css'` で読み込み、Vite + @tailwindcss/vite に Tailwind 解決と HMR を委ねる。
// 本番ビルドでは build.mjs が dist/globals.css (Vite が出力した Tailwind 済み CSS) を読み、
// template.ts の __CSS_STRING__ に define で注入するため、dev / 本番で見た目は完全に一致する。
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './globals.css'
import { sampleData } from './__mocks__/sample-data.ts'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <App payload={sampleData} />
  </StrictMode>,
)
