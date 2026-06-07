#!/usr/bin/env node
// 2 段階バンドル:
//   Step 1: src/client/index.tsx (React + TSX) を IIFE 単一文字列にバンドルし、メモリ上に保持
//   Step 2: marked / DOMPurify の UMD ソースを読み込み
//   Step 3: src/server-side/cli.ts を CJS バンドルし、Step 1/2 を esbuild の `define` で文字列定数注入
// なぜ中間ファイルを作らないか:
//   バンドル → 文字列リテラル化 → 再バンドルを 1 度のビルドで完結させたいため。
//   ディスクに client.js を吐くと CI でゴミになる + import path がブレるので避ける。

import { build } from 'esbuild'
import { chmod, readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// ---- Step 1: client (React + TSX) を IIFE 単一文字列にバンドル
const clientResult = await build({
  entryPoints: [resolve(__dirname, 'src/client/index.tsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  jsx: 'automatic',
  write: false,
  // marked / DOMPurify は window グローバル経由 (HTML 内で先に <script> 展開される) なので
  // クライアントバンドルには含めない。
})
const CLIENT_JS = clientResult.outputFiles[0].text
const clientBytes = Buffer.byteLength(CLIENT_JS, 'utf8')
console.log(`client bundle: ${clientBytes.toLocaleString()} bytes`)

// ---- Step 2: marked / DOMPurify の UMD ソースを直接読む
async function readLib(name, ...candidates) {
  for (const rel of candidates) {
    try {
      const path = require.resolve(`${name}/${rel}`)
      return await readFile(path, 'utf8')
    } catch {
      /* try next candidate */
    }
  }
  throw new Error(`Cannot find ${name} UMD bundle (tried: ${candidates.join(', ')})`)
}

const markedSrc = await readLib(
  'marked',
  'marked.min.js',
  'lib/marked.umd.js',
  'lib/marked.umd.min.js',
  'lib/marked.cjs',
)
const dompurifySrc = await readLib(
  'dompurify',
  'dist/purify.min.js',
  'dist/purify.js',
)

// ---- Step 3: CLI を CJS バンドル。define で client / marked / dompurify を文字列注入
await build({
  entryPoints: [resolve(__dirname, 'src/server-side/cli.ts')],
  outfile: resolve(__dirname, 'dist/cli.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __MARKED_JS__: JSON.stringify(markedSrc),
    __DOMPURIFY_JS__: JSON.stringify(dompurifySrc),
    __CLIENT_JS__: JSON.stringify(CLIENT_JS),
  },
})

await chmod(resolve(__dirname, 'dist/cli.js'), 0o755)

// package.json は "type": "module" だが、esbuild の出力は CJS なので
// dist/ だけ CommonJS 扱いになるよう専用 package.json を置く (拡張子を .cjs にする手も
// あるが、SKILL.md などから参照するパスが変わるのを避けたい)。
await mkdir(resolve(__dirname, 'dist'), { recursive: true })
await writeFile(
  resolve(__dirname, 'dist/package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
)

const cliBytes = (await readFile(resolve(__dirname, 'dist/cli.js'))).length
console.log(`built dist/cli.js: ${cliBytes.toLocaleString()} bytes`)
