// server.ts (Hono) のテスト。
// listen 不要なものは createTestApp + app.fetch() で書く (高速、ポート衝突無し)。
// 実 port (port 0) + serve() の経路は startServer 経由の e2e を 1 件残す。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestApp, startServer } from '../src/server-side/server.js'

test('rejects requests without token via app.fetch (Host OK, token missing)', async () => {
  const { app, port } = createTestApp({ html: '<p>hi</p>' })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/`, {
      headers: { Host: `127.0.0.1:${port}` },
    }),
  )
  assert.equal(res.status, 403)
})

test('serves HTML with valid token via app.fetch', async () => {
  const { app, token, port } = createTestApp({ html: '<p>hello-token-ok</p>' })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/?token=${token}`, {
      headers: { Host: `127.0.0.1:${port}` },
    }),
  )
  assert.equal(res.status, 200)
  // セキュリティヘッダが全部乗っているか確認 (代表 2 件)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  const text = await res.text()
  assert.match(text, /hello-token-ok/)
})

test('POST /result without Origin header is rejected via app.fetch', async () => {
  const { app, token, port } = createTestApp({ html: '' })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/result?token=${token}`, {
      method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', reviewedFiles: [], comments: [] }),
    }),
  )
  assert.equal(res.status, 403)
})

test('GET /source returns requested line range; 400/404 on bad input', async () => {
  const sources = new Map([
    ['foo.ts', { before: 'a\nb\nc', after: 'a\nx\nc' }],
  ])
  const { app, token, port } = createTestApp({ html: '', sources })
  const baseHeaders = { Host: `127.0.0.1:${port}` }

  // 正常系: after 側全行
  const ok = await app.fetch(
    new Request(
      `http://127.0.0.1:${port}/source?token=${token}&path=foo.ts&side=after&start=1&end=3`,
      { headers: baseHeaders },
    ),
  )
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), 'a\nx\nc')

  // 範囲外: 400
  const oob = await app.fetch(
    new Request(
      `http://127.0.0.1:${port}/source?token=${token}&path=foo.ts&side=after&start=1&end=99`,
      { headers: baseHeaders },
    ),
  )
  assert.equal(oob.status, 400)

  // 未登録 path: 404
  const nf = await app.fetch(
    new Request(
      `http://127.0.0.1:${port}/source?token=${token}&path=missing.ts&side=after&start=1&end=1`,
      { headers: baseHeaders },
    ),
  )
  assert.equal(nf.status, 404)
})

// e2e: 実際に listen → 実 port → fetch で POST → waitResult 解決まで一気通貫
test('POST /result with valid token + Origin resolves waitResult (e2e via serve)', async () => {
  const started = await startServer({ html: '' })
  const u = new URL(started.url)
  const token = u.searchParams.get('token')!
  const origin = `${u.protocol}//${u.host}`
  const post = await fetch(`${origin}/result?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ decision: 'approve', reviewedFiles: ['a.ts'], comments: [] }),
  })
  assert.equal(post.status, 200)
  const result = await started.waitResult()
  assert.equal(result.decision, 'approve')
  assert.deepEqual(result.reviewedFiles, ['a.ts'])
})
