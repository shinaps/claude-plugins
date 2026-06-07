// React アプリのエントリポイント。
// build.mjs の Step 1 esbuild がこれを IIFE 単一文字列にバンドルし、
// CLI バンドル側で __CLIENT_JS__ に注入 → HTML の <script> として inline 配信される。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { getPayload } from './state.ts'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

const payload = getPayload()

createRoot(root).render(
  <StrictMode>
    <App payload={payload} />
  </StrictMode>,
)
