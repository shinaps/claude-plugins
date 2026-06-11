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

// ===== remote モード (tunnel host 許可 + brute force 閾値) =====

const TUNNEL_HOST = 'example-tunnel.trycloudflare.com'

test('remote: tunnel host is allowed for Host check once injected', async () => {
  const { app, token, port } = createTestApp({
    html: '<p>remote-ok</p>',
    remote: true,
    tunnelHost: TUNNEL_HOST,
  })
  const res = await app.fetch(
    new Request(`https://${TUNNEL_HOST}/?token=${token}`, {
      headers: { Host: TUNNEL_HOST },
    }),
  )
  expect(res.status).toBe(200)
  expect(await res.text()).toMatch(/remote-ok/)

  // local URL も並行して許可されたまま (追加であって切替ではない)
  const local = await app.fetch(
    new Request(`http://127.0.0.1:${port}/?token=${token}`, {
      headers: { Host: `127.0.0.1:${port}` },
    }),
  )
  expect(local.status).toBe(200)

  // tunnel host 以外の外部ホストは依然 403
  const evil = await app.fetch(
    new Request(`https://evil.example.com/?token=${token}`, {
      headers: { Host: 'evil.example.com' },
    }),
  )
  expect(evil.status).toBe(403)
})

test('remote: tunnel host is rejected before injection (lazy opt-in)', async () => {
  const { app, token, setTunnelHost } = createTestApp({ html: '', remote: true })
  const before = await app.fetch(
    new Request(`https://${TUNNEL_HOST}/?token=${token}`, {
      headers: { Host: TUNNEL_HOST },
    }),
  )
  expect(before.status).toBe(403)

  setTunnelHost(TUNNEL_HOST)
  const after = await app.fetch(
    new Request(`https://${TUNNEL_HOST}/?token=${token}`, {
      headers: { Host: TUNNEL_HOST },
    }),
  )
  expect(after.status).toBe(200)
})

test('non-remote: tunnel host stays rejected (no regression of local-only contract)', async () => {
  const { app, token } = createTestApp({ html: '' })
  const res = await app.fetch(
    new Request(`https://${TUNNEL_HOST}/?token=${token}`, {
      headers: { Host: TUNNEL_HOST },
    }),
  )
  expect(res.status).toBe(403)
})

test('remote: POST /result accepts https tunnel Origin, rejects http tunnel Origin', async () => {
  const { app, token } = createTestApp({
    html: '',
    remote: true,
    tunnelHost: TUNNEL_HOST,
  })
  const post = (origin: string) =>
    app.fetch(
      new Request(`https://${TUNNEL_HOST}/result?token=${token}`, {
        method: 'POST',
        headers: {
          Host: TUNNEL_HOST,
          'Content-Type': 'application/json',
          Origin: origin,
        },
        body: JSON.stringify({ decision: 'submit', groupDecisions: {} }),
      }),
    )
  expect((await post(`https://${TUNNEL_HOST}`)).status).toBe(200)
  // Cloudflare は TLS 終端するので tunnel 経由の Origin は https のみ正当。http は弾く
  expect((await post(`http://${TUNNEL_HOST}`)).status).toBe(403)
})

test('non-remote: Origin "https://null" never passes when tunnel host is unset', async () => {
  const { app, token, port } = createTestApp({ html: '' })
  const res = await app.fetch(
    new Request(`http://127.0.0.1:${port}/result?token=${token}`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
        Origin: 'https://null',
      },
      body: JSON.stringify({ decision: 'submit', groupDecisions: {} }),
    }),
  )
  expect(res.status).toBe(403)
})

test('brute force threshold: local fires at 20, remote survives 21 and fires at 1000', async () => {
  // local: 20 回の token 失敗で onBruteForce 発火
  let localFired = 0
  const local = createTestApp({ html: '', onBruteForce: () => { localFired++ } })
  for (let i = 0; i < 20; i++) {
    await local.app.fetch(
      new Request(`http://127.0.0.1:${local.port}/?token=wrong`, {
        headers: { Host: `127.0.0.1:${local.port}` },
      }),
    )
  }
  expect(localFired).toBeGreaterThanOrEqual(1)

  // remote: 21 回では発火せず、1000 回で発火 (公開 URL のクローラー誤爆を防ぐ緩和)
  let remoteFired = 0
  const remote = createTestApp({
    html: '',
    remote: true,
    tunnelHost: TUNNEL_HOST,
    onBruteForce: () => { remoteFired++ },
  })
  for (let i = 0; i < 21; i++) {
    await remote.app.fetch(
      new Request(`https://${TUNNEL_HOST}/?token=wrong`, {
        headers: { Host: TUNNEL_HOST },
      }),
    )
  }
  expect(remoteFired).toBe(0)
  for (let i = 0; i < 979; i++) {
    await remote.app.fetch(
      new Request(`https://${TUNNEL_HOST}/?token=wrong`, {
        headers: { Host: TUNNEL_HOST },
      }),
    )
  }
  expect(remoteFired).toBeGreaterThanOrEqual(1)
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
