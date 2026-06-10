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
