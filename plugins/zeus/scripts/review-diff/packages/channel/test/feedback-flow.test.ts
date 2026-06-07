// buildNotificationFromFeedback: SSE event.data → mcp.notification mapping の純関数検証。

import { test, expect } from 'vitest'
import { buildNotificationFromFeedback, type SessionEnv } from '@zeus/review-diff-channel'

const env: SessionEnv = {
  sessionId: 'sess-1',
  pid: 123,
  hubUrl: 'http://127.0.0.1:9999',
  browserToken: 'b',
  channelToken: 'c',
  createdAt: 1,
}

test('valid feedback payload → notification with meta + content', () => {
  const data = JSON.stringify({
    sessionId: 'sess-1',
    groupId: 'g-7',
    direction: 'more',
    currentRanges: [{ panelId: 'p1', toBe: { file: 'a.ts', ranges: [{ start: 1, end: 5 }] } }],
  })
  const n = buildNotificationFromFeedback(data, env)
  expect(n).not.toBeNull()
  expect(n!.method).toBe('notifications/claude/channel')
  expect(n!.params.meta.sessionId).toBe('sess-1')
  expect(n!.params.meta.groupId).toBe('g-7')
  expect(n!.params.meta.direction).toBe('more')
  expect(n!.params.meta.currentRanges).toEqual([
    { panelId: 'p1', toBe: { file: 'a.ts', ranges: [{ start: 1, end: 5 }] } },
  ])
  expect(n!.params.content).toContain('session_id="sess-1"')
  expect(n!.params.content).toContain('group_id="g-7"')
  expect(n!.params.content).toContain('direction="more"')
})

test('malformed JSON → null', () => {
  expect(buildNotificationFromFeedback('not json', env)).toBeNull()
})

test('bad direction → null', () => {
  const data = JSON.stringify({ groupId: 'g', direction: 'sideways', currentRanges: [] })
  expect(buildNotificationFromFeedback(data, env)).toBeNull()
})

test('missing groupId → null', () => {
  const data = JSON.stringify({ direction: 'less', currentRanges: [] })
  expect(buildNotificationFromFeedback(data, env)).toBeNull()
})

test('currentRanges missing → defaults to []', () => {
  const data = JSON.stringify({ groupId: 'g', direction: 'less' })
  const n = buildNotificationFromFeedback(data, env)
  expect(n).not.toBeNull()
  expect(n!.params.meta.currentRanges).toEqual([])
})
