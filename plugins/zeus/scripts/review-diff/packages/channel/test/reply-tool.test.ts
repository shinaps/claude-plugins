// performReply: reply tool handler の純関数検証。
// mock fetch を差し込んで /channel/inbox への POST が正しい形 (URL + token + body) で
// 行われることを担保する。

import { test, expect, vi } from 'vitest'
import { performReply, type SessionEnv } from '@zeus/review-diff-channel'

const env: SessionEnv = {
  sessionId: 'sess-1',
  pid: 123,
  hubUrl: 'http://127.0.0.1:9999',
  browserToken: 'b',
  channelToken: 'ctok',
  createdAt: 1,
}

test('valid args → POST /channel/inbox?token=<channelToken> with {groupId, panels}', async () => {
  const fakeFetch = vi.fn(async () => new Response('{}', { status: 200 }))
  const sessions = new Map([[env.sessionId, env]])
  const r = await performReply(
    { sessionId: 'sess-1', groupId: 'g-2', panels: [{ panelId: 'p', intent: 'i' }] },
    sessions,
    fakeFetch as unknown as typeof fetch,
  )
  expect(r.ok).toBe(true)
  expect(fakeFetch).toHaveBeenCalledTimes(1)
  const [url, init] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('http://127.0.0.1:9999/channel/inbox?token=ctok')
  expect(init.method).toBe('POST')
  expect(JSON.parse(init.body as string)).toEqual({
    groupId: 'g-2',
    panels: [{ panelId: 'p', intent: 'i' }],
  })
})

test('unknown session → ok=true but discard message (stale notification 互換)', async () => {
  const fakeFetch = vi.fn(async () => new Response('{}', { status: 200 }))
  const r = await performReply(
    { sessionId: 'gone', groupId: 'g', panels: [] },
    new Map(),
    fakeFetch as unknown as typeof fetch,
  )
  expect(r.ok).toBe(true)
  expect((r as { text: string }).text).toContain('not active')
  expect(fakeFetch).not.toHaveBeenCalled()
})

test('invalid args (sessionId not string) → ok=false', async () => {
  const r = await performReply(
    { sessionId: 123, groupId: 'g', panels: [] },
    new Map(),
    (async () => new Response('')) as unknown as typeof fetch,
  )
  expect(r.ok).toBe(false)
})

test('panels not array → ok=false', async () => {
  const r = await performReply(
    { sessionId: 's', groupId: 'g', panels: 'oops' },
    new Map([[env.sessionId, env]]),
    (async () => new Response('')) as unknown as typeof fetch,
  )
  expect(r.ok).toBe(false)
})

test('hub returns non-2xx → ok=false with status in message', async () => {
  const fakeFetch = vi.fn(async () => new Response('boom', { status: 503 }))
  const r = await performReply(
    { sessionId: 'sess-1', groupId: 'g', panels: [] },
    new Map([[env.sessionId, env]]),
    fakeFetch as unknown as typeof fetch,
  )
  expect(r.ok).toBe(false)
  expect((r as { text: string }).text).toContain('503')
})
