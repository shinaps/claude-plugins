import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import picomatch from 'picomatch'
import type { ScriptConfig, ScriptResult, ScriptResultsPayload } from '@zeus/review-diff-shared'
import { loadReviewDiffConfig } from './config.js'

// Phase 4.5 (script gate) を実行するための CLI 内部ロジック。
//   - config.scripts[] を picomatch でフィルタ
//   - 並列起動 (Promise.all)、各 script の stdout/stderr を per-script buffer に貯める (混線回避)
//   - timeout / spawn error / exit code を集計
//   - 1 つでも failed があれば stderr にレポートを書き出して exit 1 を呼び側で立てる
//   - 全 pass (skipped 含む) なら script-results.json を書いて exit 0
//
// run-scripts subcommand は CLI dispatcher 経由で起動される (cli.ts dispatcher 参照)。

export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000
// 1 script 当たりの stdout/stderr 上限。超過分は捨てて tail だけ残す (= 起動からの先頭ではなく
// 末尾を残して fail 解析の手がかりを優先)。
const BUFFER_LIMIT_BYTES = 5 * 1024 * 1024
const TAIL_LINES = 50

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

  // 並列起動。Promise.all なので全完了まで待つ (1 つだけ失敗しても他の結果は取りたい)。
  const results = await Promise.all(scripts.map(s => runOneScript(s, changedFiles, args.envOverride)))

  const payload: ScriptResultsPayload = { ranAt, results }
  writeFileSync(args.outPath, JSON.stringify(payload, null, 2), 'utf8')

  const hasFailure = results.some(r => r.status === 'failed')
  const failureReport = hasFailure ? buildFailureReport(results) : ''
  return { payload, hasFailure, failureReport }
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

    const child = spawn('sh', ['-c', script.command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: envOverride ?? process.env,
      cwd: process.cwd(),
    })

    const timer = setTimeout(() => {
      timedOut = true
      // SIGTERM → 数秒後に SIGKILL fallback (子プロセスが trap している場合の保険)。
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!resolved) child.kill('SIGKILL')
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

    child.on('close', (code, signal) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
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
  lines.push('[review-diff] script gate FAILED:')
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
  lines.push('review-diff was not opened. Fix the failing script(s) and re-stage.')
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
    process.stderr.write(`[review-diff] run-scripts crashed: ${(e as Error).message}\n`)
    return 2
  }
}
