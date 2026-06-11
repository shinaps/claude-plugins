// restore-state.ts の characterization test。
// v1 Comment → ThreadSnapshot migration の contract (scope 同型変換 / 初期 message /
// resolved=false / outdated=false / invalid 入力は null) を固定する。

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, afterAll } from 'vitest'
import { migrateCommentToThread, readRestoreState } from '../src/restore-state'

// ---- migrateCommentToThread: valid 入力 ----

test('line comment is migrated to a thread with initial user message', () => {
  const before = Date.now()
  const t = migrateCommentToThread({
    body: 'fix this line',
    scope: { type: 'line', panelId: 'p1', side: 'asIs', file: 'a.ts', line: 10 },
  })
  const after = Date.now()
  expect(t).not.toBeNull()
  expect(t!.scope).toEqual({ type: 'line', panelId: 'p1', side: 'asIs', file: 'a.ts', line: 10 })
  // endLine 未指定時はキー自体が現れない (restore.json の round-trip 表現を変えない)
  expect('endLine' in t!.scope).toBe(false)
  expect(t!.messages).toHaveLength(1)
  const m = t!.messages[0]
  expect(m.author).toBe('user')
  expect(m.body).toBe('fix this line')
  expect(typeof m.id).toBe('string')
  expect(m.id.length).toBeGreaterThan(0)
  expect(m.ts).toBeGreaterThanOrEqual(before)
  expect(m.ts).toBeLessThanOrEqual(after)
  expect(t!.resolved).toBe(false)
  expect(t!.outdated).toBe(false)
})

test('line comment with endLine keeps the range', () => {
  const t = migrateCommentToThread({
    body: 'range comment',
    scope: { type: 'line', panelId: 'p1', side: 'toBe', file: 'b.ts', line: 3, endLine: 7 },
  })
  expect(t!.scope).toEqual({ type: 'line', panelId: 'p1', side: 'toBe', file: 'b.ts', line: 3, endLine: 7 })
})

test('group comment is migrated with the same initial-thread shape', () => {
  const t = migrateCommentToThread({ body: 'group note', scope: { type: 'group', groupId: 'g1' } })
  expect(t!.scope).toEqual({ type: 'group', groupId: 'g1' })
  expect(t!.messages).toHaveLength(1)
  expect(t!.messages[0]).toMatchObject({ author: 'user', body: 'group note' })
  expect(t!.resolved).toBe(false)
  expect(t!.outdated).toBe(false)
})

test('file comment is migrated with the same initial-thread shape', () => {
  const t = migrateCommentToThread({ body: 'file note', scope: { type: 'file', file: 'src/x.ts' } })
  expect(t!.scope).toEqual({ type: 'file', file: 'src/x.ts' })
  expect(t!.messages).toHaveLength(1)
  expect(t!.messages[0]).toMatchObject({ author: 'user', body: 'file note' })
  expect(t!.resolved).toBe(false)
  expect(t!.outdated).toBe(false)
})

test('each migration generates a fresh message id', () => {
  const a = migrateCommentToThread({ body: 'x', scope: { type: 'group', groupId: 'g1' } })
  const b = migrateCommentToThread({ body: 'x', scope: { type: 'group', groupId: 'g1' } })
  expect(a!.messages[0].id).not.toBe(b!.messages[0].id)
})

// ---- migrateCommentToThread: invalid 入力は null ----

test('non-object / missing body / missing scope are rejected', () => {
  expect(migrateCommentToThread(null)).toBeNull()
  expect(migrateCommentToThread('str')).toBeNull()
  expect(migrateCommentToThread({ scope: { type: 'group', groupId: 'g' } })).toBeNull()
  expect(migrateCommentToThread({ body: 'x' })).toBeNull()
  expect(migrateCommentToThread({ body: 'x', scope: 'line' })).toBeNull()
})

test('line scope with invalid fields is rejected', () => {
  const base = { type: 'line', panelId: 'p1', side: 'asIs', file: 'a.ts', line: 1 }
  expect(migrateCommentToThread({ body: 'x', scope: { ...base, panelId: '' } })).toBeNull()
  expect(migrateCommentToThread({ body: 'x', scope: { ...base, side: 'left' } })).toBeNull()
  expect(migrateCommentToThread({ body: 'x', scope: { ...base, file: 1 } })).toBeNull()
  expect(migrateCommentToThread({ body: 'x', scope: { ...base, line: '1' } })).toBeNull()
})

test('empty groupId / empty file / unknown scope type are rejected', () => {
  expect(migrateCommentToThread({ body: 'x', scope: { type: 'group', groupId: '' } })).toBeNull()
  expect(migrateCommentToThread({ body: 'x', scope: { type: 'file', file: '' } })).toBeNull()
  expect(migrateCommentToThread({ body: 'x', scope: { type: 'review' } })).toBeNull()
})

// ---- readRestoreState: v1 → v2 wiring ----

const tmp = mkdtempSync(join(tmpdir(), 'restore-state-test-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

test('v1 restore.json comments[] are migrated into threads keyed by threadKey', () => {
  const p = join(tmp, 'v1.json')
  writeFileSync(p, JSON.stringify({
    groupDecisions: { g1: 'approved' },
    comments: [
      { body: 'a', scope: { type: 'group', groupId: 'g1' } },
      { body: 'b', scope: { type: 'file', file: 'src/x.ts' } },
      { body: 'broken', scope: { type: 'group', groupId: '' } },
    ],
  }))
  const out = readRestoreState(p)
  expect(out).toBeDefined()
  expect(out!.schemaVersion).toBe(2)
  expect(out!.groupDecisions).toEqual({ g1: 'approved' })
  expect(Object.keys(out!.threads ?? {}).sort()).toEqual(['file:src/x.ts', 'group:g1'])
  expect(out!.threads!['group:g1'].messages[0].body).toBe('a')
})

test('v2 threads win over v1 comments with the same key', () => {
  const p = join(tmp, 'mixed.json')
  writeFileSync(p, JSON.stringify({
    threads: {
      'group:g1': {
        scope: { type: 'group', groupId: 'g1' },
        messages: [{ id: 'fixed', author: 'user', body: 'from v2', ts: 123 }],
        resolved: true,
        outdated: false,
      },
    },
    comments: [{ body: 'from v1', scope: { type: 'group', groupId: 'g1' } }],
  }))
  const out = readRestoreState(p)
  expect(out!.threads!['group:g1'].messages[0].body).toBe('from v2')
  expect(out!.threads!['group:g1'].resolved).toBe(true)
})

// ---- readRestoreState: v2 経路の defensive validation ----

test('v2 threads with invalid scope are dropped, valid ones survive', () => {
  const p = join(tmp, 'v2-invalid-scope.json')
  writeFileSync(p, JSON.stringify({
    schemaVersion: 2,
    threads: {
      ok: {
        scope: { type: 'group', groupId: 'g1' },
        messages: [],
        resolved: false,
        outdated: false,
      },
      noType: { scope: { groupId: 'g1' }, messages: [], resolved: false, outdated: false },
      badSide: {
        scope: { type: 'line', panelId: 'p1', side: 'left', file: 'a.ts', line: 1 },
        messages: [],
        resolved: false,
        outdated: false,
      },
      unknownType: { scope: { type: 'mystery' }, messages: [], resolved: false, outdated: false },
    },
  }))
  const out = readRestoreState(p)
  expect(Object.keys(out!.threads ?? {})).toEqual(['ok'])
})

test('v2 review-scope thread is accepted (unlike v1 migration which rejects review)', () => {
  const p = join(tmp, 'v2-review.json')
  writeFileSync(p, JSON.stringify({
    schemaVersion: 2,
    threads: {
      review: {
        scope: { type: 'review' },
        messages: [{ id: 'm1', author: 'user', body: 'overall note', ts: 1 }],
        resolved: false,
        outdated: false,
      },
    },
  }))
  const out = readRestoreState(p)
  expect(out!.threads!['review'].scope).toEqual({ type: 'review' })
})

test('invalid agentAction is dropped while the message itself survives', () => {
  const p = join(tmp, 'v2-agent-action.json')
  writeFileSync(p, JSON.stringify({
    schemaVersion: 2,
    threads: {
      t: {
        scope: { type: 'group', groupId: 'g1' },
        messages: [
          { id: 'm1', author: 'agent', body: 'bad kind', ts: 1, agentAction: { kind: 'mystery' } },
          { id: 'm2', author: 'agent', body: 'bad files', ts: 2, agentAction: { kind: 'apply', files: 'oops' } },
          { id: 'm3', author: 'agent', body: 'good', ts: 3, agentAction: { kind: 'answer' } },
        ],
        resolved: false,
        outdated: false,
      },
    },
  }))
  const out = readRestoreState(p)
  const msgs = out!.threads!['t'].messages
  expect(msgs).toHaveLength(3)
  expect(msgs[0].agentAction).toBeUndefined()
  expect(msgs[1].agentAction).toBeUndefined()
  expect(msgs[2].agentAction).toEqual({ kind: 'answer' })
})

test('lineCommentDrafts survives only string values and rejects arrays', () => {
  const p1 = join(tmp, 'drafts-mixed.json')
  writeFileSync(p1, JSON.stringify({
    schemaVersion: 2,
    lineCommentDrafts: { a: 'keep', b: 42, c: null },
  }))
  expect(readRestoreState(p1)!.lineCommentDrafts).toEqual({ a: 'keep' })

  const p2 = join(tmp, 'drafts-array.json')
  writeFileSync(p2, JSON.stringify({ schemaVersion: 2, lineCommentDrafts: ['oops'] }))
  expect(readRestoreState(p2)!.lineCommentDrafts).toBeUndefined()
})
