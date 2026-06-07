// channel-server.js のエントリポイント。esbuild が bundle してから dist/channel-server.js を生成し、
// build.mjs が shebang を付与 + chmod 755 + 親 dist にコピーする。
//
// Claude Code から:
//   claude --dangerously-load-development-channels server:review-diff:/path/to/channel-server.js
// のように渡される想定。

import { runMcpServer } from './mcp-server'

runMcpServer().catch((e: unknown) => {
  process.stderr.write(`[channel-server] fatal: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
