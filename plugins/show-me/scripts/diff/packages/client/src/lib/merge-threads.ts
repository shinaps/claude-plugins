import type { ThreadMessage, ThreadSnapshot } from '@show-me/diff-shared'
import { threadKey } from '@show-me/diff-shared'
import { parseLineCommentKey } from './state'

// thread への user message 合成を担う純関数群。送信チャネルは threads に一本化されており、
// ここが pending 層 (useLineComments の Map / group textarea の書き残し) と wire format の
// 境界になる。merge 系は setState を介さず送信直前に合成する (state 反映前に fetch が走る
// race を構造的に避けるため)。appendUserMessage は単体でも export し、App の setThreads 更新
// (Comment ボタンの pending 積み / Activity タブのスレッド返信) でも同じ規約を共有する。

function userMessage(body: string): ThreadMessage {
  return { id: crypto.randomUUID(), author: 'user', body, ts: Date.now() }
}

// thread へ user message を積む。既存 thread には append しつつ resolved を倒す
// (返信待ちの open スレッドに戻す)。無ければ新規 thread を作る。
export function appendUserMessage(
  threads: Record<string, ThreadSnapshot>,
  key: string,
  scope: ThreadSnapshot['scope'],
  bodies: string[],
): Record<string, ThreadSnapshot> {
  if (bodies.length === 0) return threads
  const existing = threads[key]
  const messages = bodies.map(userMessage)
  return {
    ...threads,
    [key]: existing
      ? { ...existing, messages: [...existing.messages, ...messages], resolved: false }
      : { scope, messages, resolved: false, outdated: false },
  }
}

// 保存済み行コメント (Map: lineCommentKey → bodies) を line scope thread に合成する。
// 同一 anchor への複数コメントは 1 thread 内の連続 user message として順序を維持する。
export function mergeLineCommentsIntoThreads(
  threads: Record<string, ThreadSnapshot>,
  lineComments: Map<string, string[]>,
  panelFileMap: Map<string, { asIsFile?: string; toBeFile?: string }>,
): Record<string, ThreadSnapshot> {
  let out = threads
  for (const [key, bodies] of lineComments) {
    const { panelId, side, number, endNumber } = parseLineCommentKey(key)
    const files = panelFileMap.get(panelId) ?? {}
    // panel の対応する側の file を引く。片側 panel (純粋追加/削除) では反対側に fallback する
    const file = side === 'asIs'
      ? (files.asIsFile ?? files.toBeFile ?? '')
      : (files.toBeFile ?? files.asIsFile ?? '')
    const scope = {
      type: 'line' as const,
      panelId,
      side,
      file,
      line: number,
      ...(endNumber != null && endNumber !== number ? { endLine: endNumber } : {}),
    }
    const trimmed = bodies.map(b => b.trim()).filter(b => b !== '')
    out = appendUserMessage(out, threadKey(scope), scope, trimmed)
  }
  return out
}

// group textarea に書き残したまま submit されたコメントを group scope thread に合成する。
// 「Comment ボタンで pending に積む」が正規動線だが、書き残しを落とさないための救済。
export function mergeGroupCommentsIntoThreads(
  threads: Record<string, ThreadSnapshot>,
  groupComments: Record<string, string>,
): Record<string, ThreadSnapshot> {
  let out = threads
  for (const [groupId, body] of Object.entries(groupComments)) {
    const trimmed = body.trim()
    if (trimmed === '') continue
    const scope = { type: 'group' as const, groupId }
    out = appendUserMessage(out, threadKey(scope), scope, [trimmed])
  }
  return out
}
