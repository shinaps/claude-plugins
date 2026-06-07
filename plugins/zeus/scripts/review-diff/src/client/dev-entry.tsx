// Vite dev サーバー用のエントリポイント。
// 本番 index.tsx は HTML に inline 埋め込みされる payload を JSON.parse するが、
// dev では sample-data.ts のモック payload を import して直接 props に渡す。
// CSS も本番は template.ts から <style> インライン注入されるため、dev では
// styles.ts の文字列を document.head に動的注入する。
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { CSS_STRING } from './styles.ts'
import { sampleData } from './__mocks__/sample-data.ts'

function injectStyles() {
  const style = document.createElement('style')
  style.dataset.devStyles = 'true'
  style.textContent = CSS_STRING
  document.head.appendChild(style)
}

injectStyles()

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <App payload={sampleData} />
  </StrictMode>,
)
