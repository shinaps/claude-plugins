// Panel の unified / split mode 切替 render の contract:
//   - unified=false (デフォルト): SplitBody (.panel-side-asis / .panel-side-tobe) が出る
//   - unified=true: UnifiedBody (.panel-side-unified 単一カラム) が出て split 構造は無い
//   - unified の context 行は asIs / toBe 両 anchor の既存スレッドを表示する
//     (toBe だけ引くと asIs 側 context 行のスレッドがモバイルで不可視になる W7 回帰防止)

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { RenderedPanel, ThreadSnapshot } from '@show-me/diff-shared'
import { Panel } from '../src/guide/Panel'
import type { LineCommentHandlers } from '../src/guide/useLineComments'

function makePanel(panelId = 'p1'): RenderedPanel {
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
        { asIs: { type: 'deletion', line: 2, raw: 'old' }, toBe: { type: 'addition', line: 2, raw: 'new' } },
        { asIs: { type: 'context', line: 3, raw: 'const c' }, toBe: { type: 'context', line: 3, raw: 'const c' } },
      ],
    }],
  }
}

function makeHandlers(): LineCommentHandlers {
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
  }
}

function lineThread(panelId: string, side: 'asIs' | 'toBe', line: number, body: string): ThreadSnapshot {
  return {
    scope: { type: 'line', panelId, side, file: 'foo.ts', line },
    messages: [{ id: `${side}-${line}`, author: 'user', body, ts: 1 }],
    resolved: false,
    outdated: false,
  }
}

describe('Panel unified/split mode', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    delete window.__reviewDiffThreads
  })

  test('unified=false (default) renders SplitBody structure', () => {
    render(<Panel panel={makePanel()} {...makeHandlers()} />)
    expect(document.querySelector('.panel-side-asis')).not.toBeNull()
    expect(document.querySelector('.panel-side-tobe')).not.toBeNull()
    expect(document.querySelector('.panel-side-unified')).toBeNull()
  })

  test('unified=true renders single-column UnifiedBody without split structure', () => {
    render(<Panel panel={makePanel()} unified {...makeHandlers()} />)
    expect(document.querySelector('.panel-side-unified')).not.toBeNull()
    expect(document.querySelector('.panel-side-asis')).toBeNull()
    expect(document.querySelector('.panel-side-tobe')).toBeNull()
    // del → add の並べ替え: deletion 行が addition 行より先に出る
    const rows = Array.from(document.querySelectorAll('.panel-side-unified .code-row'))
      .map((el) => el.className)
    expect(rows.some((c) => c.includes('code-row-deletion'))).toBe(true)
    const delIdx = rows.findIndex((c) => c.includes('code-row-deletion'))
    const addIdx = rows.findIndex((c) => c.includes('code-row-addition'))
    expect(delIdx).toBeLessThan(addIdx)
    // unified は行コメント新規作成 UI (LineTrigger) を置かない
    expect(document.querySelector('.panel-side-unified .line-comment-trigger')).toBeNull()
  })

  test('unified context row shows threads anchored on BOTH asIs and toBe sides', () => {
    window.__reviewDiffThreads = {
      'line:p1:asIs:3': lineThread('p1', 'asIs', 3, 'asis-side-comment'),
      'line:p1:toBe:3': lineThread('p1', 'toBe', 3, 'tobe-side-comment'),
    }
    render(<Panel panel={makePanel()} unified {...makeHandlers()} />)
    // 最新 message が user のスレッドは折りたたみ初期表示なので、両 anchor のヘッダが
    // 出ていることを確認した上で展開し、本文が両方表示されることを検証する
    const toggles = screen.getAllByRole('button', { name: /Expand comment thread/ })
    expect(toggles).toHaveLength(2)
    toggles.forEach((btn) => fireEvent.click(btn))
    const text = document.body.textContent ?? ''
    expect(text).toContain('asis-side-comment')
    expect(text).toContain('tobe-side-comment')
  })

  test('unified mode collapses threads whose latest message is from user (FR-9 wiring)', () => {
    window.__reviewDiffThreads = {
      'line:p1:toBe:3': lineThread('p1', 'toBe', 3, 'waiting-for-agent'),
    }
    render(<Panel panel={makePanel()} unified {...makeHandlers()} />)
    // body は非表示、ヘッダ (行 label + 件数) は視認できる
    expect(document.body.textContent).not.toContain('waiting-for-agent')
    expect(document.body.textContent).toContain('行 3')
    expect(document.body.textContent).toContain('1 msg')
  })
})
