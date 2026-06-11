// server と client で environment が違う (node / happy-dom) ため test.projects で分離する。
//
// なぜ resolve.conditions に "@zeus/source" を入れるか:
//   workspace の shared/server は package.json exports に "@zeus/source": "./src/index.ts"
//   を置いており、Vitest にもこの condition を通知しないと TS ソースを直接食えない。
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  test: {
    projects: [
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
    ],
  },
})
