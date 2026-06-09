// Panel のドラッグ範囲選択 / 単一クリック挙動を実機相当でテストする (grid refactor)。
//
// DOM 構造 / セレクタ前提:
//   - <div class="panel-grid"> + <div class="code-row"> + cell 構造 (旧 <table>/<tr>/<td> ではない)
//   - panelContainerRef は HTMLDivElement
//   - セレクタは tagless: `[data-panel-id]` / `[data-side]` / `.cell-ln` / `.cell-code` / `.code-row`
//   - split mode では asIs row と toBe row が別々の panel-side wrapper 配下に存在する
//     (panel-side-asis / panel-side-tobe で per-side 独立 scroll container を実現するため)
//   - cross-panel drag は panelContainerRef.contains() で完全に弾かれる (AC-6 構造的担保)

import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, test, expect, beforeEach } from 'vitest'
import type { RenderedPanel } from '@zeus/review-diff-shared'
import { Panel } from '../src/Panel'
import type { LineCommentHandlers, LineTarget } from '../src/useLineComments'

function makePanel(panelId = 'p1'): RenderedPanel {
  // context 3 行のシンプルな panel。各 row は両側 context (= 行番号が両側 1..3)。
  return {
    panelId,
    intent: 'test',
    asIs: { file: 'foo.ts', ranges: [{ start: 1, end: 3 }] },
    toBe: { file: 'foo.ts', ranges: [{ start: 1, end: 3 }] },
    asIsLanguage: 'typescript',
    toBeLanguage: 'typescript',
    segments: [{
      asIsRange: { start: 1, end: 3 },
      toBeRange: { start: 1, end: 3 },
      rows: [
        { asIs: { type: 'context', line: 1, raw: 'const a' }, toBe: { type: 'context', line: 1, raw: 'const a' } },
        { asIs: { type: 'context', line: 2, raw: 'const b' }, toBe: { type: 'context', line: 2, raw: 'const b' } },
        { asIs: { type: 'context', line: 3, raw: 'const c' }, toBe: { type: 'context', line: 3, raw: 'const c' } },
      ],
    }],
  }
}

type SpyHandlers = LineCommentHandlers & {
  openedCalls: Array<{ panelId: string; target: LineTarget }>
}

function makeHandlers(): SpyHandlers {
  const openedCalls: Array<{ panelId: string; target: LineTarget }> = []
  const base: LineCommentHandlers = {
    lineComments: new Map(),
    activeForm: null,
    editing: new Map(),
    onOpenLineForm: (panelId, target) => { openedCalls.push({ panelId, target }) },
    onCloseLineForm: () => { /* noop */ },
    onAddLineComment: () => { /* noop */ },
    onStartEditLineComment: () => { /* noop */ },
    onCancelEditLineComment: () => { /* noop */ },
    onSaveEditLineComment: () => { /* noop */ },
    onDeleteLineComment: () => { /* noop */ },
  }
  return Object.assign(base, { openedCalls })
}

// 行コメント drag は cell-ln (gutter) で開始する設計。cell-code はテキスト選択を許すために
// data 属性のみ付与され、pointer handler は無い。drag-start のテストは cell-ln を使う。
function getGutterCell(panelId: string, side: 'asis' | 'tobe', n: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-panel-id="${panelId}"] .cell-ln[data-side="${side}"][data-line-number="${n}"]`,
  )
  if (!el) throw new Error(`.cell-ln[data-side=${side}][data-line-number=${n}] (panel=${panelId}) not found`)
  return el
}
function getCodeCell(panelId: string, side: 'asis' | 'tobe', n: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-panel-id="${panelId}"] .cell-code[data-side="${side}"][data-line-number="${n}"]`,
  )
  if (!el) throw new Error(`.cell-code[data-side=${side}][data-line-number=${n}] (panel=${panelId}) not found`)
  return el
}

function renderPanel(panelId = 'p1'): { panel: RenderedPanel; handlers: SpyHandlers } {
  const panel = makePanel(panelId)
  const handlers = makeHandlers()
  render(<Panel panel={panel} {...handlers} />)
  return { panel, handlers }
}

describe('Panel drag select (grid)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    try { localStorage.clear() } catch { /* noop */ }
  })

  test('.cell-code carries data-side (asis/tobe) and data-line-number for every row', () => {
    renderPanel()
    const cells = document.querySelectorAll<HTMLElement>('.cell-code[data-side]')
    // split mode (初期): 3 行 × 2 side = 6 セル
    expect(cells.length).toBe(6)
    for (const c of cells) {
      expect(c.dataset.side).toMatch(/^(asis|tobe)$/)
      expect(c.dataset.lineNumber).toMatch(/^\d+$/)
    }
  })

  test('pointerdown on .cell-ln (gutter) highlights the starting row', async () => {
    renderPanel()
    const user = userEvent.setup()
    const start = getGutterCell('p1', 'tobe', 1)
    await user.pointer({ target: start, keys: '[MouseLeft>]' })
    expect(start.closest('.code-row')).toHaveClass('line-selected')
  })

  test('pointerup on the same row opens single-line form (target.side="toBe")', async () => {
    const { handlers } = renderPanel()
    const user = userEvent.setup()
    const cell = getGutterCell('p1', 'tobe', 2)
    await user.pointer([
      { target: cell, keys: '[MouseLeft>]' },
      { target: cell, keys: '[/MouseLeft]' },
    ])
    expect(handlers.openedCalls).toEqual([
      { panelId: 'p1', target: { side: 'toBe', number: 2 } },
    ])
  })

  test('pointerup on a different row opens range-line form (endNumber set)', async () => {
    const { handlers } = renderPanel()
    const user = userEvent.setup()
    const start = getGutterCell('p1', 'tobe', 1)
    const end = getGutterCell('p1', 'tobe', 3)
    // happy-dom の elementFromPoint は座標 → 要素を解決しないので mock で end を返す
    const orig = document.elementFromPoint
    document.elementFromPoint = ((_x: number, _y: number) => end) as typeof document.elementFromPoint
    try {
      await user.pointer([
        { target: start, keys: '[MouseLeft>]' },
        { target: end },
        { target: end, keys: '[/MouseLeft]' },
      ])
    } finally {
      document.elementFromPoint = orig
    }
    expect(handlers.openedCalls).toHaveLength(1)
    expect(handlers.openedCalls[0]).toEqual({
      panelId: 'p1',
      target: { side: 'toBe', number: 1, endNumber: 3 },
    })
  })

  test('drag move highlights all rows in range', async () => {
    renderPanel()
    const user = userEvent.setup()
    const start = getGutterCell('p1', 'tobe', 1)
    const mid = getGutterCell('p1', 'tobe', 2)
    const orig = document.elementFromPoint
    document.elementFromPoint = (() => mid) as typeof document.elementFromPoint
    try {
      await user.pointer([
        { target: start, keys: '[MouseLeft>]' },
        { target: mid },
      ])
    } finally {
      document.elementFromPoint = orig
    }
    expect(start.closest('.code-row')).toHaveClass('line-selected')
    expect(mid.closest('.code-row')).toHaveClass('line-selected')
    const out = getGutterCell('p1', 'tobe', 3)
    expect(out.closest('.code-row')).not.toHaveClass('line-selected')
  })

  test('drag clears highlight after pointerup', async () => {
    renderPanel()
    const user = userEvent.setup()
    const cell = getGutterCell('p1', 'tobe', 2)
    await user.pointer([
      { target: cell, keys: '[MouseLeft>]' },
      { target: cell, keys: '[/MouseLeft]' },
    ])
    expect(cell.closest('.code-row')).not.toHaveClass('line-selected')
  })

  test('Escape during drag cancels selection without opening form', async () => {
    const { handlers } = renderPanel()
    const user = userEvent.setup()
    const cell = getGutterCell('p1', 'tobe', 1)
    await user.pointer({ target: cell, keys: '[MouseLeft>]' })
    await user.keyboard('{Escape}')
    expect(cell.closest('.code-row')).not.toHaveClass('line-selected')
    await user.pointer({ target: cell, keys: '[/MouseLeft]' })
    expect(handlers.openedCalls).toHaveLength(0)
  })

  test('right-click (button !== 0) is ignored: no highlight, no form', async () => {
    const { handlers } = renderPanel()
    const user = userEvent.setup()
    const cell = getGutterCell('p1', 'tobe', 1)
    await user.pointer({ target: cell, keys: '[MouseRight]' })
    expect(cell.closest('.code-row')).not.toHaveClass('line-selected')
    expect(handlers.openedCalls).toHaveLength(0)
  })

  test('.cell-code carries data-side and data-line-number even though pointer handlers are on .cell-ln', () => {
    // .cell-code は selection / copy のために pointer handler を持たないが、ドラッグ中の
    // resolveLineAtPoint が elementFromPoint で拾うため、data 属性は必須。
    renderPanel()
    const c = getCodeCell('p1', 'tobe', 2)
    expect(c.dataset.side).toBe('tobe')
    expect(c.dataset.lineNumber).toBe('2')
  })

  test('AC-6: cross-panel drag does NOT register endNumber on the other panel', async () => {
    // p1 と p2 を別々に render し、p1 の cell で down → mock elementFromPoint で p2 の cell を返す。
    // Panel の resolveLineAtPoint は panelContainerRef.contains() で別 panel の cell を弾くので、
    // up 時の endNumber は p1 の最終 currentNumber (= startNumber) と等しくなる (= 単一行扱い)。
    const handlersA: SpyHandlers = makeHandlers()
    const handlersB: SpyHandlers = makeHandlers()
    render(
      <>
        <Panel panel={makePanel('p1')} {...handlersA} />
        <Panel panel={makePanel('p2')} {...handlersB} />
      </>,
    )
    const user = userEvent.setup()
    const startInP1 = getGutterCell('p1', 'tobe', 1)
    const cellInP2 = getGutterCell('p2', 'tobe', 3)
    const orig = document.elementFromPoint
    // elementFromPoint は cross-panel の cellInP2 を返す → Panel 側で contains 検査に落とされる
    document.elementFromPoint = (() => cellInP2) as typeof document.elementFromPoint
    try {
      await user.pointer([
        { target: startInP1, keys: '[MouseLeft>]' },
        { target: cellInP2 },
        { target: cellInP2, keys: '[/MouseLeft]' },
      ])
    } finally {
      document.elementFromPoint = orig
    }
    // p1 の handler は呼ばれるが、target は p1 の単一行 (endNumber 無し) のはず
    expect(handlersA.openedCalls).toHaveLength(1)
    expect(handlersA.openedCalls[0].panelId).toBe('p1')
    expect(handlersA.openedCalls[0].target.endNumber).toBeUndefined()
    // p2 側のハンドラは呼ばれない
    expect(handlersB.openedCalls).toHaveLength(0)
  })
})
