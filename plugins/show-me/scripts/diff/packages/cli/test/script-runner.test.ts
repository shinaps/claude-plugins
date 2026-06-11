// script-runner の characterization test。
//
// contract (外部観測可能な振る舞い):
//   - buildCommandAnnouncement は config に書かれた全 script の name と command を列挙する
//     (matchFiles フィルタ前の全件 = 監査ログとしての完全な記録)
//   - runScripts は matchFiles ヒットの script だけ sh -c 実行し、passed / failed / skipped /
//     timeout を script-results.json (outPath) に集計する
//   - 実行前に command 一覧が stderr へ書かれる (実行の事後フォレンジック用)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { ScriptConfig } from '@zeus/review-diff-shared'
import { buildCommandAnnouncement, runScripts } from '../src/script-runner.js'

describe('buildCommandAnnouncement', () => {
  test('空配列なら空文字を返す', () => {
    expect(buildCommandAnnouncement([])).toBe('')
  })

  test('全 script の name と command を列挙する (matchFiles に依存しない)', () => {
    const scripts: ScriptConfig[] = [
      { name: 'typecheck', command: 'pnpm typecheck', matchFiles: ['**/*.ts'] },
      { name: 'test', command: 'pnpm test', matchFiles: ['never-match-anything'] },
    ]
    const out = buildCommandAnnouncement(scripts)
    expect(out).toContain('2 script(s) configured')
    expect(out).toContain('typecheck: pnpm typecheck')
    expect(out).toContain('test: pnpm test')
  })
})

describe('runScripts', () => {
  let dir: string
  let stderrSpy: MockInstance<typeof process.stderr.write>

  function writeConfig(scripts: ScriptConfig[]): string {
    const p = join(dir, 'config.json')
    writeFileSync(p, JSON.stringify({ scripts }), 'utf8')
    return p
  }

  function writeChangedFiles(files: string[]): string {
    const p = join(dir, 'changed-files.txt')
    writeFileSync(p, files.join('\n'), 'utf8')
    return p
  }

  function run(scripts: ScriptConfig[], changedFiles: string[]) {
    return runScripts({
      configPath: writeConfig(scripts),
      changedFilesPath: writeChangedFiles(changedFiles),
      outPath: join(dir, 'out.json'),
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'script-runner-test-'))
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  test('matchFiles ヒットで command が実行され passed になる', async () => {
    const { hasFailure, payload } = await run(
      [{ name: 'ok', command: 'true', matchFiles: ['**'] }],
      ['src/foo.ts'],
    )
    expect(hasFailure).toBe(false)
    expect(payload.results).toEqual([
      expect.objectContaining({ name: 'ok', status: 'passed', exitCode: 0 }),
    ])
    const onDisk = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'))
    expect(onDisk.results[0].status).toBe('passed')
  })

  test('非 0 exit は failed になり failureReport に名前と exit code が載る', async () => {
    const { hasFailure, failureReport } = await run(
      [{ name: 'broken', command: 'exit 3', matchFiles: ['**'] }],
      ['src/foo.ts'],
    )
    expect(hasFailure).toBe(true)
    expect(failureReport).toContain('broken')
    expect(failureReport).toContain('exit 3')
  })

  test('matchFiles 不一致は skipped になり command は実行されない', async () => {
    const marker = join(dir, 'should-not-exist')
    const { hasFailure, payload } = await run(
      [{ name: 'skip-me', command: `touch ${marker}`, matchFiles: ['docs/**'] }],
      ['src/foo.ts'],
    )
    expect(hasFailure).toBe(false)
    expect(payload.results[0]).toMatchObject({ name: 'skip-me', status: 'skipped' })
    expect(() => readFileSync(marker)).toThrow()
  })

  test('timeoutMs 超過は failed (reason: timeout) になる', async () => {
    const { hasFailure, payload } = await run(
      [{ name: 'slow', command: 'sleep 5', matchFiles: ['**'], timeoutMs: 50 }],
      ['src/foo.ts'],
    )
    expect(hasFailure).toBe(true)
    expect(payload.results[0]).toMatchObject({ name: 'slow', status: 'failed', reason: 'timeout' })
  })

  test('孫プロセスを張る script の timeout でもハングせず resolve する', async () => {
    // sh の子 (sleep) が pipe fd を継承したまま生き残ると 'close' が発火せず、
    // group kill 無しでは runScripts 全体が永久に待ち続ける構造だったことへの回帰テスト。
    const { hasFailure, payload } = await run(
      [{ name: 'orphan', command: 'sleep 30 & wait', matchFiles: ['**'], timeoutMs: 100 }],
      ['src/foo.ts'],
    )
    expect(hasFailure).toBe(true)
    expect(payload.results[0]).toMatchObject({ name: 'orphan', status: 'failed', reason: 'timeout' })
  })

  test('timeoutMs 直前に exit した daemon 持ち script は timeout に誤判定されず passed になる', async () => {
    // 'exit' から finish までの flush 猶予中に timeout timer が発火すると、exit 0 で完了済みの
    // script が timedOut=true 側の判定に入って failed/timeout と報告される競合への回帰テスト。
    // exit (~50ms) < timeoutMs (200ms) < exit + 猶予 (~250ms) になるよう値を選んでいる。
    const { hasFailure, payload } = await run(
      [{ name: 'near-timeout', command: '(sleep 30 &); sleep 0.05', matchFiles: ['**'], timeoutMs: 200 }],
      ['src/foo.ts'],
    )
    expect(hasFailure).toBe(false)
    expect(payload.results[0]).toMatchObject({ name: 'near-timeout', status: 'passed', exitCode: 0 })
  })

  test('background daemon が pipe を握ったまま正常終了する script は passed で即 resolve する', async () => {
    // daemon (sleep) が pipe の write 端を保持し続けても、'exit' + flush 猶予の保証経路で
    // resolve できることの回帰テスト ('close' 単独依存だとここでハングする)。
    const { hasFailure, payload } = await run(
      [{ name: 'daemon', command: '(sleep 30 &); echo done', matchFiles: ['**'] }],
      ['src/foo.ts'],
    )
    expect(hasFailure).toBe(false)
    expect(payload.results[0]).toMatchObject({ name: 'daemon', status: 'passed', exitCode: 0 })
  })

  test('実行前に command 一覧が stderr へ書かれる (skip 対象も含む全件)', async () => {
    await run(
      [
        { name: 'a', command: 'true', matchFiles: ['**'] },
        { name: 'b', command: 'false', matchFiles: ['never-match'] },
      ],
      ['src/foo.ts'],
    )
    const written = stderrSpy.mock.calls.map(c => String(c[0])).join('')
    expect(written).toContain('a: true')
    expect(written).toContain('b: false')
  })
})
