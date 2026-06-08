// parseDiff (FileChange[]) API のテスト。
// 検証軸: asIsChangedLines/toBeChangedLines/additions/deletions/
// hasContentChange/hasStructuralChange/eolOnlyChange/status/path/oldPath/language。

import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseDiff } from '@zeus/review-diff-server'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = (name: string) => resolve(__dirname, 'fixtures', name)

test('parseDiff: simple modified file → FileChange', () => {
  const files = parseDiff(readFileSync(fixturePath('simple.diff'), 'utf8'))
  expect(files.length).toBe(1)
  const f = files[0]
  expect(f.path).toBe('src/foo.ts')
  expect(f.oldPath).toBeUndefined()
  expect(f.status).toBe('modified')
  expect(f.additions).toBeGreaterThan(0)
  expect(f.deletions).toBeGreaterThan(0)
  expect(f.asIsChangedLines.size).toBeGreaterThan(0)
  expect(f.toBeChangedLines.size).toBeGreaterThan(0)
  expect(f.hasContentChange).toBe(true)
  expect(f.hasStructuralChange).toBe(false)
  expect(f.eolOnlyChange).toBe(false)
  expect(f.language).toBe('typescript')
  // v4.12.0: hunks の境界情報も emit する
  expect(f.hunks.length).toBeGreaterThan(0)
  expect(f.hunks[0]).toMatchObject({
    fromStart: expect.any(Number),
    fromLines: expect.any(Number),
    toStart: expect.any(Number),
    toLines: expect.any(Number),
  })
})

test('parseDiff: renamed file with content change exposes oldPath + status=renamed', () => {
  const files = parseDiff(readFileSync(fixturePath('rename.diff'), 'utf8'))
  expect(files.length).toBe(1)
  const f = files[0]
  expect(f.status).toBe('renamed')
  expect(f.path).toBe('src/new-name.ts')
  expect(f.oldPath).toBe('src/old-name.ts')
  // fixture は rename + 内容変更を含むので content + structural の両方が立つ
  expect(f.hasContentChange).toBe(true)
  expect(f.hasStructuralChange).toBe(true)
})

test('parseDiff: binary file → hasStructuralChange=true, hasContentChange=false, empty changed sets', () => {
  const files = parseDiff(readFileSync(fixturePath('binary.diff'), 'utf8'))
  expect(files.length).toBe(1)
  const f = files[0]
  expect(f.status).toBe('binary')
  expect(f.additions).toBe(0)
  expect(f.deletions).toBe(0)
  expect(f.asIsChangedLines.size).toBe(0)
  expect(f.toBeChangedLines.size).toBe(0)
  expect(f.hasContentChange).toBe(false)
  expect(f.hasStructuralChange).toBe(true)
  expect(f.eolOnlyChange).toBe(false)
  // binary は hunks 空配列 (BinaryFilesChunk は fromFileRange/toFileRange を持たない)
  expect(f.hunks).toEqual([])
})

test('parseDiff: new file → status=added, asIsChangedLines empty, toBeChangedLines populated', () => {
  const files = parseDiff(readFileSync(fixturePath('new-file.diff'), 'utf8'))
  expect(files.length).toBe(1)
  const f = files[0]
  expect(f.status).toBe('added')
  expect(f.additions).toBeGreaterThan(0)
  expect(f.asIsChangedLines.size).toBe(0)
  expect(f.toBeChangedLines.size).toBeGreaterThan(0)
})

test('parseDiff: deleted file → status=deleted, toBeChangedLines empty, asIsChangedLines populated', () => {
  const files = parseDiff(readFileSync(fixturePath('deleted.diff'), 'utf8'))
  expect(files.length).toBe(1)
  const f = files[0]
  expect(f.status).toBe('deleted')
  expect(f.deletions).toBeGreaterThan(0)
  expect(f.toBeChangedLines.size).toBe(0)
  expect(f.asIsChangedLines.size).toBeGreaterThan(0)
})

test('parseDiff: language inference (typescript)', () => {
  const files = parseDiff(readFileSync(fixturePath('simple.diff'), 'utf8'))
  expect(files[0].language).toBe('typescript')
})
