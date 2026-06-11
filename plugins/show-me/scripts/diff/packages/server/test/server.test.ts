// server.ts (Hono) のテスト。
// listen 不要なものは createTestApp + app.fetch() で書く (高速、ポート衝突無し)。
// 実 port (port 0) + serve() の経路は startServer 経由の e2e を 1 件残す。
//
// POST /result で decision='regen-group' を受け取れることを確認する e2e を 1 件含む。
// (Channels インフラ (/feedback, /events/*, /channel/inbox) は廃止済みなので関連テストは無い。)

import { test, expect } from 'vitest'
import { createTestApp, startServer } from '@show-me/diff-server'

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
      body: JSON.stringify({ decision: 'submit', groupDecisions: {} }),
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
    body: JSON.stringify({
      decision: 'submit',
      groupDecisions: { g0: 'approved' },
    }),
  })
  expect(post.status).toBe(200)
  const result = await started.waitResult()
  expect(result.decision).toBe('submit')
  expect(result.groupDecisions).toEqual({ g0: 'approved' })
})

// POST /result で decision='regen-group' を素通しで受け取れることを確認する。
// server 側は decision の値に依らず ResultJson を resolve するだけなので、shape の
// passthrough と CLI 側で分岐できることを担保するためのテスト。
test('POST /result with decision=regen-group passes through to waitResult', async () => {
  const started = await startServer({ html: '' })
  const u = new URL(started.url)
  const token = u.searchParams.get('token')!
  const origin = `${u.protocol}//${u.host}`
  const body = {
    decision: 'regen-group',
    groupDecisions: { g0: 'approved', g1: 'request-changes' },
    regenGroup: {
      groupId: 'g2',
      currentRanges: [
        { panelId: 'p1', toBe: { file: 'a.ts', ranges: [{ start: 1, end: 10 }] } },
      ],
    },
    lineCommentDrafts: { 'draft:p1:asis:5': 'draft body' },
  }
  const post = await fetch(`${origin}/result?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  })
  expect(post.status).toBe(200)
  const result = await started.waitResult()
  expect(result.decision).toBe('regen-group')
  expect(result.groupDecisions).toEqual({ g0: 'approved', g1: 'request-changes' })
  expect(result.regenGroup?.groupId).toBe('g2')
  expect(result.lineCommentDrafts?.['draft:p1:asis:5']).toBe('draft body')
})
