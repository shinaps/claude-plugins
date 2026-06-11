// restore.json の読み込みと v1 → v2 auto-migration。
// cli.ts (entry) は module 末尾で main() を即時実行するため、テストから import できない。
// restore-state 移行ロジックはここに分離してユニットテスト可能にしている。

import { readFileSync } from 'node:fs'
import type {
  AgentAction,
  Comment,
  GroupDecision,
  RestoreStateV1,
  RestoreStateV2,
  ReviewKind,
  ThreadMessage,
  ThreadScope,
  ThreadSnapshot,
} from '@show-me/diff-shared'
import { threadKey } from '@show-me/diff-shared'

// readRestoreState: v2 をそのまま読む + v1 (comments[]) を auto migrate して v2 に変換する。
// 不明な field / 部分破損は黙って無視する (旧来の defensive 仕様維持)。
export function readRestoreState(path: string | undefined): RestoreStateV2 | undefined {
  if (!path) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    process.stderr.write(`[show-me:diff] restore-state read failed (ignored): ${e instanceof Error ? e.message : String(e)}\n`)
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
  if (r.lineCommentDrafts && typeof r.lineCommentDrafts === 'object' && !Array.isArray(r.lineCommentDrafts)) {
    const filtered: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.lineCommentDrafts)) {
      if (typeof v === 'string') filtered[k] = v
    }
    if (Object.keys(filtered).length > 0) out.lineCommentDrafts = filtered
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

// ThreadScope の唯一の検証器。restore.json の v2 threads / v1 comments / mark-outdated の
// read-modify-write がすべてここを通ることで、scope の防御水準を 1 箇所に集約する。
// 既知フィールドのみで canonical オブジェクトを再構築して返すのは、未知フィールドの混入で
// threadKey() の安定性が壊れるのを防ぐため。
// line scope の file は空文字も許容する (v1 migration からの既存契約)。group / file scope の
// id は空文字だと threadKey が他とぶつかり得るため非空必須。
export function parseThreadScope(v: unknown): ThreadScope | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  if (s.type === 'line') {
    if (typeof s.panelId !== 'string' || s.panelId === '') return null
    if (s.side !== 'asIs' && s.side !== 'toBe') return null
    if (typeof s.file !== 'string') return null
    if (typeof s.line !== 'number') return null
    return {
      type: 'line',
      panelId: s.panelId,
      side: s.side,
      file: s.file,
      line: s.line,
      ...(typeof s.endLine === 'number' ? { endLine: s.endLine } : {}),
    }
  }
  if (s.type === 'group') {
    if (typeof s.groupId !== 'string' || s.groupId === '') return null
    return { type: 'group', groupId: s.groupId }
  }
  if (s.type === 'file') {
    if (typeof s.file !== 'string' || s.file === '') return null
    return { type: 'file', file: s.file }
  }
  if (s.type === 'review') {
    return { type: 'review' }
  }
  return null
}

// agentAction は対応種別の表示メタデータで、欠けてもスレッド本文は成立する。
// 不正なら undefined を返してメッセージ自体は残す (message ごと drop すると会話履歴が消える)。
function parseAgentAction(v: unknown): AgentAction | undefined {
  if (!v || typeof v !== 'object') return undefined
  const a = v as Record<string, unknown>
  if (a.kind === 'answer') return { kind: 'answer' }
  if (a.kind === 'suggest') {
    return { kind: 'suggest', ...(typeof a.diffSample === 'string' ? { diffSample: a.diffSample } : {}) }
  }
  if (a.kind === 'apply') {
    if (!Array.isArray(a.files)) return undefined
    const files: { path: string; summary: string }[] = []
    for (const f of a.files) {
      if (!f || typeof f !== 'object') continue
      const ff = f as Record<string, unknown>
      if (typeof ff.path !== 'string' || typeof ff.summary !== 'string') continue
      files.push({ path: ff.path, summary: ff.summary })
    }
    return { kind: 'apply', files }
  }
  if (a.kind === 'expand') {
    if (!Array.isArray(a.addedPanelIds)) return undefined
    return { kind: 'expand', addedPanelIds: a.addedPanelIds.filter((p): p is string => typeof p === 'string') }
  }
  return undefined
}

// readRestoreState (v2 経路) と mark-outdated の双方から使う thread 検証器。
// scope が判別できない thread は null を返す。呼び出し側の扱いは経路ごとに異なる:
// readRestoreState は drop (UI に不正データを流さない)、mark-outdated は判定 skip + 原文温存。
export function parseThreadSnapshot(v: unknown): ThreadSnapshot | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Partial<ThreadSnapshot>
  const scope = parseThreadScope(o.scope)
  if (!scope) return null
  if (!Array.isArray(o.messages)) return null
  const messages: ThreadMessage[] = []
  for (const m of o.messages) {
    if (!m || typeof m !== 'object') continue
    const mm = m as Partial<ThreadMessage>
    if (typeof mm.id !== 'string' || typeof mm.body !== 'string') continue
    if (mm.author !== 'user' && mm.author !== 'agent') continue
    if (typeof mm.ts !== 'number') continue
    const agentAction = parseAgentAction(mm.agentAction)
    messages.push({
      id: mm.id,
      author: mm.author,
      body: mm.body,
      ts: mm.ts,
      ...(agentAction ? { agentAction } : {}),
    })
  }
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
  const scope = parseThreadScope(cc.scope)
  // v1 Comment の scope は line / group / file の 3 種のみ (review thread は v5 で導入され
  // v1 データには存在しない契約) なので、review は migrate 対象外として拒否する。
  if (!scope || scope.type === 'review') return null
  return makeInitialThread(scope, cc.body)
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
