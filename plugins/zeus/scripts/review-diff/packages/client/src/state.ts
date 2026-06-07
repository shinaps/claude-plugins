// React アプリが起動時に読む副作用ヘルパー。
// useState 周りの state 型はそれぞれの component 内に閉じているので、ここには置かない。

import type { ClientPayload, Side } from '@zeus/review-diff-shared'

export function getPayload(): ClientPayload {
  const el = document.getElementById('payload')
  if (!el) throw new Error('payload script element not found')
  return JSON.parse(el.textContent || '{}') as ClientPayload
}

export function getToken(): string {
  return new URL(location.href).searchParams.get('token') ?? ''
}

// 行コメントの内部キー (v4.7.0 panel model)。
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
