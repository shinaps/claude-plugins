import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import picomatch from 'picomatch'
import type { ScriptConfig, ScriptResult, ScriptResultsPayload } from '@show-me/diff-shared'
import { loadReviewDiffConfig } from './config.js'

// Phase 4.5 (script gate) を実行するための CLI 内部ロジック。
//   - config.scripts[] を picomatch でフィルタ
//   - 並列起動 (Promise.all)、各 script の stdout/stderr を per-script buffer に貯める (混線回避)
//   - timeout / spawn error / exit code を集計
//   - script は detached spawn (process group) で起動し、timeout 時は group ごと kill。
//     resolve は 'close' (完全 flush) と 'exit' + 猶予 (孫が pipe を握っても保証) の二重経路
//   - 1 つでも failed があれば stderr にレポートを書き出して exit 1 を呼び側で立てる
//   - 全 pass (skipped 含む) なら script-results.json を書いて exit 0
//
// run-scripts subcommand は CLI dispatcher 経由で起動される (cli.ts dispatcher 参照)。

export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000
// 1 script 当たりの stdout/stderr 上限。超過分は捨てて tail だけ残す (= 起動からの先頭ではなく
// 末尾を残して fail 解析の手がかりを優先)。
const BUFFER_LIMIT_BYTES = 5 * 1024 * 1024
const TAIL_LINES = 50
// 'exit' 受信から resolve までの flush 猶予。'close' は孫プロセスが pipe fd を継承・保持して
// いると永遠に発火しないため、'exit' + この猶予を resolve の保証経路にする ('close' が猶予内に
// 来ればそちらが先に finish して完全な tail が取れる)。
const EXIT_FLUSH_GRACE_MS = 200

export type RunScriptsArgs = {
  configPath: string | null | undefined
  changedFilesPath: string
  outPath: string
  // 環境変数のオーバーライド (テスト用)。
  envOverride?: NodeJS.ProcessEnv
}

export type RunScriptsResult = {
  payload: ScriptResultsPayload
  // 1 つでも failed があるか。呼び出し側が exit code を決める。
  hasFailure: boolean
  // stderr に書き出すレポート (失敗時の人間向け出力)。
  failureReport: string
}

export async function runScripts(args: RunScriptsArgs): Promise<RunScriptsResult> {
  const { config } = loadReviewDiffConfig(args.configPath ?? undefined)
  const scripts = config.scripts ?? []
  const changedFiles = readChangedFiles(args.changedFilesPath)
  const ranAt = Date.now()

  // 実行前に command 一覧を stderr へ出す。config が想定外の出所から渡された場合でも
  // 「何が実行されようとしたか」を script-stderr.log から監査できるようにする多層防御。
  // matchFiles フィルタ前の全件を列挙するのは「config に何が書かれていたか」の完全な
  // 記録を残すため (skip 判定の結果は script-results.json 側に残る)。
  const announcement = buildCommandAnnouncement(scripts)
  if (announcement) process.stderr.write(announcement + '\n')

  // 並列起動。Promise.all なので全完了まで待つ (1 つだけ失敗しても他の結果は取りたい)。
  const results = await Promise.all(scripts.map(s => runOneScript(s, changedFiles, args.envOverride)))

  const payload: ScriptResultsPayload = { ranAt, results }
  writeFileSync(args.outPath, JSON.stringify(payload, null, 2), 'utf8')

  const hasFailure = results.some(r => r.status === 'failed')
  const failureReport = hasFailure ? buildFailureReport(results) : ''
  return { payload, hasFailure, failureReport }
}

// config に書かれた script の name と command を人間可読な一覧にする。
// 純粋関数として export しているのはテスト容易性のため (spawn を伴わず検証できる)。
export function buildCommandAnnouncement(scripts: ScriptConfig[]): string {
  if (scripts.length === 0) return ''
  const lines = [`[show-me:diff] script gate: ${scripts.length} script(s) configured:`]
  for (const s of scripts) {
    lines.push(`  - ${s.name}: ${s.command}`)
  }
  return lines.join('\n')
}

function readChangedFiles(path: string): string[] {
  try {
    const raw = readFileSync(path, 'utf8')
    return raw.split('\n').map(s => s.trim()).filter(s => s.length > 0)
  } catch {
    return []
  }
}

async function runOneScript(
  script: ScriptConfig,
  changedFiles: string[],
  envOverride?: NodeJS.ProcessEnv,
): Promise<ScriptResult> {
  // matchFiles に 1 つでも一致するファイルが changedFiles にあれば run、無ければ skipped。
  const matchers = script.matchFiles.map(pattern => picomatch(pattern, { dot: true }))
  const hit = changedFiles.some(file => matchers.some(m => m(file)))
  if (!hit) {
    return {
      name: script.name,
      status: 'skipped',
      durationMs: 0,
      reason: 'no matchFiles hit',
    }
  }

  const timeoutMs = script.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS
  const start = Date.now()

  return await new Promise<ScriptResult>(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let resolved = false

    // detached: true で sh を process group leader にする。`cmd1 && cmd2` やテストランナーの
    // ように孫プロセスを張る script では、sh 単体への kill だと孫が orphan として生き残り、
    // 継承された pipe fd が 'close' の発火を永遠に妨げるため、timeout 時は -pid (process group)
    // へ signal を送って孫ごと kill する。副作用として端末からの SIGINT はこの group に
    // 伝播しなくなるが、script gate の停止手段は timeout 機構に一本化されているため問題ない。
    const child = spawn('sh', ['-c', script.command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: envOverride ?? process.env,
      cwd: process.cwd(),
      detached: true,
    })

    // group 全体への signal 送信。group が既に消えている (ESRCH) 場合は直接 kill に
    // フォールバックし、それも失敗したら握りつぶす (どのみち相手は死んでいる)。
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid == null) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          /* already gone */
        }
      }
    }

    let escalation: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      // sh 自身が SIGTERM を trap して 'exit' すら来ないケースの保険。
      escalation = setTimeout(() => {
        if (!resolved) killGroup('SIGKILL')
      }, 2000)
    }, timeoutMs)

    // C-1 fix: 上限を超えた後も chunk を受け続け、末尾だけ残す (tail を残すのが要件)。
    // 旧実装は上限到達後 return で chunk を捨てており「先頭が残る」状態だった。
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > BUFFER_LIMIT_BYTES) {
        stdout = stdout.slice(-BUFFER_LIMIT_BYTES)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > BUFFER_LIMIT_BYTES) {
        stderr = stderr.slice(-BUFFER_LIMIT_BYTES)
      }
    })

    child.on('error', err => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      resolve({
        name: script.name,
        status: 'failed',
        durationMs: Date.now() - start,
        exitCode: null,
        stdoutTail: tail(stdout),
        stderrTail: `spawn error: ${err.message}\n${tail(stderr)}`,
        reason: 'spawn error',
      })
    })

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      if (escalation) clearTimeout(escalation)
      // timeout した script の group には SIGTERM を無視する孫が残り得る。SIGTERM → 'exit' →
      // ここ、という早い経路では上の +2s SIGKILL タイマーがまだ発火していない (resolve 後の
      // process 終了で消える) ため、resolve 直前に無条件で SIGKILL を送って掃除する (冪等)。
      if (timedOut) killGroup('SIGKILL')
      // 孫プロセスが pipe の write 端を握り続けても、read 端を自プロセス側から閉じれば
      // fd もイベントループへの参照も残らない (正常終了 + background daemon のケースを含む)。
      child.stdout?.destroy()
      child.stderr?.destroy()
      const durationMs = Date.now() - start
      if (timedOut) {
        resolve({
          name: script.name,
          status: 'failed',
          durationMs,
          exitCode: null,
          stdoutTail: tail(stdout),
          stderrTail: tail(stderr),
          reason: 'timeout',
        })
        return
      }
      const passed = code === 0 && signal == null
      resolve({
        name: script.name,
        status: passed ? 'passed' : 'failed',
        durationMs,
        exitCode: code,
        stdoutTail: passed ? undefined : tail(stdout),
        stderrTail: passed ? undefined : tail(stderr),
      })
    }

    // fast path: stdio まで完全に閉じた合図。tail が欠けず取れる。
    child.on('close', (code, signal) => finish(code, signal))
    // 保証経路: 孫が pipe fd を保持していると 'close' は来ないため、'exit' + flush 猶予で
    // 必ず resolve する。このタイマーを unref すると、run-scripts 全体が Promise.all 待ち
    // だけの状態でイベントループが空になり、script-results.json 未書き込みのままプロセスが
    // 正常終了してしまうので unref しない。
    child.on('exit', (code, signal) => {
      // プロセスは既に終了しており timeout 判定の対象が消えたため、ここで timer を止める。
      // finish まで遅らせると、exit 直後〜flush 猶予満了の間に timer が発火して正常終了が
      // timeout (failed) に誤判定され、完了済み script の group に signal まで飛んでしまう。
      // timeout 経路 (SIGTERM → 'exit') では timer は発火済みなので、この clear は no-op。
      clearTimeout(timer)
      setTimeout(() => finish(code, signal), EXIT_FLUSH_GRACE_MS)
    })
  })
}

function tail(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= TAIL_LINES) return text.replace(/\n+$/, '')
  return lines.slice(-TAIL_LINES).join('\n').replace(/\n+$/, '')
}

function buildFailureReport(results: ScriptResult[]): string {
  const lines: string[] = []
  lines.push('[show-me:diff] script gate FAILED:')
  for (const r of results) {
    if (r.status === 'passed') {
      lines.push(`  ✅ ${r.name} (${formatDuration(r.durationMs)})`)
    } else if (r.status === 'skipped') {
      lines.push(`  ⏭ ${r.name} (${r.reason ?? 'skipped'})`)
    } else {
      const exitInfo = r.exitCode != null ? `exit ${r.exitCode}` : (r.reason ?? 'failed')
      lines.push(`  ❌ ${r.name} (${exitInfo}, ${formatDuration(r.durationMs)})`)
      if (r.stdoutTail) {
        lines.push(`    --- stdout (tail) ---`)
        for (const l of r.stdoutTail.split('\n')) lines.push(`    ${l}`)
      }
      if (r.stderrTail) {
        lines.push(`    --- stderr (tail) ---`)
        for (const l of r.stderrTail.split('\n')) lines.push(`    ${l}`)
      }
    }
  }
  lines.push('')
  lines.push('show-me:diff was not opened. Fix the failing script(s) and re-stage.')
  return lines.join('\n')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// run-scripts subcommand エントリ。CLI dispatcher から呼ばれる。
export async function runScriptsCommand(): Promise<number> {
  const { parseArgs } = await import('node:util')
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      config: { type: 'string' },
      'changed-files': { type: 'string' },
      out: { type: 'string' },
    },
    strict: false,
  })
  const configPath = (values.config as string | undefined) ?? null
  const changedFilesPath = values['changed-files'] as string | undefined
  const outPath = values.out as string | undefined
  if (!changedFilesPath || !outPath) {
    process.stderr.write('run-scripts requires --changed-files <path> --out <path>\n')
    return 2
  }
  try {
    const { hasFailure, failureReport } = await runScripts({ configPath, changedFilesPath, outPath })
    if (hasFailure) {
      process.stderr.write(failureReport + '\n')
      return 1
    }
    return 0
  } catch (e) {
    process.stderr.write(`[show-me:diff] run-scripts crashed: ${(e as Error).message}\n`)
    return 2
  }
}
