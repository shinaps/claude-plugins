// listActiveSessions / reconcileSessions の純関数テスト。
// fs / process は SessionScannerDeps 経由で差し替え可能なので副作用ゼロで検証する。

import { test, expect, vi } from 'vitest'
import type { EventSource as ESType } from 'eventsource'
import {
  listActiveSessions,
  reconcileSessions,
  type SessionEnv,
  type SessionMap,
} from '@zeus/review-diff-channel'

const sample = (id: string, pid: number): SessionEnv => ({
  sessionId: id,
  pid,
  hubUrl: 'http://127.0.0.1:9999',
  browserToken: 'b',
  channelToken: 'c',
  createdAt: 1,
})

test('listActiveSessions: 生存 session を返し、死亡 session は unlink + reaped 配列に入れる', () => {
  const aliveEnv = sample('alive', 100)
  const deadEnv = sample('dead', 200)
  const fs: Record<string, SessionEnv> = {
    '/active/alive.json': aliveEnv,
    '/active/dead.json': deadEnv,
  }
  const unlinkSpy = vi.fn((p: string) => { delete fs[p] })

  const { alive, reaped } = listActiveSessions({
    activeDir: '/active',
    readdir: () => Object.keys(fs).map(p => p.replace('/active/', '')),
    readJson: (p) => fs[p],
    unlink: unlinkSpy,
    isAlive: (pid) => pid === 100, // 100 は生存、200 は死亡
    log: () => { /* noop */ },
  })

  expect(alive.map(e => e.sessionId)).toEqual(['alive'])
  expect(reaped).toEqual(['dead'])
  expect(unlinkSpy).toHaveBeenCalledWith('/active/dead.json')
})

test('listActiveSessions: 隠しファイル (.tmp) と非 .json はスキップ', () => {
  const fs: Record<string, SessionEnv> = {
    '/active/x.json': sample('x', 100),
  }
  const { alive } = listActiveSessions({
    activeDir: '/active',
    readdir: () => ['.x.json.tmp', 'README.md', 'x.json'],
    readJson: (p) => fs[p],
    unlink: () => { /* noop */ },
    isAlive: () => true,
    log: () => { /* noop */ },
  })
  expect(alive.map(e => e.sessionId)).toEqual(['x'])
})

test('listActiveSessions: malformed JSON は skip、生存 session は残る', () => {
  const aliveEnv = sample('ok', 100)
  const { alive, reaped } = listActiveSessions({
    activeDir: '/active',
    readdir: () => ['bad.json', 'ok.json'],
    readJson: (p) => {
      if (p === '/active/bad.json') throw new Error('parse')
      return aliveEnv
    },
    unlink: () => { /* noop */ },
    isAlive: () => true,
    log: () => { /* noop */ },
  })
  expect(alive.map(e => e.sessionId)).toEqual(['ok'])
  expect(reaped).toEqual([])
})

test('reconcileSessions: 新規 session に SSE 接続、消えた session は close + delete', () => {
  const map: SessionMap = new Map()
  const closed: string[] = []
  const makeEventSource = (url: string) => {
    return {
      url,
      addEventListener: vi.fn(),
      close: vi.fn(() => { closed.push(url) }),
      onerror: null,
    } as unknown as ESType
  }
  // 初回: a 追加
  reconcileSessions({
    sessionMap: map,
    alive: [sample('a', 1)],
    onFeedback: () => { /* noop */ },
    makeEventSource,
  })
  expect(map.size).toBe(1)
  expect(map.has('a')).toBe(true)

  // 2 回目: a 消滅、b 追加 → a の sse.close が呼ばれ、b の SSE が作られる
  reconcileSessions({
    sessionMap: map,
    alive: [sample('b', 2)],
    onFeedback: () => { /* noop */ },
    makeEventSource,
  })
  expect(map.size).toBe(1)
  expect(map.has('b')).toBe(true)
  expect(map.has('a')).toBe(false)
  expect(closed.length).toBe(1)
})
