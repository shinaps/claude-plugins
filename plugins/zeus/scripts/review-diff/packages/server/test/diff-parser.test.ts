import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseDiff } from '@zeus/review-diff-server'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = (name: string) => resolve(__dirname, 'fixtures', name)

test('simple modified file', () => {
  const diff = readFileSync(fixturePath('simple.diff'), 'utf8')
  const files = parseDiff(diff)
  expect(files.length).toBe(1)
  expect(files[0].status).toBe('modified')
  expect(files[0].additions > 0).toBe(true)
  expect(files[0].deletions > 0).toBe(true)
  expect(files[0].hunks.length > 0).toBe(true)
  expect(files[0].hunks[0].rows.length > 0).toBe(true)
  // hunks の oldStart/newStart が parse-git-diff から正しく取れているか
  expect(files[0].hunks[0].oldStart >= 1).toBe(true)
  expect(files[0].hunks[0].newStart >= 1).toBe(true)
})

test('renamed file', () => {
  const files = parseDiff(readFileSync(fixturePath('rename.diff'), 'utf8'))
  expect(files.length).toBe(1)
  expect(files[0].status).toBe('renamed')
  expect(files[0].path).toBe('src/new-name.ts')
  expect(files[0].oldPath).toBe('src/old-name.ts')
})

test('binary file', () => {
  const files = parseDiff(readFileSync(fixturePath('binary.diff'), 'utf8'))
  expect(files.length).toBe(1)
  expect(files[0].status).toBe('binary')
  // バイナリは hunks 無しで status だけ立てる仕様
  expect(files[0].hunks.length).toBe(0)
})

test('new file', () => {
  const files = parseDiff(readFileSync(fixturePath('new-file.diff'), 'utf8'))
  expect(files.length).toBe(1)
  expect(files[0].status).toBe('added')
  expect(files[0].additions > 0).toBe(true)
})

test('deleted file', () => {
  const files = parseDiff(readFileSync(fixturePath('deleted.diff'), 'utf8'))
  expect(files.length).toBe(1)
  expect(files[0].status).toBe('deleted')
  expect(files[0].deletions > 0).toBe(true)
})
