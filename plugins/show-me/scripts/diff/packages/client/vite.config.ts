import { defineConfig } from '@voidzero-dev/vite-plus-core'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// なぜ library mode + IIFE か:
//   本番ビルドは cli パッケージの esbuild が dist/index.js を読み込み、
//   __CLIENT_JS__ として CJS bundle 内に文字列リテラル注入する。
//   IIFE 形式にすることで「global スコープで自己起動」する単一ファイルになり、
//   CSP `default-src 'none'` 下でも <script> として inline 実行できる。
//
// なぜ defineConfig を vite-plus-core から import するか:
//   vite-plus-core は本家 vite を内部で使う薄いラッパ。
//   defineConfig も vite-plus-core 経由で型整合を取る。
//
// なぜ root をパッケージルートにするか:
//   dev では packages/client/index.html を Vite が serve し、その中で /src/dev-entry.tsx
//   を import する。root を src/ に置くと index.html のパス解決が壊れる。
export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname),
  // ブラウザバンドルに混入する Node 由来の process.env 参照を静的置換で消す。
  // React の prod build 判定や、Shiki / parse-git-diff 等の dep が
  // `process.env.NODE_ENV` を残すことがあり、ランタイムで ReferenceError を起こす。
  //
  // dev / build を分岐する理由:
  //   `command === 'serve'` (vp dev) のときは 'development' に倒し、React StrictMode の
  //   二重実行検出や各種 dev warning を有効化する。'production' 固定にすると StrictMode が
  //   全て no-op になり、開発時の保険が消える。
  //   build (本番バンドル) では 'production' を入れ React の dead-code 除去を効かせる。
  define: {
    'process.env.NODE_ENV': JSON.stringify(command === 'serve' ? 'development' : 'production'),
    'process.env': '({})',
    'process.platform': JSON.stringify('browser'),
    // ビルド毎に時刻を埋め込み、ブラウザのコンソールから「今表示しているバンドルが
    // 最新ビルドか」を即座に確認できるようにする。タブが古い (cli 未再起動 / cache) と
    // タイムスタンプが古いままになる。
    __BUILD_ID__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      name: 'ShowMeDiff',
      formats: ['iife'],
      fileName: () => 'index.js',
    },
    cssCodeSplit: false,
    // CSS の出力ファイル名を固定して cli/build.mjs が決め打ちで読めるようにする。
    // Tailwind v4 は @tailwindcss/vite が build 時に utility を tree-shake した CSS を吐き、
    // cssCodeSplit: false でそれを単一ファイル化、assetFileNames で hash 無しの globals.css に固定。
    // 旧実装は src/styles.css を直読みしていたが、Tailwind 移行で source CSS は @theme + @layer の
    // 入力に変わったため、ブラウザに送るのは「Vite が tailwind 解決した出力」一択。
    rollupOptions: {
      output: {
        assetFileNames: (info) =>
          info.name?.endsWith('.css') ? 'globals.css' : '[name][extname]',
      },
    },
    sourcemap: false,
    minify: true,
  },
  // なぜランダムポート (0):
  //   デフォルト 5173 は他の dev サーバと衝突しやすい常連ポート。
  //   zeus プラグインを使うユーザーは別プロジェクトを並走している前提が多いため、
  //   起動時に OS に空きポートを選ばせて衝突を回避する。
  server: {
    port: 0,
    open: '/index.html',
    strictPort: false,
  },
}))
