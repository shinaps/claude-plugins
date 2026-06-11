// React アプリが起動時に読む副作用ヘルパー。
// useState 周りの state 型はそれぞれの component 内に閉じているので、ここには置かない。

import type { ClientPayload, Side } from '@show-me/diff-shared'

export function getPayload(): ClientPayload {
  const el = document.getElementById('payload')
  if (!el) throw new Error('payload script element not found')
  return JSON.parse(el.textContent || '{}') as ClientPayload
}

export function getToken(): string {
  return new URL(location.href).searchParams.get('token') ?? ''
}

// CLI 側に「タブがまだ生きている」と知らせる heartbeat の送出ループを起動する。
// 設計: CLI は最終 ping から 15 秒経過したら「タブが閉じられた」と判断して exit するため、
// 5 秒間隔で /heartbeat を打って 3 回連続損失で初めて判定が発火するようにする。
// fetch は keepalive: true で「unload 直前に発火した最後の 1 発も配信を試みる」が、
// 普通のタブ close では新規 ping が止まる → 15s 後に CLI が自発的に exit する流れ。
// errors は黙殺 (network 詰まり / abort で続く ping 自体は止めない)。
export function startHeartbeat(): () => void {
  const token = getToken()
  if (!token) return () => {}
  let stopped = false
  const send = () => {
    if (stopped) return
    try {
      void fetch(`/heartbeat?token=${encodeURIComponent(token)}`, {
        method: 'GET',
        keepalive: true,
        cache: 'no-store',
      }).catch(() => { /* ignore */ })
    } catch { /* ignore */ }
  }
  // 初回は即時、その後 5 秒間隔。CLI 側 boot grace 30s 内に届けば「初回 ping 来た」扱いで安心。
  send()
  const interval = window.setInterval(send, 5000)
  return () => {
    stopped = true
    window.clearInterval(interval)
  }
}

// 行コメントの内部キー (panel model)。
//   単一行:   `${panelId}\x1f${side}\x1f${number}`
//   行範囲:   `${panelId}\x1f${side}\x1f${number}\x1f${endNumber}`
//
// 設計判断:
//   - panelId アンカーにすることで AC-6 (panel 跨ぎコメント不可) と整合
//   - side は 'asIs' | 'toBe' (TS の内部表現)。DOM 書き出しは shared/sideToAttr で 'asis'/'tobe' に
//   - 区切り子 \x1f は維持。panelId は zod 側で `^[A-Za-z0-9 _-]+$` に sanitize 済みのため衝突しない
//   - 単一行は 4 セグメント目を省略する (range と単一を JSON shape で区別可能に)
export function lineCommentKey(
  panelId: string,
  side: Side,
  number: number,
  endNumber?: number,
): string {
  if (endNumber != null && endNumber !== number) {
    return `${panelId}\x1f${side}\x1f${number}\x1f${endNumber}`
  }
  return `${panelId}\x1f${side}\x1f${number}`
}

export function parseLineCommentKey(
  key: string,
): { panelId: string; side: Side; number: number; endNumber?: number } {
  const [panelId, side, num, end] = key.split('\x1f')
  const result: { panelId: string; side: Side; number: number; endNumber?: number } = {
    panelId,
    side: side as Side,
    number: Number(num),
  }
  if (end != null && end !== '') result.endNumber = Number(end)
  return result
}
