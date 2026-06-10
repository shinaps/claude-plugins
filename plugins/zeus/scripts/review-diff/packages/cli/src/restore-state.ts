// restore.json の読み込みと v1 → v2 auto-migration。
// cli.ts (entry) は module 末尾で main() を即時実行するため、テストから import できない。
// restore-state 移行ロジックはここに分離してユニットテスト可能にしている。

import { readFileSync } from 'node:fs'
import type {
  Comment,
  GroupDecision,
  RestoreStateV1,
  RestoreStateV2,
  ReviewKind,
  ThreadMessage,
  ThreadScope,
  ThreadSnapshot,
} from '@zeus/review-diff-shared'
import { threadKey } from '@zeus/review-diff-shared'

// readRestoreState: v2 をそのまま読む + v1 (comments[]) を auto migrate して v2 に変換する。
// 不明な field / 部分破損は黙って無視する (旧来の defensive 仕様維持)。
export function readRestoreState(path: string | undefined): RestoreStateV2 | undefined {
  if (!path) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    process.stderr.write(`[review-diff] restore-state read failed (ignored): ${e instanceof Error ? e.message : String(e)}\n`)
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<RestoreStateV2> & Partial<RestoreStateV1>

  const out: RestoreStateV2 = { schemaVersion: 2 }

  if (r.groupDecisions && typeof r.groupDecisions === 'object' && !Array.isArray(r.groupDecisions)) {
    const filtered: Record<string, GroupDecision> = {}
    for (const [k, v] of Object.entries(r.groupDecisions)) {
      if (v === 'approved' || v === 'request-changes') filtered[k] = v
    }
    if (Object.keys(filtered).length > 0) out.groupDecisions = filtered
  }
  if (r.groupComments && typeof r.groupComments === 'object' && !Array.isArray(r.groupComments)) {
    const filtered: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.groupComments)) {
      if (typeof v === 'string') filtered[k] = v
    }
    if (Object.keys(filtered).length > 0) out.groupComments = filtered
  }
  if (r.lineCommentDrafts && typeof r.lineCommentDrafts === 'object') {
    out.lineCommentDrafts = r.lineCommentDrafts as Record<string, string>
  }
  if (r.reviewKind === 'approve' || r.reviewKind === 'request-changes' || r.reviewKind === 'comment') {
    out.reviewKind = r.reviewKind as ReviewKind
  }

  // threads field の取り込み (v2)
  const threads: Record<string, ThreadSnapshot> = {}
  if (r.threads && typeof r.threads === 'object' && !Array.isArray(r.threads)) {
    for (const [k, v] of Object.entries(r.threads)) {
      const snap = parseThreadSnapshot(v)
      if (snap) threads[k] = snap
    }
  }

  // v1 互換: schemaVersion 未指定 + comments[] が来た場合は migrate する
  const wantsMigration = (r.schemaVersion == null || r.schemaVersion === 1) && Array.isArray(r.comments)
  if (wantsMigration && Array.isArray(r.comments)) {
    for (const c of r.comments) {
      const migrated = migrateCommentToThread(c)
      if (!migrated) continue
      const k = threadKey(migrated.scope)
      // v2 threads に同じキーがある場合は v2 を優先 (v1 を上書きしない)
      if (!threads[k]) threads[k] = migrated
    }
  }

  if (Object.keys(threads).length > 0) out.threads = threads
  return out
}

function parseThreadSnapshot(v: unknown): ThreadSnapshot | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Partial<ThreadSnapshot>
  if (!o.scope || typeof o.scope !== 'object') return null
  if (!Array.isArray(o.messages)) return null
  const messages: ThreadMessage[] = []
  for (const m of o.messages) {
    if (!m || typeof m !== 'object') continue
    const mm = m as Partial<ThreadMessage>
    if (typeof mm.id !== 'string' || typeof mm.body !== 'string') continue
    if (mm.author !== 'user' && mm.author !== 'agent') continue
    if (typeof mm.ts !== 'number') continue
    messages.push({
      id: mm.id,
      author: mm.author,
      body: mm.body,
      ts: mm.ts,
      agentAction: mm.agentAction,
    })
  }
  const scope = o.scope as ThreadSnapshot['scope']
  return {
    scope,
    messages,
    resolved: o.resolved === true,
    outdated: o.outdated === true,
    outdatedOverride: o.outdatedOverride === 'force' || o.outdatedOverride === 'keep' ? o.outdatedOverride : undefined,
  }
}

export function migrateCommentToThread(c: unknown): ThreadSnapshot | null {
  if (!c || typeof c !== 'object') return null
  const cc = c as Comment
  if (typeof cc.body !== 'string') return null
  if (!cc.scope || typeof cc.scope !== 'object') return null
  if (cc.scope.type === 'line') {
    const s = cc.scope
    if (typeof s.panelId !== 'string' || s.panelId === '') return null
    if (s.side !== 'asIs' && s.side !== 'toBe') return null
    if (typeof s.file !== 'string') return null
    if (typeof s.line !== 'number') return null
    return makeInitialThread(
      { type: 'line', panelId: s.panelId, side: s.side, file: s.file, line: s.line, ...(s.endLine != null ? { endLine: s.endLine } : {}) },
      cc.body,
    )
  }
  if (cc.scope.type === 'group') {
    if (typeof cc.scope.groupId !== 'string' || cc.scope.groupId === '') return null
    return makeInitialThread({ type: 'group', groupId: cc.scope.groupId }, cc.body)
  }
  if (cc.scope.type === 'file') {
    if (typeof cc.scope.file !== 'string' || cc.scope.file === '') return null
    return makeInitialThread({ type: 'file', file: cc.scope.file }, cc.body)
  }
  return null
}

// 「migrate 直後のスレッド初期状態」のルールはここ 1 箇所に集約する。
// 初期 message は人間レビュアー (author: 'user') の 1 件のみ、未解決 (resolved: false) かつ
// outdated 判定前 (outdated: false) から始まる。
function makeInitialThread(scope: ThreadScope, body: string): ThreadSnapshot {
  return {
    scope,
    messages: [{ id: cryptoRandomId(), author: 'user', body, ts: Date.now() }],
    resolved: false,
    outdated: false,
  }
}

function cryptoRandomId(): string {
  // Node 20+ では globalThis.crypto.randomUUID が標準提供される
  return globalThis.crypto.randomUUID()
}
