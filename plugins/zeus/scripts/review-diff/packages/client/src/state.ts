// React アプリが起動時に読む副作用ヘルパー。
// useState 周りの state 型はそれぞれの component 内に閉じているので、ここには置かない。

import type { ClientPayload } from '@zeus/review-diff-shared'

export function getPayload(): ClientPayload {
  const el = document.getElementById('payload')
  if (!el) throw new Error('payload script element not found')
  return JSON.parse(el.textContent || '{}') as ClientPayload
}

export function getToken(): string {
  return new URL(location.href).searchParams.get('token') ?? ''
}

// 行コメントの内部キー。
//   単一行:   `${file}\x1f${side}\x1f${number}`
//   行範囲:   `${file}\x1f${side}\x1f${number}\x1f${endNumber}`
// US (0x1f) を区切り子にしているのは、ファイルパスに含まれ得る ':' や '/' と衝突しないようにするため。
// 単一行は 4 セグメント目を省略することで、既存の単一行コメント (range 機能登場前) との
// シリアライズ互換を保つ。App / DiffTable 双方から参照されるためここに置く (循環 import 回避)。
export function lineCommentKey(
  file: string,
  side: 'left' | 'right',
  number: number,
  endNumber?: number,
): string {
  if (endNumber != null && endNumber !== number) {
    return `${file}\x1f${side}\x1f${number}\x1f${endNumber}`
  }
  return `${file}\x1f${side}\x1f${number}`
}
export function parseLineCommentKey(
  key: string,
): { file: string; side: 'left' | 'right'; number: number; endNumber?: number } {
  const [file, side, num, end] = key.split('\x1f')
  const result: { file: string; side: 'left' | 'right'; number: number; endNumber?: number } = {
    file,
    side: side as 'left' | 'right',
    number: Number(num),
  }
  if (end != null && end !== '') result.endNumber = Number(end)
  return result
}
