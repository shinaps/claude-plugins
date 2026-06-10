// App の submit / context+ (regen-group) フローの characterization test。
//
// contract (外部観測可能な振る舞い):
//   - SubmitBar のボタン押下で POST /result?token=... に ResultJson が飛ぶ
//     (decision / reviewKind / groupDecisions の fillMode 補完 / note の thread 合成 / submitNote)
//   - 成功時は完了画面 ("Review submitted ..." 等) を表示し、300ms 後に window.close() が呼ばれる
//   - 完了画面の approved / request-changes 集計は実際に POST した groupDecisions と一致する
//     (fillMode 補完分を含む)
//   - 失敗時は toast を出し、submit 可能な状態を保つ (close しない)
//   - context+ は decision='regen-group' で currentRanges / lineCommentDrafts を回収して送る
//   - 全 group decision がユーザー操作で確定した瞬間に auto-submit が発火する
//     (restore で初期 decision が全埋まりでも、操作なしには発火しない)
// 内部実装 (fetch+close の共通化など) を変えてもこのテストが通ることを保証する。

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ClientPayload, RenderedPanel, ResultJson } from '@zeus/review-diff-shared'
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

// g0 (panel 1 つ、要判定) + g1 (panels=0、自動 approved) の最小 payload。
// fillMode 補完が「null の group のみ」に効くことを観測できる構成にする。
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
    ...overrides,
  }
}

const fetchMock = vi.fn()
let closeSpy: ReturnType<typeof vi.spyOn>

function postedBody(callIndex = 0): ResultJson {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit
  return JSON.parse(init.body as string) as ResultJson
}

// 初期タブ (Activity) では SubmitBar が sidebar variant で、閉時は aria-hidden で
// a11y tree から外れる。実ユーザーと同じく右端ハンドルで開いてからボタンを押す。
async function openSidebar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Open review panel' }))
}

// 全 group の GroupNav が context+ ボタンを持つため、g0 の section にスコープして取得する。
function withinGroup(groupId: string) {
  const section = document.querySelector(`.group-section[data-group-id="${groupId}"]`)
  if (!(section instanceof HTMLElement)) throw new Error(`group section ${groupId} not found`)
  return within(section)
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

describe('submit (SubmitBar 経由)', () => {
  test('Approve: 未判定 group を approved に補完して decision=submit を POST し window.close', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload()} />)

    await openSidebar(user)
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/^\/result\?token=/)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })

    const body = postedBody()
    expect(body.decision).toBe('submit')
    expect(body.reviewKind).toBe('approve')
    // g0 は fillMode='approved' で補完、g1 は panels=0 の自動 approved
    expect(body.groupDecisions).toEqual({ g0: 'approved', g1: 'approved' })
    expect(body.comments).toEqual([])
    expect(body.threads).toEqual({})
    expect(body.submitNote).toBeUndefined()
    expect(body.regenGroup).toBeUndefined()

    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('Request Changes: 未判定のみ request-changes に補完 (自動 approved の空 group は維持)', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload()} />)

    await openSidebar(user)
    await user.click(screen.getByRole('button', { name: 'Request Changes' }))

    const body = postedBody()
    expect(body.decision).toBe('submit')
    expect(body.reviewKind).toBe('request-changes')
    expect(body.groupDecisions).toEqual({ g0: 'request-changes', g1: 'approved' })

    // 300ms 後の window.close タイマーを test 内で消化する (次の test への漏れ込み防止)
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('Comment + note: decision=comment-reply、submitNote と review thread への user message 合成', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload()} />)

    await openSidebar(user)
    await user.type(screen.getByLabelText('Review-wide comment'), 'overall note')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    const body = postedBody()
    expect(body.decision).toBe('comment-reply')
    expect(body.reviewKind).toBe('comment')
    // Comment は fillMode 無し: 未判定 g0 は載らない
    expect(body.groupDecisions).toEqual({ g1: 'approved' })
    expect(body.submitNote).toBe('overall note')
    const reviewThread = body.threads['review']
    expect(reviewThread).toBeDefined()
    expect(reviewThread.messages).toHaveLength(1)
    expect(reviewThread.messages[0]).toMatchObject({ author: 'user', body: 'overall note' })
    expect(reviewThread.resolved).toBe(false)

    // 300ms 後の window.close タイマーを test 内で消化する (次の test への漏れ込み防止)
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('initialThreads がある場合は既存 review thread に note が追記される', async () => {
    const user = userEvent.setup()
    const payload = makePayload({
      initialThreads: {
        review: {
          scope: { type: 'review' },
          messages: [{ id: 'm1', author: 'agent', body: 'previous reply', ts: 1 }],
          resolved: true,
          outdated: false,
        },
      },
    })
    render(<App payload={payload} />)

    await user.type(screen.getByLabelText('Review-wide comment'), 'follow-up')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    const reviewThread = postedBody().threads['review']
    expect(reviewThread.messages).toHaveLength(2)
    expect(reviewThread.messages[0].body).toBe('previous reply')
    expect(reviewThread.messages[1]).toMatchObject({ author: 'user', body: 'follow-up' })
    // 追記時は resolved を倒す (返信待ちの open スレッドに戻す)
    expect(reviewThread.resolved).toBe(false)

    // 300ms 後の window.close タイマーを test 内で消化する (次の test への漏れ込み防止)
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('fetch 失敗時: toast を出し、完了画面に遷移しない (SubmitBar は残る)', async () => {
    const user = userEvent.setup()
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    render(<App payload={makePayload()} />)

    await openSidebar(user)
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    expect(await screen.findByText('Failed to submit.')).toBeInTheDocument()
    expect(screen.queryByText(/Review submitted/)).not.toBeInTheDocument()
    // submitted が立っていないので再 submit 可能
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(closeSpy).not.toHaveBeenCalled()
  })
})

describe('完了画面 (submitted state)', () => {
  test('SubmitBar Approve 成功後: fillMode 補完を含む POST 内容と一致する集計で完了画面が表示される', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload()} />)

    await openSidebar(user)
    await user.click(screen.getByRole('button', { name: 'Approve' }))

    // 完了画面の集計は「実際に POST した groupDecisions」のスナップショットから計算される。
    // fillMode='approved' で補完された未判定 g0 も集計に含まれ、POST と画面が常に一致する。
    expect(postedBody().groupDecisions).toEqual({ g0: 'approved', g1: 'approved' })
    expect(
      screen.getByText(/Review submitted \(all 2 groups approved\)/),
    ).toBeInTheDocument()
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('SubmitBar Request Changes 成功後: RC 補完分を含む集計で完了画面が表示される', async () => {
    const user = userEvent.setup()
    // g0 未判定 → fillMode='request-changes' で補完、g1 は panels=0 の自動 approved
    render(<App payload={makePayload()} />)

    await openSidebar(user)
    await user.click(screen.getByRole('button', { name: 'Request Changes' }))

    expect(postedBody().groupDecisions).toEqual({ g0: 'request-changes', g1: 'approved' })
    expect(
      screen.getByText('Review submitted (1 approved / 1 request-changes). You can close this tab.'),
    ).toBeInTheDocument()
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('全 group RC 補完の submit: "all N groups request-changes" 完了画面が表示される', async () => {
    const user = userEvent.setup()
    // 両 group が panels を持つ payload にして g0/g1 とも未判定 → RC fillMode で全件補完される
    const p2 = makePanel('p2')
    render(
      <App
        payload={makePayload({
          groups: [
            { groupId: 'g0', title: 'Group Zero', description: '', panels: [makePanel()] },
            { groupId: 'g1', title: 'Group One', description: '', panels: [p2] },
          ],
          allPanels: ['p1', 'p2'],
        })}
      />,
    )

    await openSidebar(user)
    await user.click(screen.getByRole('button', { name: 'Request Changes' }))

    expect(postedBody().groupDecisions).toEqual({ g0: 'request-changes', g1: 'request-changes' })
    expect(
      screen.getByText(/Review submitted \(all 2 groups request-changes\)/),
    ).toBeInTheDocument()
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('submit 成功後: approved / request-changes 混在の集計が完了画面に出る', async () => {
    const user = userEvent.setup()
    // restore で g0=RC が入った状態 (g1 は自動 approved) → 1 approved / 1 request-changes の混在
    render(<App payload={makePayload({ initialGroupDecisions: { g0: 'request-changes' } })} />)

    await openSidebar(user)
    await user.click(screen.getByRole('button', { name: 'Request Changes' }))

    expect(
      screen.getByText('Review submitted (1 approved / 1 request-changes). You can close this tab.'),
    ).toBeInTheDocument()
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('Comment 成功後: "Comment sent." 完了画面が表示される', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload()} />)

    await openSidebar(user)
    await user.type(screen.getByLabelText('Review-wide comment'), 'a note')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    expect(screen.getByText(/Comment sent\. You can close this tab/)).toBeInTheDocument()
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('context+ 成功後: "Requesting context expansion." 完了画面が表示される', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload()} />)

    await user.click(screen.getByRole('tab', { name: 'Guide' }))
    await user.click(withinGroup('g0').getByRole('button', { name: /More context/ }))
    await user.click(screen.getByRole('button', { name: 'Submit context+' }))

    expect(screen.getByText(/Requesting context expansion\./)).toBeInTheDocument()
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })
})

describe('auto-submit (全 group decision 確定時)', () => {
  test('最後の未判定 group を Approve すると reviewKind=approve で自動 submit され完了画面が出る', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload()} />)

    // Guide タブの GroupNav で g0 を approve → g1 は自動 approved なので全確定 → auto-submit
    await user.click(screen.getByRole('tab', { name: 'Guide' }))
    await user.click(withinGroup('g0').getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = postedBody()
    expect(body.decision).toBe('submit')
    expect(body.reviewKind).toBe('approve')
    expect(body.groupDecisions).toEqual({ g0: 'approved', g1: 'approved' })
    expect(
      await screen.findByText(/Review submitted \(all 2 groups approved\)/),
    ).toBeInTheDocument()
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('RC を含めて全確定すると reviewKind=request-changes で自動 submit される', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload()} />)

    await user.click(screen.getByRole('tab', { name: 'Guide' }))
    await user.click(withinGroup('g0').getByRole('button', { name: 'Request changes' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = postedBody()
    expect(body.decision).toBe('submit')
    expect(body.reviewKind).toBe('request-changes')
    expect(body.groupDecisions).toEqual({ g0: 'request-changes', g1: 'approved' })
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('restore で初期 decision が全埋まりでも、ユーザー操作なしには発火しない', async () => {
    render(<App payload={makePayload({ initialGroupDecisions: { g0: 'approved' } })} />)

    // auto-submit effect が走り得る時間を与えてから「発火していない」ことを観測する
    await new Promise(r => setTimeout(r, 200))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(closeSpy).not.toHaveBeenCalled()
  })
})

describe('context+ (onRequestContext 経由)', () => {
  test('decision=regen-group で currentRanges / lineCommentDrafts を送り window.close', async () => {
    const user = userEvent.setup()
    const payload = makePayload({
      initialLineCommentDrafts: { 'draft:p1:asis:2': 'unsaved draft' },
    })
    render(<App payload={payload} />)

    // Guide タブに切り替えて GroupNav の context+ を開く
    await user.click(screen.getByRole('tab', { name: 'Guide' }))
    await user.click(withinGroup('g0').getByRole('button', { name: /More context/ }))
    await user.click(screen.getByRole('button', { name: 'Submit context+' }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/^\/result\?token=/)
    expect(init.method).toBe('POST')

    const body = postedBody()
    expect(body.decision).toBe('regen-group')
    expect(body.reviewKind).toBe('comment')
    // null decision (g0) は落とし、自動 approved (g1) のみ載る
    expect(body.groupDecisions).toEqual({ g1: 'approved' })
    expect(body.regenGroup).toBeDefined()
    expect(body.regenGroup?.groupId).toBe('g0')
    expect(body.regenGroup?.note).toBeUndefined()
    expect(body.regenGroup?.currentRanges).toEqual([
      {
        panelId: 'p1',
        asIs: { file: 'src/foo.ts', ranges: [{ start: 1, end: 2 }] },
        toBe: { file: 'src/foo.ts', ranges: [{ start: 1, end: 2 }] },
      },
    ])
    // payload.initialLineCommentDrafts は sessionStorage に書き戻され、submit 時に回収される
    expect(body.lineCommentDrafts).toEqual({ 'draft:p1:asis:2': 'unsaved draft' })

    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('note 付き context+: regenGroup.note に trim 済み自由文が載る', async () => {
    const user = userEvent.setup()
    render(<App payload={makePayload()} />)

    await user.click(screen.getByRole('tab', { name: 'Guide' }))
    await user.click(withinGroup('g0').getByRole('button', { name: /More context/ }))
    await user.type(
      screen.getByPlaceholderText(/どの context を追加してほしいか/),
      '  caller も見たい  ',
    )
    await user.click(screen.getByRole('button', { name: 'Submit context+' }))

    expect(postedBody().regenGroup?.note).toBe('caller も見たい')

    // 300ms 後の window.close タイマーを test 内で消化する (次の test への漏れ込み防止)
    await waitFor(() => expect(closeSpy).toHaveBeenCalled(), { timeout: 1500 })
  })

  test('fetch 失敗時: regen 用 toast を出し、regenPending が解除されて再試行できる', async () => {
    const user = userEvent.setup()
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    render(<App payload={makePayload()} />)

    await user.click(screen.getByRole('tab', { name: 'Guide' }))
    await user.click(withinGroup('g0').getByRole('button', { name: /More context/ }))
    await user.click(screen.getByRole('button', { name: 'Submit context+' }))

    expect(await screen.findByText('Failed to request context expansion.')).toBeInTheDocument()
    expect(screen.queryByText(/Requesting context expansion/)).not.toBeInTheDocument()
    // regenPending 解除 → context+ ボタンが再度 enabled (label も非 pending に戻る)
    expect(withinGroup('g0').getByRole('button', { name: /More context/ })).toBeEnabled()
    expect(closeSpy).not.toHaveBeenCalled()
  })
})
