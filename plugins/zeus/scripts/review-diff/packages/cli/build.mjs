#!/usr/bin/env node
// cli パッケージの build script。3 step は維持:
//   Step 1: client パッケージの dist/index.js (Vite+ で IIFE 化済み) を読み込み
//   Step 2: marked / DOMPurify UMD を node_modules から読み込み
//   Step 3: cli.ts を esbuild で CJS bundle し、define で 4 つの文字列定数を注入

import { build } from 'esbuild'
import { chmod, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// ---- Step 1: client パッケージの dist/index.js を読む
// なぜ Vite library mode の build 出力を読むか:
//   client パッケージは vp build (vite-plus-core) で IIFE bundle を packages/client/dist/index.js に
//   出力する。旧実装 (esbuild Step 1) を vite+ に置き換えることで、HMR / dev サーバを vite+ に統一する。
// require.resolve("@zeus/review-diff-client/package.json") は pnpm workspace 経由で
//   packages/client/package.json を直接指すので、dirname() + dist/index.js で絶対パスが取れる。
const clientPkg = require.resolve('@zeus/review-diff-client/package.json')
const clientDir = dirname(clientPkg)
const CLIENT_JS = await readFile(resolve(clientDir, 'dist/index.js'), 'utf8')
console.log(`client bundle: ${Buffer.byteLength(CLIENT_JS).toLocaleString()} bytes`)

// ---- Step 2: marked / DOMPurify を node_modules から読む
async function readLib(name, ...candidates) {
  for (const rel of candidates) {
    try {
      return await readFile(require.resolve(`${name}/${rel}`), 'utf8')
    } catch {
      /* try next */
    }
  }
  throw new Error(`Cannot find ${name} UMD (tried: ${candidates.join(', ')})`)
}
const MARKED_JS = await readLib(
  'marked',
  'marked.min.js',
  'lib/marked.umd.js',
  'lib/marked.umd.min.js',
  'lib/marked.cjs',
)
const DOMPURIFY_JS = await readLib(
  'dompurify',
  'dist/purify.min.js',
  'dist/purify.js',
)

// CSS は client パッケージの Vite build 出力 (dist/globals.css) を読む。
// なぜ src ではなく dist を読むか:
//   Tailwind v4 移行後、source CSS は @import "tailwindcss" + @theme + @layer の入力に変わった。
//   ブラウザに送るのは @tailwindcss/vite が tree-shake + 解決した最終 CSS で、これは dist/globals.css に出る。
//   vite.config.ts の rollupOptions.output.assetFileNames でファイル名を globals.css に固定済み。
//   不存在時は client build が走っていない (workspace build 順序の事故) ことを示すので fail-fast する。
const CSS_PATH = resolve(clientDir, 'dist/globals.css')
let CSS_STRING
try {
  CSS_STRING = await readFile(CSS_PATH, 'utf8')
} catch (err) {
  throw new Error(
    `${CSS_PATH} not found. client パッケージの build が先に走っている必要があります ` +
      `(pnpm --filter @zeus/review-diff-client build を実行してください)。元エラー: ${err.message}`,
  )
}

// ---- Step 3: cli.ts を CJS bundle。conditions に "@zeus/source" を渡し、
//                shared/server の TS ソースを直接食わせる (build 不要構成)
await build({
  entryPoints: [resolve(__dirname, 'src/cli.ts')],
  outfile: resolve(__dirname, 'dist/cli.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  // esbuild は package.json の exports conditions を解釈する。"@zeus/source" を最優先 condition に
  // 入れることで packages/shared/src/index.ts と packages/server/src/index.ts を TS のまま resolve できる。
  conditions: ['@zeus/source', 'node', 'import', 'default'],
  define: {
    __MARKED_JS__: JSON.stringify(MARKED_JS),
    __DOMPURIFY_JS__: JSON.stringify(DOMPURIFY_JS),
    __CLIENT_JS__: JSON.stringify(CLIENT_JS),
    __CSS_STRING__: JSON.stringify(CSS_STRING),
  },
})
await chmod(resolve(__dirname, 'dist/cli.js'), 0o755)

// dist/package.json は esbuild 出力が CJS のため必須。type: "commonjs" を明示。
await writeFile(
  resolve(__dirname, 'dist/package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
)

// ---- 配布物互換維持: ルートの dist/cli.js に複製
// なぜ複製するか:
//   SKILL.md は plugins/zeus/scripts/review-diff/dist/cli.js を literal path で参照する。
//   monorepo 化後の実体は packages/cli/dist/cli.js だが、SKILL.md を変えずにパス互換を保つため、
//   build 末尾で旧パスへ cp する。.gitattributes (eol=lf) も既存通り。
const rootDist = resolve(__dirname, '../../dist')
await mkdir(rootDist, { recursive: true })
await copyFile(resolve(__dirname, 'dist/cli.js'), resolve(rootDist, 'cli.js'))
await copyFile(resolve(__dirname, 'dist/package.json'), resolve(rootDist, 'package.json'))
await chmod(resolve(rootDist, 'cli.js'), 0o755)

const cliBytes = (await readFile(resolve(__dirname, 'dist/cli.js'))).length
console.log(`built dist/cli.js: ${cliBytes.toLocaleString()} bytes (copied to ${rootDist}/cli.js)`)
