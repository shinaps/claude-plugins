// CommentRow の折りたたみトグルと編集・削除ボタン常時表示の contract:
//   - 復元 (persisted thread) の最新 message が user の行は折りたたみ初期表示、
//     最新が agent の行は開いた初期表示 (読むべき返答がある行を優先的に見せる)
//   - savedList (セッション内 pending) が 1 件でもあれば初期状態は必ず開
//     (タブ初訪問などの遅延 mount で書いたばかりのコメントが隠れない)
//   - ヘッダのトグルボタンで個別に開閉でき、他の行に影響しない
//   - formOpen (activeForm 一致) 中は collapsed state によらず body を表示する
//   - 編集・削除ボタンは hover なしで常時表示され、handler を発火する

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, test, expect, afterEach, vi } from 'vitest'
import type { RenderedPanel, ThreadSnapshot } from '@show-me/diff-shared'
import { CommentRow } from '../src/guide/CommentRow'
import type { LineCommentHandlers } from '../src/guide/useLineComments'
import { lineCommentKey } from '../src/lib/state'

function makePanel(panelId = 'p1'): RenderedPanel {
  return {
    panelId,
    intent: 'test',
    asIs: { file: 'foo.ts', ranges: [{ start: 1, end: 3 }] },
    toBe: { file: 'foo.ts', ranges: [{ start: 1, end: 3 }] },
    asIsLanguage: 'typescript',
    toBeLanguage: 'typescript',
    segments: [],
  }
}

function makeHandlers(overrides: Partial<LineCommentHandlers> = {}): LineCommentHandlers {
  return {
    lineComments: new Map(),
    activeForm: null,
    editing: new Map(),
    onOpenLineForm: () => { /* noop */ },
    onCloseLineForm: () => { /* noop */ },
    onAddLineComment: () => { /* noop */ },
    onStartEditLineComment: () => { /* noop */ },
    onCancelEditLineComment: () => { /* noop */ },
    onSaveEditLineComment: () => { /* noop */ },
    onDeleteLineComment: () => { /* noop */ },
    ...overrides,
  }
}

function persistedThread(lastAuthor: 'user' | 'agent'): ThreadSnapshot {
  const messages = [
    { id: 'm1', author: 'agent' as const, body: 'agent message', ts: 1 },
    { id: 'm2', author: lastAuthor, body: `${lastAuthor} last message`, ts: 2 },
  ]
  return {
    scope: { type: 'line', panelId: 'p1', side: 'toBe', file: 'foo.ts', line: 2 },
    messages,
    resolved: false,
    outdated: false,
  }
}

const KEY = lineCommentKey('p1', 'toBe', 2)
const THREAD_KEY = 'line:p1:toBe:2'

afterEach(() => {
  delete window.__reviewDiffThreads
})

describe('CommentRow: 折りたたみ初期値 (復元時の自動判定)', () => {
  test('persisted 最終 message が user → 折りたたみ初期表示 (body 非表示 + ヘッダあり)', () => {
    window.__reviewDiffThreads = { [THREAD_KEY]: persistedThread('user') }
    render(<CommentRow lineKey={KEY} panel={makePanel()} handlers={makeHandlers()} />)
    expect(screen.queryByText('user last message')).toBeNull()
    expect(document.body.textContent).toContain('行 2')
    expect(document.body.textContent).toContain('2 msgs')
    expect(screen.getByRole('button', { name: /Expand comment thread/ })).toHaveAttribute('aria-expanded', 'false')
  })

  test('persisted 最終 message が agent → 開いた初期表示', () => {
    window.__reviewDiffThreads = { [THREAD_KEY]: persistedThread('agent') }
    render(<CommentRow lineKey={KEY} panel={makePanel()} handlers={makeHandlers()} />)
    expect(screen.getByText('agent last message')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Collapse comment thread/ })).toHaveAttribute('aria-expanded', 'true')
  })

  test('persisted 最終 user でも savedList 非空なら初期状態は開 (遅延 mount で pending が隠れない)', () => {
    window.__reviewDiffThreads = { [THREAD_KEY]: persistedThread('user') }
    const handlers = makeHandlers({ lineComments: new Map([[KEY, ['my fresh pending']]]) })
    render(<CommentRow lineKey={KEY} panel={makePanel()} handlers={handlers} />)
    expect(screen.getByText('my fresh pending')).toBeInTheDocument()
    expect(screen.getByText('user last message')).toBeInTheDocument()
  })

  test('persisted なし + savedList ありは開いた初期表示', () => {
    const handlers = makeHandlers({ lineComments: new Map([[KEY, ['session comment']]]) })
    render(<CommentRow lineKey={KEY} panel={makePanel()} handlers={handlers} />)
    expect(screen.getByText('session comment')).toBeInTheDocument()
  })
})

describe('CommentRow: 個別トグル', () => {
  test('ヘッダのトグルで閉 → 開 → 閉が往復する', () => {
    window.__reviewDiffThreads = { [THREAD_KEY]: persistedThread('user') }
    render(<CommentRow lineKey={KEY} panel={makePanel()} handlers={makeHandlers()} />)
    expect(screen.queryByText('user last message')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Expand comment thread/ }))
    expect(screen.getByText('user last message')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Collapse comment thread/ }))
    expect(screen.queryByText('user last message')).toBeNull()
  })
})

describe('CommentRow: formOpen との連動', () => {
  test('折りたたみ中の行で activeForm が立つと body (フォーム含む) が表示され、閉じた後も開いたまま', () => {
    window.__reviewDiffThreads = { [THREAD_KEY]: persistedThread('user') }
    const { rerender } = render(
      <CommentRow lineKey={KEY} panel={makePanel()} handlers={makeHandlers()} />,
    )
    expect(screen.queryByText('user last message')).toBeNull()
    rerender(
      <CommentRow lineKey={KEY} panel={makePanel()} handlers={makeHandlers({ activeForm: KEY })} />,
    )
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByText('user last message')).toBeInTheDocument()
    // useEffect が collapsed=false を永続化するので、フォームが閉じた後も body は開いたまま
    rerender(
      <CommentRow lineKey={KEY} panel={makePanel()} handlers={makeHandlers()} />,
    )
    expect(screen.getByText('user last message')).toBeInTheDocument()
  })

  test('formOpen 中のトグルクリックは no-op で、フォームを閉じた後も折りたたまれない', () => {
    window.__reviewDiffThreads = { [THREAD_KEY]: persistedThread('user') }
    const { rerender } = render(
      <CommentRow lineKey={KEY} panel={makePanel()} handlers={makeHandlers({ activeForm: KEY })} />,
    )
    // formOpen 中にトグルをクリックしても collapsed が不可視に反転しない
    fireEvent.click(screen.getByRole('button', { name: /Collapse comment thread/ }))
    expect(screen.getByText('user last message')).toBeInTheDocument()
    rerender(
      <CommentRow lineKey={KEY} panel={makePanel()} handlers={makeHandlers()} />,
    )
    expect(screen.getByText('user last message')).toBeInTheDocument()
  })

  test('activeForm のみ (メッセージ 0 件) では折りたたみトグルを出さず plain label になる', () => {
    render(
      <CommentRow lineKey={KEY} panel={makePanel()} handlers={makeHandlers({ activeForm: KEY })} />,
    )
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /comment thread/ })).toBeNull()
    expect(document.body.textContent).toContain('行 2')
  })
})

describe('CommentRow: 編集・削除ボタンの常時表示', () => {
  test('保存済み pending のボタンが hover なしで取得でき、編集 handler が発火する', () => {
    const onStartEdit = vi.fn()
    const handlers = makeHandlers({
      lineComments: new Map([[KEY, ['needs polish']]]),
      onStartEditLineComment: onStartEdit,
    })
    render(<CommentRow lineKey={KEY} panel={makePanel()} handlers={handlers} />)
    fireEvent.click(screen.getByRole('button', { name: '編集' }))
    expect(onStartEdit).toHaveBeenCalledWith(KEY, 0, 'needs polish')
  })

  test('削除ボタンは confirm 承認で削除 handler が発火する', () => {
    const onDelete = vi.fn()
    const handlers = makeHandlers({
      lineComments: new Map([[KEY, ['to be removed']]]),
      onDeleteLineComment: onDelete,
    })
    // happy-dom には window.confirm が無いため stubGlobal で注入する
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    render(<CommentRow lineKey={KEY} panel={makePanel()} handlers={handlers} />)
    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    expect(onDelete).toHaveBeenCalledWith(KEY, 0)
    vi.unstubAllGlobals()
  })
})
