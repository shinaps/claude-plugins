import type { ThreadScope } from './types'

// threadKey: ThreadScope を restore.json / Map / log で一意に識別する文字列キーに変換する。
//   - group  : 'group:<groupId>'
//   - line   : 'line:<panelId>:<side>:<line>' または 'line:<panelId>:<side>:<line>:<endLine>'
//
// 既存 lineCommentKey は \x1f 区切りで衝突回避していたが、threadKey は restore.json / DOM 属性で
// 取り回す前提なので可視 ASCII のみに揃える。panelId / side / groupId は ASCII 制約があるため
// ':' 衝突は起きない (panelId は ^[A-Za-z0-9 _-]+$ で空白は - に正規化済み)。
export function threadKey(scope: ThreadScope): string {
  if (scope.type === 'group') return `group:${scope.groupId}`
  const range = scope.endLine != null ? `${scope.line}:${scope.endLine}` : `${scope.line}`
  return `line:${scope.panelId}:${scope.side}:${range}`
}
