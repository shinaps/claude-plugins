// React アプリが起動時に読む副作用ヘルパー。
// useState 周りの state 型はそれぞれの component 内に閉じているので、ここには置かない。

import type { ClientPayload } from '../server-side/types.js'

export function getPayload(): ClientPayload {
  const el = document.getElementById('payload')
  if (!el) throw new Error('payload script element not found')
  return JSON.parse(el.textContent || '{}') as ClientPayload
}

export function getToken(): string {
  return new URL(location.href).searchParams.get('token') ?? ''
}

// 行コメントの内部キー。`${file}\x1f${side}\x1f${number}` で組み立てる。
// US (0x1f) を区切り子にしているのは、ファイルパスに含まれ得る ':' や '/' と衝突しないようにするため。
// App / DiffTable 双方から参照されるためここに置く (循環 import 回避)。
export function lineCommentKey(file: string, side: 'left' | 'right', number: number): string {
  return `${file}\x1f${side}\x1f${number}`
}
export function parseLineCommentKey(
  key: string,
): { file: string; side: 'left' | 'right'; number: number } {
  const [file, side, num] = key.split('\x1f')
  return { file, side: side as 'left' | 'right', number: Number(num) }
}
