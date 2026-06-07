import { test, expect } from 'vitest'
import { EventBus } from '@zeus/review-diff-server'

test('1. subscribe/publish basic delivery', () => {
  const bus = new EventBus()
  const got: string[] = []
  bus.subscribe('panels-updated', e => got.push(e.groupId))
  bus.publish('panels-updated', { groupId: 'g1', panels: [] })
  bus.publish('panels-updated', { groupId: 'g2', panels: [] })
  expect(got).toEqual(['g1', 'g2'])
})

test('2. unsubscribe stops delivery', () => {
  const bus = new EventBus()
  const got: string[] = []
  const unsub = bus.subscribe('panels-updated', e => got.push(e.groupId))
  bus.publish('panels-updated', { groupId: 'g1', panels: [] })
  unsub()
  bus.publish('panels-updated', { groupId: 'g2', panels: [] })
  expect(got).toEqual(['g1'])
  expect(bus.size('panels-updated')).toBe(0)
})

test('3. throwing listener does not block other listeners', () => {
  const bus = new EventBus()
  const got: string[] = []
  bus.subscribe('feedback-sent', () => { throw new Error('boom') })
  bus.subscribe('feedback-sent', e => got.push(e.groupId))
  bus.publish('feedback-sent', {
    sessionId: 's', groupId: 'g1', direction: 'more', currentRanges: [],
  })
  expect(got).toEqual(['g1'])
})

test('4. cross-channel events are isolated', () => {
  // 'panels-updated' subscribe は 'feedback-sent' を受け取らない (種別キーで分離されている)。
  const bus = new EventBus()
  const got: string[] = []
  bus.subscribe('panels-updated', e => got.push('p:' + e.groupId))
  bus.publish('feedback-sent', {
    sessionId: 's', groupId: 'gx', direction: 'less', currentRanges: [],
  })
  expect(got).toEqual([])
  expect(bus.size('panels-updated')).toBe(1)
  expect(bus.size('feedback-sent')).toBe(0)
})
