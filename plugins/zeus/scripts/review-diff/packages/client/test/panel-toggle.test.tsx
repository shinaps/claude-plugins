// usePanelToggle: 初期 split / toggle 往復 / localStorage 永続化 / panelId 独立性 を検証。

import { describe, test, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePanelToggle } from '../src/usePanelToggle'

describe('usePanelToggle', () => {
  beforeEach(() => {
    try { localStorage.clear() } catch { /* noop */ }
  })

  test('初期 mode は split', () => {
    const { result } = renderHook(() => usePanelToggle('p1'))
    expect(result.current.mode).toBe('split')
  })

  test('toggle で split ↔ unified を往復する', () => {
    const { result } = renderHook(() => usePanelToggle('p1'))
    act(() => { result.current.toggle() })
    expect(result.current.mode).toBe('unified')
    act(() => { result.current.toggle() })
    expect(result.current.mode).toBe('split')
  })

  test('toggle 後の値は localStorage の panel-mode:<panelId> に保存される', () => {
    const { result } = renderHook(() => usePanelToggle('p1'))
    act(() => { result.current.toggle() })
    expect(localStorage.getItem('panel-mode:p1')).toBe('unified')
    // 新規 hook (= 再マウント) で読み戻すと unified が復元される
    const { result: r2 } = renderHook(() => usePanelToggle('p1'))
    expect(r2.current.mode).toBe('unified')
  })

  test('別 panelId は独立: p1 を unified にしても p2 は split のまま', () => {
    const { result: r1 } = renderHook(() => usePanelToggle('p1'))
    act(() => { r1.current.toggle() })
    const { result: r2 } = renderHook(() => usePanelToggle('p2'))
    expect(r1.current.mode).toBe('unified')
    expect(r2.current.mode).toBe('split')
  })
})
