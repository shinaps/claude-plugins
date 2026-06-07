#!/usr/bin/env node
// channel パッケージの build script。
//   1. esbuild で src/bin.ts を CJS bundle (MCP SDK + eventsource を含めて 1 ファイル化)
//   2. shebang #!/usr/bin/env node を先頭に付与
//   3. chmod 755 で実行可能にする
//   4. 親 review-diff/dist/ に channel-server.js としてコピー (cli.js と並ぶ位置)
//
// なぜ CJS bundle にするか:
//   Claude Code は --dangerously-load-development-channels から spawn する子プロセスとして
//   実行する想定。Node 18+ なら ESM でも動くが、CJS の方が `require()` 互換性が広く、
//   cli.js と build 仕様 (CJS + shebang + dist/package.json type: commonjs) を揃えられる。

import { build } from 'esbuild'
import { chmod, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [resolve(__dirname, 'src/bin.ts')],
  outfile: resolve(__dirname, 'dist/channel-server.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  // 'diff' / 'parse-git-diff' / 'hono' / 'shiki' などは channel-server には不要なので bundle 対象外。
  // @modelcontextprotocol/sdk と eventsource は bundle に含める (Claude Code 環境への依存を減らす)。
  conditions: ['@zeus/source', 'node', 'import', 'default'],
})

await chmod(resolve(__dirname, 'dist/channel-server.js'), 0o755)

// dist/package.json は cli.js と同様 type: "commonjs" を明示しないと Node が ESM として扱おうとする。
await writeFile(
  resolve(__dirname, 'dist/package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
)

// 親 review-diff/dist/ にコピー: SKILL.md は単一の dist/ から cli.js / channel-server.js 双方を参照する。
const parentDist = resolve(__dirname, '../../dist')
await mkdir(parentDist, { recursive: true })
await copyFile(
  resolve(__dirname, 'dist/channel-server.js'),
  resolve(parentDist, 'channel-server.js'),
)
await chmod(resolve(parentDist, 'channel-server.js'), 0o755)

const { readFile } = await import('node:fs/promises')
const bytes = (await readFile(resolve(__dirname, 'dist/channel-server.js'))).length
console.log(`built dist/channel-server.js: ${bytes.toLocaleString()} bytes (copied to ${parentDist}/channel-server.js)`)
