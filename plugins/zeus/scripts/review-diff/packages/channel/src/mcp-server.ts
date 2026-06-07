// review-diff Channels MCP server (Process A)。
//
// 役割:
//   - Claude Code が `--dangerously-load-development-channels server:review-diff` で
//     spawn する Stdio MCP server。
//   - 起動時 + 5 秒 interval + reply tool 受信時に ~/.claude/zeus/review-diffs/active/ を
//     全走査し、生きている session (process.kill(pid, 0) で確認) ごとに
//     /events/channel への SSE 購読を維持する。
//   - SSE で受けた 'feedback-sent' イベントを mcp.notification として Claude Code に転送
//     (meta: sessionId / groupId / direction / currentRanges)。
//   - tools.reply({sessionId, groupId, panels}) で Claude Code から再生成結果を受けて
//     /channel/inbox?token=<channelToken> に POST する。
//
// 設計判断:
//   - mcp.notification の content (= 文字列) に sessionId / groupId / direction を埋め込み、
//     Claude Code がプロンプト上で直接読み取れる形にする。実データは meta にも入れて
//     parser 側 (Claude Code) がどちらでも取り出せるようにする。
//   - stale session の検出: 各 session.json を読んだ後 process.kill(pid, 0) で確認。
//     EPERM (= 別ユーザー所有 / 権限不足) は ESRCH と区別しないと「他人のプロセスが居る」と
//     誤判定するが、~/.claude 以下は自ユーザー所有なので EPERM はほぼ起こらない設計。
//   - reply tool は SDK が zod 任意 schema を許すため、最小の inputSchema (JSON Schema) で宣言し、
//     handler 内で arguments を unknown 経由で取り出す (sdk の generic は避けて bundle size 抑制)。
//   - console.log は禁止。MCP の Stdio は stdout を JSON-RPC で占有するため、
//     ログは全て process.stderr.write を使う。

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { EventSource } from 'eventsource'
import { readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type SessionEnv = {
  sessionId: string
  pid: number
  hubUrl: string
  browserToken: string
  channelToken: string
  createdAt: number
}

export const ACTIVE_DIR = join(homedir(), '.claude/zeus/review-diffs/active')
export const POLL_INTERVAL_MS = 5000

// テスト時に注入可能にするための fs / process 抽象。
export type SessionScannerDeps = {
  activeDir?: string
  readdir?: (dir: string) => string[]
  readJson?: (path: string) => unknown
  unlink?: (path: string) => void
  isAlive?: (pid: number) => boolean
  log?: (msg: string) => void
}

const defaultDeps = (): Required<SessionScannerDeps> => ({
  activeDir: ACTIVE_DIR,
  readdir: (d) => {
    try { return readdirSync(d) } catch { return [] }
  },
  readJson: (p) => JSON.parse(readFileSync(p, 'utf8')) as unknown,
  unlink: (p) => { try { unlinkSync(p) } catch { /* race OK */ } },
  isAlive: (pid) => {
    try { process.kill(pid, 0); return true }
    catch { return false }
  },
  log: (m) => process.stderr.write(m),
})

// active/ を走査して { 生存 session の SessionEnv 配列, 死亡で unlink した sessionId 配列 } を返す。
// テスト容易性のため fs/process は deps 経由で差し替え可能。
export function listActiveSessions(deps?: SessionScannerDeps): {
  alive: SessionEnv[]
  reaped: string[]
} {
  const d = { ...defaultDeps(), ...deps }
  const entries = d.readdir(d.activeDir)
  const alive: SessionEnv[] = []
  const reaped: string[] = []
  for (const f of entries) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue
    const full = join(d.activeDir, f)
    let env: SessionEnv
    try {
      env = d.readJson(full) as SessionEnv
    } catch {
      // malformed JSON は skip (atomic write 経路だと普通起こらないが防御)
      continue
    }
    if (typeof env.pid !== 'number' || typeof env.sessionId !== 'string') continue
    if (d.isAlive(env.pid)) {
      alive.push(env)
    } else {
      d.unlink(full)
      reaped.push(env.sessionId)
    }
  }
  return { alive, reaped }
}

// SSE で受けた 'feedback-sent' イベントを mcp.notification にマップする純関数。
// raw は SSE event.data (JSON 文字列)、env は session metadata。
// 失敗時は null を返して呼び出し側で skip させる (notification を発火しない)。
export function buildNotificationFromFeedback(rawData: string, env: SessionEnv): {
  method: 'notifications/claude/channel'
  params: { content: string; meta: Record<string, unknown> }
} | null {
  let payload: {
    groupId?: unknown
    direction?: unknown
    currentRanges?: unknown
  }
  try {
    payload = JSON.parse(rawData)
  } catch {
    return null
  }
  if (typeof payload.groupId !== 'string') return null
  if (payload.direction !== 'more' && payload.direction !== 'less') return null
  const currentRanges = Array.isArray(payload.currentRanges) ? payload.currentRanges : []
  // content は Claude Code がプロンプト上で読み取る人間可読 + 機械パースしやすい形式。
  // meta に同じ情報を構造化して入れることで、Claude Code 側のどちらの経路でも復元できるようにする。
  return {
    method: 'notifications/claude/channel',
    params: {
      content:
        `<channel source="review-diff" event="regen-group" ` +
        `session_id="${env.sessionId}" group_id="${payload.groupId}" ` +
        `direction="${payload.direction}">`,
      meta: {
        sessionId: env.sessionId,
        groupId: payload.groupId,
        direction: payload.direction,
        currentRanges,
      },
    },
  }
}

// reply tool handler の純関数版。fetch を差し替え可能にしてテストする。
// 戻り値: { ok: true } で MCP に "sent" を返す、ok=false なら ToolError 風メッセージを返す。
export async function performReply(
  args: { sessionId: unknown; groupId: unknown; panels: unknown },
  sessions: Map<string, SessionEnv>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  if (typeof args.sessionId !== 'string' || typeof args.groupId !== 'string') {
    return { ok: false, text: 'reply: sessionId and groupId must be strings' }
  }
  if (!Array.isArray(args.panels)) {
    return { ok: false, text: 'reply: panels must be an array' }
  }
  const env = sessions.get(args.sessionId)
  if (!env) {
    // 死んだ session への reply は静かに discard (Claude Code 側で stale な notification に
    // 反応した可能性、または session 終了タイミングと competing)。
    return { ok: true, text: `session ${args.sessionId} not active; reply discarded` }
  }
  const res = await fetchImpl(
    `${env.hubUrl}/channel/inbox?token=${encodeURIComponent(env.channelToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: args.groupId, panels: args.panels }),
    },
  )
  if (!res.ok) {
    return { ok: false, text: `hub returned ${res.status}` }
  }
  return { ok: true, text: 'sent' }
}

// reconcile: 現在生存している session に SSE 接続を確保し、消えた session の接続を閉じる。
// SSE 接続の差分管理は sessionMap で行い、map の更新と SSE listener wiring を一気に行う。
export type SessionMap = Map<string, { env: SessionEnv; sse: EventSource }>

export function reconcileSessions(params: {
  sessionMap: SessionMap
  alive: SessionEnv[]
  onFeedback: (env: SessionEnv, rawData: string) => void
  makeEventSource?: (url: string) => EventSource
}): void {
  const make = params.makeEventSource ?? ((u) => new EventSource(u))
  const aliveIds = new Set(params.alive.map(e => e.sessionId))

  for (const env of params.alive) {
    if (params.sessionMap.has(env.sessionId)) continue
    const sse = make(
      `${env.hubUrl}/events/channel?token=${encodeURIComponent(env.channelToken)}`,
    )
    sse.addEventListener('feedback-sent', (e) => {
      const msgEvent = e as MessageEvent
      params.onFeedback(env, String(msgEvent.data ?? ''))
    })
    // SSE は native 自動再接続を持つので onerror では再接続を強制しない。
    sse.onerror = () => { /* native auto-reconnect */ }
    params.sessionMap.set(env.sessionId, { env, sse })
  }

  // 消えた session の SSE を閉じて map から外す
  for (const [id, s] of params.sessionMap) {
    if (!aliveIds.has(id)) {
      try { s.sse.close() } catch { /* noop */ }
      params.sessionMap.delete(id)
    }
  }
}

// =====================================================================
// MCP server エントリ (mcp Stdio + reconcile loop)。bin.ts から呼ばれる。
// =====================================================================

export type RunOptions = {
  pollIntervalMs?: number
}

export async function runMcpServer(options: RunOptions = {}): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const sessionMap: SessionMap = new Map()

  const mcp = new Server(
    { name: 'review-diff', version: '4.7.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions:
        'Feedback events arrive as <channel source="review-diff" event="regen-group" ' +
        'session_id="..." group_id="..." direction="more|less"> with meta.currentRanges. ' +
        'Re-generate panels for the group and call the `reply` tool with ' +
        '{ sessionId, groupId, panels } matching the Panel schema (panelId, intent, asIs?, toBe?).',
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'reply',
      description: 'Send regenerated panels back to the review-diff browser via SSE',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          groupId: { type: 'string' },
          panels: { type: 'array' },
        },
        required: ['sessionId', 'groupId', 'panels'],
      },
    }],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'reply') {
      throw new Error(`unknown tool: ${req.params.name}`)
    }
    // reply 受信時にも reconcile (まだ map に居なければ active/ を読み直す)
    const { alive } = listActiveSessions()
    const idToEnv = new Map<string, SessionEnv>(alive.map(e => [e.sessionId, e]))
    // sessionMap も合流させる (起動済み接続情報を優先、見当たらない新規は active から)
    for (const [id, s] of sessionMap) idToEnv.set(id, s.env)

    const result = await performReply(
      req.params.arguments as { sessionId: unknown; groupId: unknown; panels: unknown },
      idToEnv,
    )
    if (!result.ok) {
      // SDK は throw で error response を返す。reply tool の意味的失敗をエラーとして伝える。
      throw new Error(result.text)
    }
    return { content: [{ type: 'text', text: result.text }] }
  })

  await mcp.connect(new StdioServerTransport())

  // SSE 経由で feedback を受けた時の callback。
  // mcp.notification は Promise を返すが catch でログだけ吐いて握り潰す
  // (通知失敗で reconcile ループを止めない)。
  const handleFeedback = (env: SessionEnv, rawData: string) => {
    const n = buildNotificationFromFeedback(rawData, env)
    if (!n) return
    mcp.notification(n).catch((err) => {
      process.stderr.write(
        `[channel-server] notification failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    })
  }

  const tick = () => {
    const { alive, reaped } = listActiveSessions()
    if (reaped.length > 0) {
      process.stderr.write(`[channel-server] reaped stale sessions: ${reaped.join(', ')}\n`)
    }
    reconcileSessions({ sessionMap, alive, onFeedback: handleFeedback })
  }

  // 起動時 + 定期 reconcile
  tick()
  const timer = setInterval(tick, pollIntervalMs)
  timer.unref()

  // SIGINT/SIGTERM で SSE をすべて閉じる (listener leak を防ぐ)
  const closeAll = () => {
    for (const [, s] of sessionMap) {
      try { s.sse.close() } catch { /* noop */ }
    }
    sessionMap.clear()
  }
  process.on('SIGINT', () => { closeAll(); process.exit(130) })
  process.on('SIGTERM', () => { closeAll(); process.exit(143) })
}
