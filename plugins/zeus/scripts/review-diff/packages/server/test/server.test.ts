// server.ts (Hono) のテスト。
// listen 不要なものは createTestApp + app.fetch() で書く (高速、ポート衝突無し)。
// 実 port (port 0) + serve() の経路は startServer 経由の e2e を 1 件残す。

import { test, expect } from 'vitest'
import { createTestApp, startServer } from '@zeus/review-diff-server'

test('rejects requests without token via app.fetch (Host OK, token missing)', async () => {
  const { app, port } = createTestApp({ html: '<p>hi</p>' })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/`, {
      headers: { Host: `127.0.0.1:${port}` },
    }),
  )
  expect(res.status).toBe(403)
})

test('serves HTML with valid token via app.fetch', async () => {
  const { app, token, port } = createTestApp({ html: '<p>hello-token-ok</p>' })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/?token=${token}`, {
      headers: { Host: `127.0.0.1:${port}` },
    }),
  )
  expect(res.status).toBe(200)
  // セキュリティヘッダが全部乗っているか確認 (代表 2 件)
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(res.headers.get('x-frame-options')).toBe('DENY')
  const text = await res.text()
  expect(text).toMatch(/hello-token-ok/)
})

test('POST /result without Origin header is rejected via app.fetch', async () => {
  const { app, token, port } = createTestApp({ html: '' })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/result?token=${token}`, {
      method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', reviewedPanels: [], comments: [] }),
    }),
  )
  expect(res.status).toBe(403)
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
  expect(ok.status).toBe(200)
  expect(await ok.text()).toBe('a\nx\nc')

  // 範囲外: 400
  const oob = await app.fetch(
    new Request(
      `http://127.0.0.1:${port}/source?token=${token}&path=foo.ts&side=after&start=1&end=99`,
      { headers: baseHeaders },
    ),
  )
  expect(oob.status).toBe(400)

  // 未登録 path: 404
  const nf = await app.fetch(
    new Request(
      `http://127.0.0.1:${port}/source?token=${token}&path=missing.ts&side=after&start=1&end=1`,
      { headers: baseHeaders },
    ),
  )
  expect(nf.status).toBe(404)
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
    body: JSON.stringify({ decision: 'approve', reviewedPanels: ['p1'], comments: [] }),
  })
  expect(post.status).toBe(200)
  const result = await started.waitResult()
  expect(result.decision).toBe('approve')
  expect(result.reviewedPanels).toEqual(['p1'])
})

// ============================================================
// v4.7.0 Channels endpoint テスト
// ============================================================

test('/feedback POST: channelsEnabled=false → 503', async () => {
  const { app, browserToken, port } = createTestApp({ html: '' })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/feedback?token=${browserToken}`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 's', groupId: 'g', direction: 'more', currentRanges: [] }),
    }),
  )
  expect(res.status).toBe(503)
})

test('/feedback POST: with channelsEnabled=true publishes feedback-sent to eventBus', async () => {
  const { app, browserToken, port, eventBus } = createTestApp({ html: '', channelsEnabled: true })
  const received: string[] = []
  eventBus.subscribe('feedback-sent', e =>
    received.push(`${e.sessionId}:${e.groupId}:${e.direction}`),
  )

  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/feedback?token=${browserToken}`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 's1', groupId: 'g1', direction: 'more', currentRanges: [] }),
    }),
  )
  expect(res.status).toBe(200)
  expect(received).toEqual(['s1:g1:more'])
})

test('/feedback POST without Origin → 403 (CSRF)', async () => {
  const { app, browserToken, port } = createTestApp({ html: '', channelsEnabled: true })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/feedback?token=${browserToken}`, {
      method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', groupId: 'g', direction: 'more', currentRanges: [] }),
    }),
  )
  expect(res.status).toBe(403)
})

test('/feedback POST with bad direction → 400', async () => {
  const { app, browserToken, port } = createTestApp({ html: '', channelsEnabled: true })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/feedback?token=${browserToken}`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 's', groupId: 'g', direction: 'sideways', currentRanges: [] }),
    }),
  )
  expect(res.status).toBe(400)
})

test('/channel/inbox POST: channelsEnabled=false → 503', async () => {
  const { app, channelToken, port } = createTestApp({ html: '' })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/channel/inbox?token=${channelToken}`, {
      method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: 'g', panels: [] }),
    }),
  )
  expect(res.status).toBe(503)
})

test('/channel/inbox POST: with channelsEnabled=true publishes panels-updated to eventBus', async () => {
  const { app, channelToken, port, eventBus } = createTestApp({ html: '', channelsEnabled: true })
  const got: string[] = []
  eventBus.subscribe('panels-updated', e => got.push(e.groupId))
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/channel/inbox?token=${channelToken}`, {
      method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: 'g7', panels: [] }),
    }),
  )
  expect(res.status).toBe(200)
  expect(got).toEqual(['g7'])
})

// ============================================================
// Cross-token negative tests (token check 漏れの担保):
//   - browser endpoint に channelToken を投げると 403
//   - channel endpoint に browserToken を投げると 403
// ユーザー指示で明示要求された境界 (Checkpoint 3)。
// ============================================================

test('/feedback with channelToken (cross-token) → 403', async () => {
  const { app, channelToken, port } = createTestApp({ html: '', channelsEnabled: true })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/feedback?token=${channelToken}`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId: 's', groupId: 'g', direction: 'more', currentRanges: [] }),
    }),
  )
  expect(res.status).toBe(403)
})

test('/channel/inbox with browserToken (cross-token) → 403', async () => {
  const { app, browserToken, port } = createTestApp({ html: '', channelsEnabled: true })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/channel/inbox?token=${browserToken}`, {
      method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: 'g', panels: [] }),
    }),
  )
  expect(res.status).toBe(403)
})

test('/events/browser with channelToken (cross-token) → 403', async () => {
  const { app, channelToken, port } = createTestApp({ html: '', channelsEnabled: true })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/events/browser?token=${channelToken}`, {
      headers: { Host: `127.0.0.1:${port}` },
    }),
  )
  expect(res.status).toBe(403)
})

test('/events/channel with browserToken (cross-token) → 403', async () => {
  const { app, browserToken, port } = createTestApp({ html: '', channelsEnabled: true })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/events/channel?token=${browserToken}`, {
      headers: { Host: `127.0.0.1:${port}` },
    }),
  )
  expect(res.status).toBe(403)
})

test('/events/browser with channelsEnabled=false → 503', async () => {
  const { app, browserToken, port } = createTestApp({ html: '' })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/events/browser?token=${browserToken}`, {
      headers: { Host: `127.0.0.1:${port}` },
    }),
  )
  expect(res.status).toBe(503)
})

test('/events/channel with channelsEnabled=false → 503', async () => {
  const { app, channelToken, port } = createTestApp({ html: '' })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/events/channel?token=${channelToken}`, {
      headers: { Host: `127.0.0.1:${port}` },
    }),
  )
  expect(res.status).toBe(503)
})

// /events/browser の SSE が確立して 'open' event を吐き、その後 panels-updated が流れることを
// 1 ケースだけ e2e で確認する (Hono streamSSE + abort 経路の sanity check)。
test('/events/browser SSE: opens then delivers panels-updated (e2e via startServer)', async () => {
  const started = await startServer({ html: '', channelsEnabled: true })
  try {
    const ctrl = new AbortController()
    const res = await fetch(
      `http://127.0.0.1:${started.port}/events/browser?token=${started.browserToken}`,
      { signal: ctrl.signal },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/event-stream/)

    // publish 後に SSE chunk が流れてくるのを最大 2 秒で待つ
    started.eventBus.publish('panels-updated', { groupId: 'gx', panels: [] })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const deadline = Date.now() + 2000
    let sawPanelsUpdated = false
    while (Date.now() < deadline && !sawPanelsUpdated) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value)
      if (buf.includes('event: panels-updated')) sawPanelsUpdated = true
    }
    expect(sawPanelsUpdated).toBe(true)
    ctrl.abort()
  } finally {
    started.close()
  }
})
