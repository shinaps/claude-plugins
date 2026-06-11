// Activity タブ Conversation カードのスレッド返信フローの結合テスト。
//
// contract (外部観測可能な振る舞い):
//   - 開いたカードには reply textarea + Comment ボタンが常時表示され、空のとき disabled
//   - Comment 押下で user message が pending としてスレッドに積まれ (timeline 即反映)、
//     textarea と sessionStorage draft はクリアされる
//   - 積んだ返信は SubmitBar の Submit / Comment に同乗して POST body の threads に載る
//   - resolved スレッドへの返信は open に戻し、active 群へ再分類される (local override も破棄)
//   - 書きかけ draft は regen (context+) / comment-reply の POST body lineCommentDrafts で回収され、
//     initialLineCommentDrafts 経由で復元される
//   - line scope スレッドへの返信は Guide タブの CommentRow にも反映される
//     (window.__reviewDiffThreads mirror + fileComments 参照変化の再 render 連鎖の contract 化)

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ClientPayload, RenderedPanel, ResultJson, ThreadSnapshot } from '@show-me/diff-shared'
import { App } from '../src/App'

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

function makeGroupThread(overrides?: Partial<ThreadSnapshot>): ThreadSnapshot {
  return {
    scope: { type: 'group', groupId: 'g0' },
    messages: [{ id: 'm1', author: 'user', body: 'first question', ts: 1 }],
    resolved: false,
    outdated: false,
    ...overrides,
  }
}

function makePayload(overrides?: Partial<ClientPayload>): ClientPayload {
  const panel = makePanel()
  return {
    schemaVersion: 1,
    summary: {
      schemaVersion: 1,
      mode: 'staged',
      pr: null,
      overallSummary: 'test summary',
      groups: [],
    },
    prMeta: null,
    project: { name: 'test-project', branch: 'main' },
    groups: [
      { groupId: 'g0', title: 'Group Zero', description: '', panels: [panel] },
      { groupId: 'g1', title: 'Group One (empty)', description: '', panels: [] },
    ],
    allPanels: [panel.panelId],
    expandable: true,
    rawPanels: [],
    editorAvailable: false,
    remote: false,
    ...overrides,
  }
}

const fetchMock = vi.fn()
let closeSpy: ReturnType<typeof vi.spyOn>

function postedBody(callIndex = 0): ResultJson {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit
  return JSON.parse(init.body as string) as ResultJson
}

// Conversation カードは data-thread-key 属性で特定できる (SubmitBar の Comment ボタン等と区別)。
function withinCard(threadKey: string) {
  const card = document.querySelector(`article[data-thread-key="${threadKey}"]`)
  if (!(card instanceof HTMLElement)) throw new Error(`conversation card ${threadKey} not found`)
  return within(card)
}

async function openSidebar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Open review panel' }))
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchMock)
  closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})
  sessionStorage.clear()
})

afterEach(() => {
  closeSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('Conversation カードの返信フォーム', () => {
  test('open スレッドのカードは expand 済みで、reply textarea と Comment ボタンが常時表示・空で disabled', () => {
    render(<App payload={makePayload({ initialThreads: { 'group:g0': makeGroupThread() } })} />)

    const card = withinCard('group:g0')
    expect(card.getByLabelText('Reply to thread')).toBeInTheDocument()
    const button = card.getByRole('button', { name: 'Comment' })
    expect(button).toBeInTheDocument()
    expect(button).toBeDisabled()
  })

  test('入力 → Comment 押下で timeline に user message が即追加され、textarea と draft がクリアされる', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload({ initialThreads: { 'group:g0': makeGroupThread() } })} />)

    const card = withinCard('group:g0')
    const textarea = card.getByLabelText('Reply to thread')
    await user.type(textarea, 'my reply')
    // 入力中は draft が sessionStorage に永続化される (カード再 mount / close-relaunch 対策)
    expect(sessionStorage.getItem('draft:activity-reply:group:g0')).toBe('my reply')

    await user.click(card.getByRole('button', { name: 'Comment' }))

    // pending としてスレッドに積まれ timeline に即反映 (送信はまだ = fetch は飛ばない)
    expect(withinCard('group:g0').getByText('my reply')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('')
    expect(sessionStorage.getItem('draft:activity-reply:group:g0')).toBeNull()
  })

  test('Cmd+Enter でも送信できる', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload({ initialThreads: { 'group:g0': makeGroupThread() } })} />)

    const textarea = withinCard('group:g0').getByLabelText('Reply to thread')
    await user.type(textarea, 'keyboard reply')
    await user.keyboard('{Meta>}{Enter}{/Meta}')

    expect(withinCard('group:g0').getByText('keyboard reply')).toBeInTheDocument()
    expect(textarea).toHaveValue('')
  })

  test('返信は SubmitBar の Submit に同乗して POST body の threads に載る (resolved=false)', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload({ initialThreads: { 'group:g0': makeGroupThread() } })} />)

    const card = withinCard('group:g0')
    await user.type(card.getByLabelText('Reply to thread'), 'reply via activity')
    await user.click(card.getByRole('button', { name: 'Comment' }))

    await openSidebar(user)
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    const thread = postedBody().threads['group:g0']
    expect(thread.messages).toHaveLength(2)
    expect(thread.messages[0].body).toBe('first question')
    expect(thread.messages[1]).toMatchObject({ author: 'user', body: 'reply via activity' })
    expect(thread.resolved).toBe(false)

    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })
})

describe('resolved スレッドへの返信', () => {
  test('resolved スレッドに返信すると open に戻り active 群へ再分類される', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload({
      initialThreads: { 'group:g0': makeGroupThread({ resolved: true }) },
    })} />)

    // resolved スレッドだけなので summary は all resolved 表示
    expect(screen.getByText('All threads resolved')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Show resolved & outdated/ }))
    // resolved variant は初期 collapsed なので expand してから返信する
    const card = withinCard('group:g0')
    await user.click(card.getByRole('button', { name: 'Expand thread' }))
    await user.type(card.getByLabelText('Reply to thread'), 'reopen via reply')
    await user.click(card.getByRole('button', { name: 'Comment' }))

    // App state 側で resolved=false に戻り、active 群 (unresolved summary) に再分類される
    expect(screen.getByText('1 unresolved thread')).toBeInTheDocument()
    expect(withinCard('group:g0').getByText('reopen via reply')).toBeInTheDocument()
  })

  test('カードの Resolve (local override) 後に返信しても override が破棄されて open に戻る', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload({ initialThreads: { 'group:g0': makeGroupThread() } })} />)

    // local override で resolved 化 → inactive 群へ移動
    await user.click(withinCard('group:g0').getByRole('button', { name: 'Resolve' }))
    expect(screen.getByText('All threads resolved')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Show resolved & outdated/ }))
    const card = withinCard('group:g0')
    await user.click(card.getByRole('button', { name: 'Expand thread' }))
    await user.type(card.getByLabelText('Reply to thread'), 'override discarded')
    await user.click(card.getByRole('button', { name: 'Comment' }))

    expect(screen.getByText('1 unresolved thread')).toBeInTheDocument()
  })
})

describe('draft の回収と復元 (close-relaunch round-trip)', () => {
  test('書きかけ draft は context+ (regen) の POST body lineCommentDrafts で回収される', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload({ initialThreads: { 'group:g0': makeGroupThread() } })} />)

    await user.type(withinCard('group:g0').getByLabelText('Reply to thread'), 'unsent reply draft')

    // Guide タブの context+ で regen を発火 (draft は未送信のまま)。
    // 全 group の GroupNav が context+ ボタンを持つため g0 の section にスコープする
    await user.click(screen.getByRole('tab', { name: 'Guide' }))
    const section = document.querySelector('.group-section[data-group-id="g0"]')
    if (!(section instanceof HTMLElement)) throw new Error('group section g0 not found')
    await user.click(within(section).getByRole('button', { name: /More context/ }))
    await user.click(screen.getByRole('button', { name: 'Submit context+' }))

    expect(postedBody().lineCommentDrafts).toMatchObject({
      'draft:activity-reply:group:g0': 'unsent reply draft',
    })
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('書きかけ draft は SubmitBar Comment (comment-reply) の POST body でも回収される', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload({ initialThreads: { 'group:g0': makeGroupThread() } })} />)

    await user.type(withinCard('group:g0').getByLabelText('Reply to thread'), 'draft at comment time')

    await openSidebar(user)
    await user.type(screen.getByLabelText('Review-wide comment'), 'overall note')
    // カード側の Comment ボタンと同名なので SubmitBar 側は title で特定する
    await user.click(screen.getByTitle(/Comment review/))

    const body = postedBody()
    expect(body.decision).toBe('comment-reply')
    expect(body.lineCommentDrafts).toMatchObject({
      'draft:activity-reply:group:g0': 'draft at comment time',
    })
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('initialLineCommentDrafts の draft:activity-reply: key が reply textarea に復元される', () => {
    render(<App payload={makePayload({
      initialThreads: { 'group:g0': makeGroupThread() },
      initialLineCommentDrafts: { 'draft:activity-reply:group:g0': 'restored draft' },
    })} />)

    expect(withinCard('group:g0').getByLabelText('Reply to thread')).toHaveValue('restored draft')
  })
})

describe('line scope スレッドの画面間同期', () => {
  test('Activity から line スレッドに返信すると Guide タブの CommentRow にも表示される', async () => {
    const user = userEvent.setup()
    const lineThread: ThreadSnapshot = {
      scope: { type: 'line', panelId: 'p1', side: 'toBe', file: 'src/foo.ts', line: 2 },
      messages: [{ id: 'm1', author: 'agent', body: 'agent line note', ts: 1 }],
      resolved: false,
      outdated: false,
    }
    render(<App payload={makePayload({ initialThreads: { 'line:p1:toBe:2': lineThread } })} />)

    const card = withinCard('line:p1:toBe:2')
    await user.type(card.getByLabelText('Reply to thread'), 'reply on line 2')
    await user.click(card.getByRole('button', { name: 'Comment' }))

    // Guide タブに切り替えると、CommentRow (window.__reviewDiffThreads mirror 経由) に返信が見える。
    // この表示は「fileComments useMemo (deps: threads) の参照変化が Panel の memo を破る」連鎖に
    // 依存しており、本テストがその連鎖を contract として固定する (App.tsx / Panel.tsx のコメント参照)。
    await user.click(screen.getByRole('tab', { name: 'Guide' }))
    const guidePane = document.querySelector('.tab-pane:not(.tab-hidden)')
    expect(guidePane).not.toBeNull()
    expect(within(guidePane as HTMLElement).getByText('reply on line 2')).toBeInTheDocument()
  })
})
