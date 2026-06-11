// lib/path.ts の basename の characterization test。
//
// contract: 「最後の '/' より後ろを返す。'/' が無ければそのまま。末尾 '/' なら空文字」。
// この関数は GroupNav (panel の file 表示)・activity-summary (GroupFileInfo.display / extOf)・
// ActivityView (line anchor) の 3 箇所で共有されているため、表示挙動の回帰を
// このユニットテストで一括して固定する。

import { describe, test, expect } from 'vitest'
import { basename } from '../src/lib/path'

describe('basename', () => {
  test('典型: ネストした path は最後の segment を返す', () => {
    expect(basename('a/b/c.ts')).toBe('c.ts')
    expect(basename('/abs/path/x.tsx')).toBe('x.tsx')
    expect(basename('packages/client/src/App.tsx')).toBe('App.tsx')
  })

  test('典型: separator 無しはそのまま返す', () => {
    expect(basename('file.ts')).toBe('file.ts')
    expect(basename('Dockerfile')).toBe('Dockerfile')
  })

  test('dotfile はそのまま返す (extOf がこの形を前提にする)', () => {
    expect(basename('.gitignore')).toBe('.gitignore')
    expect(basename('config/.env')).toBe('.env')
  })

  test('エッジ: 空文字・単独 separator・末尾 separator は空文字系', () => {
    expect(basename('')).toBe('')
    expect(basename('/')).toBe('')
    expect(basename('a/b/')).toBe('')
  })

  test('エッジ: 連続 separator・空白入り segment', () => {
    expect(basename('a//b')).toBe('b')
    expect(basename('a/b c/d.ts')).toBe('d.ts')
  })

  test('エッジ: rename 矢印表記は分解しない (DiffTab.tsx の basenameFromIntent とは別契約)', () => {
    expect(basename('old.ts → new.ts')).toBe('old.ts → new.ts')
  })
})
