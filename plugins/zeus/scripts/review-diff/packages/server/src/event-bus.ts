// in-memory pub/sub。1 channel = 1 event 種別を扱う。
//
// 設計判断:
//   - SSE endpoint を /events/browser と /events/channel に分離する設計に対応し、
//     event 種別ごとに購読チャネルを分ける (= 種別キー付き Map で listener を持つ)。
//     こうすることで /events/browser が 'feedback-sent' を誤って受け取る、
//     逆に /events/channel が 'panels-updated' を漏らすといった「cross-channel 誤配信」を
//     型レベルで防ぐ。
//   - 1 listener が throw しても他の listener を巻き込まない (try/catch ガード)。
//     SSE writer のリモート切断などで listener が落ちるケースで連鎖障害を起こさない。
//   - unsubscribe は subscribe の戻り値 () => void で返す。手動 listener id 管理を不要にする。

import type { FeedbackEvent, PanelsUpdatedEvent } from '@zeus/review-diff-shared'

export type EventBusEventMap = {
  'feedback-sent': FeedbackEvent
  'panels-updated': PanelsUpdatedEvent
}

type Listener<K extends keyof EventBusEventMap> = (e: EventBusEventMap[K]) => void

export class EventBus {
  private listeners: { [K in keyof EventBusEventMap]: Set<Listener<K>> } = {
    'feedback-sent': new Set(),
    'panels-updated': new Set(),
  }

  subscribe<K extends keyof EventBusEventMap>(type: K, l: Listener<K>): () => void {
    // TypeScript 上の K -> Set<Listener<K>> の関連を index した瞬間に
    // distributive な union 型に落ちるため、ローカルで型をリバインドして add する。
    const set = this.listeners[type] as unknown as Set<Listener<K>>
    set.add(l)
    return () => { set.delete(l) }
  }

  publish<K extends keyof EventBusEventMap>(type: K, e: EventBusEventMap[K]): void {
    const set = this.listeners[type] as unknown as Set<Listener<K>>
    for (const l of set) {
      try { l(e) } catch { /* 1 listener fail で他の listener を巻き込まない */ }
    }
  }

  size(type: keyof EventBusEventMap): number {
    return this.listeners[type].size
  }
}
