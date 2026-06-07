// useChannelSSE: 5 状態遷移 / 連打防止 / 30 秒 timeout / orphan draft purge を検証。
// EventSource / fetch / setTimeout / sessionStorage を全て注入で差し替える。

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useChannelSSE, purgeOrphanDrafts } from '../src/useChannelSSE'

type Listener = (e: Event) => void

class MockEventSource {
  public listeners = new Map<string, Set<Listener>>()
  public closed = false
  constructor(public url: string) {}
  addEventListener(type: string, l: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(l)
  }
  removeEventListener(type: string, l: Listener) {
    this.listeners.get(type)?.delete(l)
  }
  close() { this.closed = true }
  fire(type: string, data?: unknown) {
    const evt = data != null
      ? new MessageEvent(type, { data: typeof data === 'string' ? data : JSON.stringify(data) })
      : new Event(type)
    this.listeners.get(type)?.forEach(l => l(evt))
  }
}

describe('useChannelSSE', () => {
  beforeEach(() => {
    try { sessionStorage.clear() } catch { /* noop */ }
  })

  test('enabled=false → status=disabled、EventSource は生成されない', () => {
    const makeEventSource = vi.fn() as unknown as (u: string) => EventSource
    const { result } = renderHook(() => useChannelSSE({
      enabled: false,
      browserToken: 't', sessionId: 's',
      getPanelIdsForGroup: () => new Set(),
      onPanelsUpdated: () => { /* noop */ },
    }, { makeEventSource }))
    expect(result.current.status).toBe('disabled')
    expect(makeEventSource).not.toHaveBeenCalled()
  })

  test('enabled=true → 初期 connecting、open イベントで open に遷移', () => {
    const sources: MockEventSource[] = []
    const makeEventSource = (u: string) => {
      const s = new MockEventSource(u)
      sources.push(s)
      return s as unknown as EventSource
    }
    const { result } = renderHook(() => useChannelSSE({
      enabled: true,
      browserToken: 't', sessionId: 's',
      getPanelIdsForGroup: () => new Set(),
      onPanelsUpdated: () => { /* noop */ },
    }, { makeEventSource }))
    expect(result.current.status).toBe('connecting')
    act(() => { sources[0].fire('open') })
    expect(result.current.status).toBe('open')
  })

  test('error in open → reconnecting、error in connecting → closed', () => {
    const sources: MockEventSource[] = []
    const makeEventSource = (u: string) => {
      const s = new MockEventSource(u)
      sources.push(s)
      return s as unknown as EventSource
    }
    // open → error → reconnecting
    const { result } = renderHook(() => useChannelSSE({
      enabled: true, browserToken: 't', sessionId: 's',
      getPanelIdsForGroup: () => new Set(), onPanelsUpdated: () => { /* noop */ },
    }, { makeEventSource }))
    act(() => { sources[0].fire('open') })
    act(() => { sources[0].fire('error') })
    expect(result.current.status).toBe('reconnecting')

    // 別マウント: connecting → error → closed
    const { result: r2 } = renderHook(() => useChannelSSE({
      enabled: true, browserToken: 't', sessionId: 's2',
      getPanelIdsForGroup: () => new Set(), onPanelsUpdated: () => { /* noop */ },
    }, { makeEventSource }))
    expect(r2.current.status).toBe('connecting')
    act(() => { sources[1].fire('error') })
    expect(r2.current.status).toBe('closed')
  })

  test('panels-updated 受信 → onPanelsUpdated 発火 + pendingGroupId クリア + orphan draft purge', async () => {
    const sources: MockEventSource[] = []
    const makeEventSource = (u: string) => {
      const s = new MockEventSource(u)
      sources.push(s)
      return s as unknown as EventSource
    }
    const calls: Array<{ groupId: string; ids: string[] }> = []
    sessionStorage.setItem('draft:old1:asIs:5', 'orphan body')
    sessionStorage.setItem('draft:shared:toBe:1', 'keep me')
    sessionStorage.setItem('draft:new1:toBe:1', 'unknown panel, keep') // 旧 set にないので残す

    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const { result } = renderHook(() => useChannelSSE({
      enabled: true,
      browserToken: 't', sessionId: 's',
      // 受信 groupId='g1' に対応する旧 panel 集合のみを返す。
      getPanelIdsForGroup: (gid) => gid === 'g1' ? new Set(['old1', 'shared']) : new Set(),
      onPanelsUpdated: (groupId, panels) =>
        calls.push({ groupId, ids: panels.map(p => p.panelId) }),
    }, { makeEventSource, fetchImpl: fetchImpl as unknown as typeof fetch }))

    // pending を立てる
    await act(async () => {
      await result.current.sendFeedback('g1', 'more', [])
    })
    expect(result.current.pendingGroupId).toBe('g1')

    act(() => {
      sources[0].fire('panels-updated', { groupId: 'g1', panels: [{ panelId: 'shared' }, { panelId: 'new2' }] })
    })
    expect(calls).toEqual([{ groupId: 'g1', ids: ['shared', 'new2'] }])
    expect(result.current.pendingGroupId).toBe(null)
    // orphan draft purge: old1 は旧 set にあり新 set に居ないので削除、shared は両方にあるので残す
    expect(sessionStorage.getItem('draft:old1:asIs:5')).toBeNull()
    expect(sessionStorage.getItem('draft:shared:toBe:1')).toBe('keep me')
    // new1 は旧 set に居なかったので purge 対象外 (touch しない)
    expect(sessionStorage.getItem('draft:new1:toBe:1')).toBe('unknown panel, keep')
  })

  // C-1 回帰防止: 受信 groupId の旧 panel 集合**だけ**を purge 対象にする (他 group は touch しない)
  test('panels-updated 受信時、他 group の draft は purge しない (C-1 回帰防止)', async () => {
    const sources: MockEventSource[] = []
    const makeEventSource = (u: string) => {
      const s = new MockEventSource(u)
      sources.push(s)
      return s as unknown as EventSource
    }
    // G1 と G2 にそれぞれ panel + draft がある状態をシミュレート
    sessionStorage.setItem('draft:g1-old:asIs:5', 'g1 draft to purge')
    sessionStorage.setItem('draft:g2-keep:toBe:1', 'g2 draft MUST survive')
    sessionStorage.setItem('draft:g2-other:asIs:7:9', 'g2 range draft MUST survive')

    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const { result } = renderHook(() => useChannelSSE({
      enabled: true,
      browserToken: 't', sessionId: 's',
      // G1 だけ {g1-old} を旧として返す。G2 の旧 panel 集合は触らない。
      getPanelIdsForGroup: (gid) => gid === 'g1' ? new Set(['g1-old']) : new Set(),
      onPanelsUpdated: () => { /* noop */ },
    }, { makeEventSource, fetchImpl: fetchImpl as unknown as typeof fetch }))

    await act(async () => { await result.current.sendFeedback('g1', 'more', []) })
    // G1 の panels-updated を受信 (g1-old は新 set に居ない → purge 対象)
    act(() => {
      sources[0].fire('panels-updated', { groupId: 'g1', panels: [{ panelId: 'g1-new' }] })
    })
    expect(sessionStorage.getItem('draft:g1-old:asIs:5')).toBeNull()
    // **重要**: G2 の draft は触らない (旧実装は全 group flatten で巻き添えに消した)
    expect(sessionStorage.getItem('draft:g2-keep:toBe:1')).toBe('g2 draft MUST survive')
    expect(sessionStorage.getItem('draft:g2-other:asIs:7:9')).toBe('g2 range draft MUST survive')
  })

  test('sendFeedback 連打: pending 中の 2 回目は no-op (fetch が 1 回だけ)', async () => {
    const makeEventSource = (u: string) => new MockEventSource(u) as unknown as EventSource
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const { result } = renderHook(() => useChannelSSE({
      enabled: true, browserToken: 't', sessionId: 's',
      getPanelIdsForGroup: () => new Set(),
      onPanelsUpdated: () => { /* noop */ },
    }, { makeEventSource, fetchImpl: fetchImpl as unknown as typeof fetch }))

    await act(async () => {
      await result.current.sendFeedback('g1', 'more', [])
    })
    await act(async () => {
      await result.current.sendFeedback('g1', 'more', [])
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('30 秒 timeout: panels-updated 来ないと pendingGroupId が解除されて closed に', async () => {
    const sources: MockEventSource[] = []
    const makeEventSource = (u: string) => {
      const s = new MockEventSource(u)
      sources.push(s)
      return s as unknown as EventSource
    }
    let timeoutCb: (() => void) | null = null
    const setTimeoutImpl = ((cb: () => void, _ms: number) => {
      timeoutCb = cb
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    const clearTimeoutImpl = (() => { /* noop */ }) as unknown as typeof clearTimeout
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))

    const { result } = renderHook(() => useChannelSSE({
      enabled: true, browserToken: 't', sessionId: 's',
      getPanelIdsForGroup: () => new Set(),
      onPanelsUpdated: () => { /* noop */ },
    }, {
      makeEventSource,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setTimeoutImpl, clearTimeoutImpl,
    }))

    // open に遷移させてから sendFeedback。timeout 発火で closed に落ちる経路を確認。
    act(() => { sources[0].fire('open') })
    await act(async () => { await result.current.sendFeedback('g1', 'more', []) })
    expect(result.current.pendingGroupId).toBe('g1')
    expect(timeoutCb).not.toBeNull()

    act(() => { timeoutCb!() })
    expect(result.current.pendingGroupId).toBe(null)
    expect(result.current.status).toBe('closed')
  })
})

describe('purgeOrphanDrafts', () => {
  beforeEach(() => {
    try { sessionStorage.clear() } catch { /* noop */ }
  })

  test('oldIds にあり newIds に無い panelId の draft を消す', () => {
    sessionStorage.setItem('draft:p1:asIs:5', 'a')
    sessionStorage.setItem('draft:p1:toBe:10:12', 'b') // 範囲 key
    sessionStorage.setItem('draft:p2:toBe:1', 'c')
    sessionStorage.setItem('not-a-draft:p1:foo', 'd') // prefix 違い → 触らない

    purgeOrphanDrafts(new Set(['p1', 'p2']), new Set(['p2']))
    expect(sessionStorage.getItem('draft:p1:asIs:5')).toBeNull()
    expect(sessionStorage.getItem('draft:p1:toBe:10:12')).toBeNull()
    expect(sessionStorage.getItem('draft:p2:toBe:1')).toBe('c')
    expect(sessionStorage.getItem('not-a-draft:p1:foo')).toBe('d')
  })
})
