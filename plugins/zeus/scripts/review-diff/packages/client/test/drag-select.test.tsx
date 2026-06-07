// DiffTable のドラッグ範囲選択 / 単一クリック挙動を実機相当でテストする。
//
// なぜ Vitest + happy-dom + @testing-library を選んだか:
//   - happy-dom は jsdom より軽量で Pointer Events / setPointerCapture を初期サポート。
//     jsdom はかつて setPointerCapture を no-op にしていた経緯があり、ドラッグ実装の
//     回帰テスト用途では happy-dom が素直に動く。
//   - userEvent.pointer は keys: '[MouseLeft>]' / '[/MouseLeft]' で down → up を切り分けられ、
//     fireEvent より「実機の連続イベント」に近いシーケンスを生成できる。
//   - ただし happy-dom の elementFromPoint はモック動作 (座標を持たず最後に追加された
//     要素を返す類) のため、座標起点の resolveLineAtPoint テストは「up 時に同じ td が
//     返るか」までは保証できない。そのため up のターゲットを「最終 td」に明示する形で
//     userEvent.pointer のシーケンスを組み立てる。

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, test, expect, beforeEach } from 'vitest'
import { DiffTable } from '../src/DiffTable.tsx'
import type { LineCommentHandlers, LineTarget } from '../src/useLineComments.ts'
import type { Hunk, ParsedFile } from '@zeus/review-diff-shared'

// 共有の最小ファイル fixture。
//   - context 行 3 行のみ。addition/deletion は今回のシナリオでは不要。
//   - raw フィールドは生コード文字列。client 側 DiffTable が Shiki に通してハイライトする。
//     happy-dom 環境下では Shiki が言語を解決できれば <span> 列が返り、screen.getByText で拾える。
function makeFile(): ParsedFile {
  const mkRow = (n: number, text: string) => ({
    left: { type: 'context' as const, line: n, raw: text },
    right: { type: 'context' as const, line: n, raw: text },
  })
  const hunk: Hunk = {
    index: 0,
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    rows: [mkRow(1, 'const a'), mkRow(2, 'const b'), mkRow(3, 'const c')],
  }
  return {
    path: 'foo.ts',
    status: 'modified',
    language: 'typescript',
    additions: 0,
    deletions: 0,
    totalLines: 3,
    afterTotal: 3,
    hunks: [hunk],
  }
}

// onOpenLineForm をスパイ可能にした handlers を返す。
function makeHandlers(overrides: Partial<LineCommentHandlers> = {}): LineCommentHandlers & {
  openedCalls: Array<{ file: string; target: LineTarget }>
} {
  const openedCalls: Array<{ file: string; target: LineTarget }> = []
  const base: LineCommentHandlers = {
    lineComments: new Map(),
    activeForm: null,
    editing: new Map(),
    onOpenLineForm: (file, target) => {
      openedCalls.push({ file, target })
    },
    onCloseLineForm: () => {},
    onAddLineComment: () => {},
    onStartEditLineComment: () => {},
    onCancelEditLineComment: () => {},
    onSaveEditLineComment: () => {},
    onDeleteLineComment: () => {},
    ...overrides,
  }
  // openedCalls は副作用配列なので、overrides で onOpenLineForm を差し替えた場合でも
  // 元のスパイ動作を維持できるよう、ラップした handlers を返す。
  return Object.assign(base, { openedCalls })
}

// 指定 (side, lineNumber) の td.code を data 属性で直接引く。
// screen.getByText('const a').closest('td.code') だと left/right どちらの td かを
// 切り分けにくいため、data-side + data-line-number で取得する。
function getCodeCell(side: 'left' | 'right', n: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `td.code[data-side="${side}"][data-line-number="${n}"]`,
  )
  if (!el) throw new Error(`td.code[data-side=${side}][data-line-number=${n}] not found`)
  return el
}

function renderTable(handlersOverrides: Partial<LineCommentHandlers> = {}) {
  const file = makeFile()
  const handlers = makeHandlers(handlersOverrides)
  render(
    <DiffTable
      file={file}
      visibleHunks={file.hunks}
      expandable={false}
      token="t"
      {...handlers}
    />,
  )
  return { file, handlers }
}

describe('DiffTable drag select', () => {
  beforeEach(() => {
    // happy-dom はテスト間で document を保持するため、render の cleanup 確認を兼ねる。
    document.body.innerHTML = ''
  })

  test('td.code carries data-side and data-line-number attributes (regression: empty 行や undefined 化していない)', () => {
    renderTable()
    // context 行 3 件 × left/right = 6 セル全てに data 属性が付くこと。
    // バグ仮説で「String(undefined) で "undefined" 文字列になっている」可能性があったため、
    // 数値文字列のみが入っていることを明示的にチェックする。
    const cells = document.querySelectorAll<HTMLElement>('td.code[data-side]')
    expect(cells.length).toBe(6)
    for (const c of cells) {
      expect(c.dataset.side).toMatch(/^(left|right)$/)
      expect(c.dataset.lineNumber).toMatch(/^\d+$/)
    }
  })

  test('pointerdown on td.code highlights the starting row', async () => {
    renderTable()
    const user = userEvent.setup()
    const start = getCodeCell('right', 1)
    // keys: '[MouseLeft>]' で down のみ発火、up は別ステップに分離。
    await user.pointer({ target: start, keys: '[MouseLeft>]' })
    const row = start.closest('tr.code-row')
    expect(row).toHaveClass('line-selected')
  })

  test('pointerup on the same row opens single-line form', async () => {
    const { file, handlers } = renderTable()
    const user = userEvent.setup()
    const cell = getCodeCell('right', 2)
    // 同じセルで down → up。CLICK_THRESHOLD_MS=200ms 以内なら単一行扱い。
    await user.pointer([
      { target: cell, keys: '[MouseLeft>]' },
      { target: cell, keys: '[/MouseLeft]' },
    ])
    expect(handlers.openedCalls).toEqual([
      { file: file.path, target: { side: 'right', number: 2 } },
    ])
  })

  test('pointerup on a different row opens range-line form', async () => {
    const { file, handlers } = renderTable()
    const user = userEvent.setup()
    const start = getCodeCell('right', 1)
    const end = getCodeCell('right', 3)
    // happy-dom の elementFromPoint は座標→要素の解決を持たず null を返す。
    // 実装は currentTarget ではなく document.elementFromPoint で「カーソル直下の行」を
    // 引く方式なので、テストでは pointermove/up の event.target を見て対応する td.code を
    // 返すよう elementFromPoint をモックする (実機 Chrome の挙動を再現)。
    const orig = document.elementFromPoint
    document.elementFromPoint = ((_x: number, _y: number) => {
      // userEvent.pointer のシーケンス上、最後にカーソルがあるのは end セル。
      // pointermove と pointerup のどちらで呼ばれても end を返せば実機と等価。
      return end
    }) as typeof document.elementFromPoint
    try {
      await user.pointer([
        { target: start, keys: '[MouseLeft>]' },
        { target: end },
        { target: end, keys: '[/MouseLeft]' },
      ])
    } finally {
      document.elementFromPoint = orig
    }
    // range の場合は { side, number, endNumber } の形になる。
    expect(handlers.openedCalls).toHaveLength(1)
    expect(handlers.openedCalls[0]).toEqual({
      file: file.path,
      target: { side: 'right', number: 1, endNumber: 3 },
    })
  })

  test('drag move highlights all rows in range (pointermove resolves line via elementFromPoint)', async () => {
    renderTable()
    const user = userEvent.setup()
    const start = getCodeCell('right', 1)
    const mid = getCodeCell('right', 2)
    // elementFromPoint を mid に固定 → move 中に currentNumber=2 まで広がる。
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
    // start (line 1) と mid (line 2) の両方に line-selected が付与されているはず。
    expect(start.closest('tr.code-row')).toHaveClass('line-selected')
    expect(mid.closest('tr.code-row')).toHaveClass('line-selected')
    // line 3 は範囲外。
    const out = getCodeCell('right', 3)
    expect(out.closest('tr.code-row')).not.toHaveClass('line-selected')
  })

  test('drag clears highlight after pointerup (state reset)', async () => {
    renderTable()
    const user = userEvent.setup()
    const cell = getCodeCell('right', 2)
    await user.pointer([
      { target: cell, keys: '[MouseLeft>]' },
      { target: cell, keys: '[/MouseLeft]' },
    ])
    expect(cell.closest('tr.code-row')).not.toHaveClass('line-selected')
  })

  test('Escape during drag cancels the selection without opening form', async () => {
    const { handlers } = renderTable()
    const user = userEvent.setup()
    const cell = getCodeCell('right', 1)
    await user.pointer({ target: cell, keys: '[MouseLeft>]' })
    // ドラッグ中の Escape はキャンセル。フォームは開かない。
    await user.keyboard('{Escape}')
    expect(cell.closest('tr.code-row')).not.toHaveClass('line-selected')
    // pointerup を別途送って、漏れて onOpenLineForm が呼ばれないことも確認。
    await user.pointer({ target: cell, keys: '[/MouseLeft]' })
    expect(handlers.openedCalls).toHaveLength(0)
  })

  test('right-click (button !== 0) is ignored: no highlight, no form', async () => {
    const { handlers } = renderTable()
    const user = userEvent.setup()
    const cell = getCodeCell('right', 1)
    // '[MouseRight]' で右クリック down→up。handlePointerDown は button !== 0 を弾く。
    await user.pointer({ target: cell, keys: '[MouseRight]' })
    expect(cell.closest('tr.code-row')).not.toHaveClass('line-selected')
    expect(handlers.openedCalls).toHaveLength(0)
  })
})
