import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseDiff } from '../src/server-side/diff-parser.js'
import { createShiki } from '../src/server-side/shiki-bundle.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = (name: string) => resolve(__dirname, 'fixtures', name)
const shiki = createShiki()

test('simple modified file', () => {
  const diff = readFileSync(fixturePath('simple.diff'), 'utf8')
  const files = parseDiff(diff, shiki)
  assert.equal(files.length, 1)
  assert.equal(files[0].status, 'modified')
  assert.ok(files[0].additions > 0)
  assert.ok(files[0].deletions > 0)
  assert.ok(files[0].hunks.length > 0)
  assert.ok(files[0].hunks[0].rows.length > 0)
  // hunks の oldStart/newStart が parse-git-diff から正しく取れているか
  assert.ok(files[0].hunks[0].oldStart >= 1)
  assert.ok(files[0].hunks[0].newStart >= 1)
})

test('renamed file', () => {
  const files = parseDiff(readFileSync(fixturePath('rename.diff'), 'utf8'), shiki)
  assert.equal(files.length, 1)
  assert.equal(files[0].status, 'renamed')
  assert.equal(files[0].path, 'src/new-name.ts')
  assert.equal(files[0].oldPath, 'src/old-name.ts')
})

test('binary file', () => {
  const files = parseDiff(readFileSync(fixturePath('binary.diff'), 'utf8'), shiki)
  assert.equal(files.length, 1)
  assert.equal(files[0].status, 'binary')
  // バイナリは hunks 無しで status だけ立てる仕様
  assert.equal(files[0].hunks.length, 0)
})

test('new file', () => {
  const files = parseDiff(readFileSync(fixturePath('new-file.diff'), 'utf8'), shiki)
  assert.equal(files.length, 1)
  assert.equal(files[0].status, 'added')
  assert.ok(files[0].additions > 0)
})

test('deleted file', () => {
  const files = parseDiff(readFileSync(fixturePath('deleted.diff'), 'utf8'), shiki)
  assert.equal(files.length, 1)
  assert.equal(files[0].status, 'deleted')
  assert.ok(files[0].deletions > 0)
})
