import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// dev サーバー専用の Vite 設定。
// なぜ root をパッケージルートにするか:
//   本番ビルド (build.mjs / esbuild) は src/client/index.tsx を IIFE 化して dist/cli.js に
//   インライン埋め込みする独自フローを持つ。Vite は本番ビルドに一切関与せず、開発時の
//   UI 単独デバッグだけを担う。
//   root を dev/ にすると ../src/client/dev-entry.tsx を Vite が解決できないため、
//   root をパッケージルートに置き、エントリ HTML だけ dev/index.html で別管理する。
//   本番 index.html は存在しない (CLI が動的生成) ので衝突しない。
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  server: {
    port: 5173,
    open: '/dev/index.html',
    strictPort: false,
  },
})
