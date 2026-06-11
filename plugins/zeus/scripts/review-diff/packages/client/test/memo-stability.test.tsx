// GroupSection → PanelBlock に渡る props の参照安定性の regression テスト。
//
// contract:
//   - group コメント textarea のキー入力 (= App の groupComments 更新) では、PanelBlock が
//     再 render されない。App が GroupSection に渡す callback (onSubmitComment / onRequestContext /
//     onJumpToPanel 等) がすべて安定参照であることに依存する不変条件で、どれか 1 つでも
//     inline arrow / deps に state を含む useCallback に戻ると全 group の memo が破れて
//     キーストロークごとに数万 SideRow の reconciliation が走る (過去に実測数百 ms 級)。
//   - 逆に threads の変化 (Comment ボタン) では PanelBlock の再 render が「起きる」こと。
//     行スレッド表示 (Panel.tsx CommentRow) の更新は「fileComments useMemo (deps: threads) の
//     参照変化が memo を破る」連鎖に依存しているため、誤って遮断すると返信が画面に出なくなる。
//
// 検証範囲の注意: PanelBlock は「render 回数を数える memo 化スタブ」に差し替えるため、
// このテストが検証するのは GroupSection → PanelBlock に渡る props の参照安定性のみ。
// 実 PanelBlock 内部の memo / useCallback (onExpand / onCollapse) はスタブに置換され対象外。
// スタブ自体を memo 化するのは、props が安定なら親 (GroupSection) の再 render に巻き込まれない
// 「本物と同じ memo 境界」を再現するため。

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, test, expect, beforeEach, vi } from 'vitest'
import type { ClientPayload, RenderedPanel } from '@zeus/review-diff-shared'
import { App } from '../src/App'

const { panelBlockSpy } = vi.hoisted(() => ({
  panelBlockSpy: vi.fn(() => null),
}))

vi.mock('../src/guide/PanelBlock', async () => {
  const { memo } = await import('react')
  return { PanelBlock: memo(panelBlockSpy) }
})

function makePanel(panelId = 'p1'): RenderedPanel {
  return {
    panelId,
    intent: 'intent: sample change',
    asIs: { file: 'src/foo.ts', ranges: [{ start: 1, end: 2 }] },
    toBe: { file: 'src/foo.ts', ranges: [{ start: 1, end: 2 }] },
    asIsLanguage: 'typescript',
    toBeLanguage: 'typescript',
    segments: [{
      asIsRange: { start: 1, end: 2 },
      toBeRange: { start: 1, end: 2 },
      rows: [
        { asIs: { type: 'context', line: 1, raw: 'const a = 1' }, toBe: { type: 'context', line: 1, raw: 'const a = 1' } },
        { asIs: { type: 'deletion', line: 2, raw: 'const b = 2' }, toBe: { type: 'addition', line: 2, raw: 'const b = 3' } },
      ],
    }],
  }
}

// 2 group とも panels 持ち: 「入力した group 以外の GroupSection も memo が保たれる」ことを
// 観測するため、PanelBlock を持つ group を複数置く。
function makePayload(): ClientPayload {
  const p1 = makePanel('p1')
  const p2 = makePanel('p2')
  return {
    schemaVersion: 1,
    summary: { schemaVersion: 1, mode: 'staged', pr: null, overallSummary: 'test summary', groups: [] },
    prMeta: null,
    project: { name: 'test-project', branch: 'main' },
    groups: [
      { groupId: 'g0', title: 'Group Zero', description: '', panels: [p1] },
      { groupId: 'g1', title: 'Group One', description: '', panels: [p2] },
    ],
    allPanels: ['p1', 'p2'],
    expandable: true,
    rawPanels: [],
    editorAvailable: false,
  }
}

function withinGroup(groupId: string) {
  const section = document.querySelector(`.group-section[data-group-id="${groupId}"]`)
  if (!(section instanceof HTMLElement)) throw new Error(`group section ${groupId} not found`)
  return within(section)
}

beforeEach(() => {
  panelBlockSpy.mockClear()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  sessionStorage.clear()
})

describe('memo stability (GroupSection → PanelBlock)', () => {
  test('group textarea のキー入力では PanelBlock が再 render されない', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload()} />)

    await user.click(screen.getByRole('tab', { name: 'Guide' }))
    const baseline = panelBlockSpy.mock.calls.length
    expect(baseline).toBeGreaterThan(0)

    await user.type(
      withinGroup('g0').getByPlaceholderText(/この group へのコメント/),
      'typing should not re-render panels',
    )

    expect(panelBlockSpy.mock.calls.length).toBe(baseline)
  })

  test('Comment ボタン (threads 変化) では PanelBlock の再 render が起きる', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload()} />)

    await user.click(screen.getByRole('tab', { name: 'Guide' }))
    await user.type(
      withinGroup('g0').getByPlaceholderText(/この group へのコメント/),
      'pending comment',
    )
    const beforeSubmit = panelBlockSpy.mock.calls.length

    await user.click(withinGroup('g0').getByRole('button', { name: 'Comment' }))

    // threads 変化 → fileComments (deps: threads) 新参照 → memo 連鎖が PanelBlock まで届く。
    // この連鎖が CommentRow / GroupNav スレッド表示の更新経路なので「増える」ことが正しい。
    expect(panelBlockSpy.mock.calls.length).toBeGreaterThan(beforeSubmit)
  })
})
