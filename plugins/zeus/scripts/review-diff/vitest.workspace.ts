// なぜ vitest.workspace.ts を別ファイルにするか:
//   Vitest 2.1 系では `test.projects` フィールドが未サポート。projects 分割は
//   vitest.workspace.{ts,js} の自動検出を使う (3.x で test.projects に統合される)。
//   server と client で environment が違う (node / happy-dom) ため、ここで分離する。
//
// なぜ resolve.conditions に "@zeus/source" を入れるか:
//   workspace の shared/server は package.json exports に "@zeus/source": "./src/index.ts"
//   を置いており、Vitest にもこの condition を通知しないと TS ソースを直接食えない。
import { defineWorkspace } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineWorkspace([
  {
    resolve: { conditions: ['@zeus/source'] },
    test: {
      name: 'server',
      environment: 'node',
      include: [
        'packages/server/test/**/*.test.ts',
        'packages/shared/test/**/*.test.ts',
        'packages/cli/test/**/*.test.ts',
      ],
    },
  },
  {
    plugins: [react()],
    resolve: { conditions: ['@zeus/source'] },
    test: {
      name: 'client',
      environment: 'happy-dom',
      globals: true,
      setupFiles: ['packages/client/test/setup-react.ts'],
      include: ['packages/client/test/**/*.test.{ts,tsx}'],
    },
  },
])
