// /events/browser を購読し、context+/- ボタンの POST + 連打防止 + タイムアウト + orphan draft purge
// を 1 つの hook に閉じ込める。
//
// 状態モデル (5 状態):
//   - disabled       : channelsEnabled=false。EventSource を生成しない (= ボタンも disabled)
//   - connecting     : enabled=true で EventSource 生成直後、'open' イベント未着
//   - open           : 'open' イベント受信済み
//   - reconnecting   : 'error' を open 状態で受けた (= 切断 → EventSource 内部で自動再接続中)
//   - closed         : 'error' を connecting 状態で受けた / sendFeedback 後 30 秒経過しても
//                       'panels-updated' が来なかった (= Claude 側応答なし)
//
// なぜ自前 reconnect を持たない:
//   標準 EventSource は接続切断時に自動で再接続し、その間に再 fire する 'error' を上位に伝える。
//   自前で close → new EventSource すると再接続中の重複接続や leak の原因になるため、
//   ステータス表示のためだけに 'error' を観測する。
//
// 連打防止 + timeout:
//   1 つの group に対する feedback は「直前の panels-updated を受け取るまで」次のものを受けない。
//   30 秒応答が無ければ pending を解除して closed 扱いに落とす (ユーザーが再試行できるよう)。
//
// orphan draft purge (B4):
//   panels-updated 受信時、新しい panelId 集合に存在しない sessionStorage draft (`draft:` prefix) を削除する。
//   これにより「context+ で panel が再生成されて旧 panelId が消えた場合、旧 panel への未保存 draft が
//   永遠にゴミとして残る」事故を防ぐ。

import { useCallback, useEffect, useRef, useState } from 'react'

export type ChannelStatus = 'disabled' | 'connecting' | 'open' | 'reconnecting' | 'closed'

const FEEDBACK_TIMEOUT_MS = 30_000

export type CurrentRange = {
  panelId: string
  asIs?: { file: string; ranges: { start: number; end: number }[] }
  toBe?: { file: string; ranges: { start: number; end: number }[] }
}

export type UseChannelSSEParams = {
  enabled: boolean
  browserToken: string
  sessionId: string
  // 受信した groupId に対応する **その group の旧 panelId 集合** を返すゲッタ。
  // panels-updated イベントを受けたら「この group が前回持っていた panel」だけが
  // orphan draft purge の比較対象になる。これがないと SSE で 1 group を更新するたびに
  // 他 group の draft が「oldIds にあるが newIds にない」と誤判定されて巻き添えで消える (C-1)。
  getPanelIdsForGroup: (groupId: string) => Set<string>
  // panels-updated 受信時の callback。App.tsx 側で groupId 単位の setGroups を行う。
  onPanelsUpdated: (groupId: string, panels: Array<{ panelId: string }>) => void
}

export type UseChannelSSEResult = {
  status: ChannelStatus
  // 連打防止用: いま feedback を待っている groupId。null = 受付可能。
  pendingGroupId: string | null
  sendFeedback: (
    groupId: string,
    direction: 'more' | 'less',
    currentRanges: CurrentRange[],
  ) => Promise<void>
}

// テスト容易性のために fetch / EventSource / Storage / Timer を注入可能にする。
export type ChannelSSEDeps = {
  fetchImpl?: typeof fetch
  makeEventSource?: (url: string) => EventSource
  storage?: Pick<Storage, 'length' | 'key' | 'removeItem'>
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

export function useChannelSSE(
  params: UseChannelSSEParams,
  deps: ChannelSSEDeps = {},
): UseChannelSSEResult {
  const { enabled, browserToken, sessionId, getPanelIdsForGroup, onPanelsUpdated } = params
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const makeEventSource = deps.makeEventSource ?? ((u: string) => new EventSource(u))
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout

  const [status, setStatus] = useState<ChannelStatus>(enabled ? 'connecting' : 'disabled')
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null)

  // handler を最新参照に保つ ref (effect の依存配列に入れず closures の stale 問題を回避)
  const onPanelsUpdatedRef = useRef(onPanelsUpdated)
  onPanelsUpdatedRef.current = onPanelsUpdated
  const getPanelIdsForGroupRef = useRef(getPanelIdsForGroup)
  getPanelIdsForGroupRef.current = getPanelIdsForGroup

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 連打判定は state の遅延を回避するため ref で同期的に読む
  const pendingRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) {
      setStatus('disabled')
      return
    }
    setStatus('connecting')
    const es = makeEventSource(
      `/events/browser?token=${encodeURIComponent(browserToken)}`,
    )
    const onOpenEvt = () => setStatus('open')
    const onErrorEvt = () => {
      // EventSource は接続済み (open) からの error → 自動再接続中、
      // 接続前 (connecting) からの error → 接続失敗 (open に到達できない)。
      setStatus(prev => prev === 'open' ? 'reconnecting' : 'closed')
    }
    const onUpdated = (e: Event) => {
      const msg = e as MessageEvent
      let payload: { groupId?: unknown; panels?: unknown }
      try {
        payload = JSON.parse(String(msg.data ?? ''))
      } catch { return }
      if (typeof payload.groupId !== 'string' || !Array.isArray(payload.panels)) return
      // pendingGroupId 解除 + timeout キャンセル
      if (timeoutRef.current != null) {
        clearTimeoutImpl(timeoutRef.current)
        timeoutRef.current = null
      }
      pendingRef.current = null
      setPendingGroupId(null)
      const panels = payload.panels as Array<{ panelId: string }>
      // **purge は受信 groupId の旧 panel 集合だけを対象にする** (C-1 修正)。
      // 全 group flatten した knownPanelIds を渡すと、他 group の panel が「oldIds にあり
      // newIds に無い」と誤判定され、巻き添えで draft が消える事故が起きる。
      // App.tsx 側から「この groupId が前回持っていた panel」を返すゲッタを渡してもらう。
      const oldIdsForGroup = getPanelIdsForGroupRef.current(payload.groupId)
      onPanelsUpdatedRef.current(payload.groupId, panels)
      const newIds = new Set(panels.map(p => p.panelId))
      purgeOrphanDrafts(oldIdsForGroup, newIds, deps.storage)
    }

    es.addEventListener('open', onOpenEvt)
    es.addEventListener('error', onErrorEvt)
    es.addEventListener('panels-updated', onUpdated as EventListener)

    return () => {
      es.removeEventListener('open', onOpenEvt)
      es.removeEventListener('error', onErrorEvt)
      es.removeEventListener('panels-updated', onUpdated as EventListener)
      try { es.close() } catch { /* noop */ }
    }
    // ハンドラは ref 経由で最新化済み。enabled/browserToken が変わった場合のみ EventSource を作り直す。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, browserToken])

  const sendFeedback = useCallback(async (
    groupId: string,
    direction: 'more' | 'less',
    currentRanges: CurrentRange[],
  ): Promise<void> => {
    // 連打防止: pendingRef が既に立っていれば即 return (state の遅延を待たない)
    if (pendingRef.current != null) return
    pendingRef.current = groupId
    setPendingGroupId(groupId)
    timeoutRef.current = setTimeoutImpl(() => {
      pendingRef.current = null
      setPendingGroupId(null)
      // 30 秒応答なしは Claude 側応答なし → closed として再開可能にする
      setStatus(prev => prev === 'open' ? 'closed' : prev)
    }, FEEDBACK_TIMEOUT_MS)
    try {
      await fetchImpl(`/feedback?token=${encodeURIComponent(browserToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, groupId, direction, currentRanges }),
      })
    } catch {
      // POST 自体の失敗 (network) なら spinner を即解除して再試行可能にする
      if (timeoutRef.current != null) {
        clearTimeoutImpl(timeoutRef.current)
        timeoutRef.current = null
      }
      pendingRef.current = null
      setPendingGroupId(null)
    }
  }, [browserToken, sessionId, fetchImpl, setTimeoutImpl, clearTimeoutImpl])

  return { status, pendingGroupId, sendFeedback }
}

// sessionStorage の `draft:` prefix で始まる key を走査し、panelId が「再生成前 (oldIds) には居たが
// 再生成後 (newIds) には居ない」ものを remove する。draft の key 形式: `draft:${panelId}:${side}:${num}[:${endNum}]`
export function purgeOrphanDrafts(
  oldIds: Set<string>,
  newIds: Set<string>,
  storage?: Pick<Storage, 'length' | 'key' | 'removeItem'>,
): void {
  const s = storage ?? (typeof sessionStorage !== 'undefined' ? sessionStorage : undefined)
  if (!s) return
  try {
    // 削除中にインデックスがずれないよう一旦 key を集めてから削除
    const toRemove: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (!k || !k.startsWith('draft:')) continue
      // `draft:<panelId>:<side>:<num>[:<endNum>]`。panelId 部分は ':' を含まない (sanitize 済)
      const segments = k.slice('draft:'.length).split(':')
      const panelId = segments[0]
      if (oldIds.has(panelId) && !newIds.has(panelId)) {
        toRemove.push(k)
      }
    }
    for (const k of toRemove) s.removeItem(k)
  } catch { /* storage unavailable */ }
}
