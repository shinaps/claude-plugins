// extractGroupPatch の統合テスト: 実 git repo で SKILL.md の linear-stack commit ループを模倣する。
//
// ユニットテスト (extract-group-patch.test.ts) はヘッダ値を固定するが、期待値の手計算ミスには
// 弱い。ここでは「全 group コミット後に working tree と HEAD の差分が空 + 最終内容が final と
// 一致」という、座標がどうずれても必ず破れる不変条件で独立に検証する (二重化)。
//
// git apply は SKILL.md の linear-stack ループと完全に同じ
// `git apply --cached --unidiff-zero --recount` で実行する (本番経路の検証のため)。

import { test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractGroupPatch } from '@show-me/diff-server'
import type { SummaryJson } from '@show-me/diff-shared'

function makeSummary(groups: SummaryJson['groups']): SummaryJson {
  return { schemaVersion: 1, mode: 'staged', pr: null, overallSummary: '', groups }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// SKILL.md の linear-stack ループを模倣:
//   base commit → final を stage → full diff 取得 → un-stage →
//   group 順に (extractGroupPatch → git apply --cached --unidiff-zero --recount → commit)
// 戻り値: 全 group commit 後の status (porcelain) と各ファイルの HEAD 内容。
function runLinearStack(opts: {
  files: Record<string, { base: string; final: string }>
  summary: SummaryJson
}): { status: string; headContents: Record<string, string>; commits: number } {
  const dir = mkdtempSync(join(tmpdir(), 'egp-apply-'))
  try {
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.name', 'test')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'commit.gpgsign', 'false')

    for (const [path, { base }] of Object.entries(opts.files)) {
      writeFileSync(join(dir, path), base)
    }
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')

    for (const [path, { final }] of Object.entries(opts.files)) {
      writeFileSync(join(dir, path), final)
    }
    git(dir, 'add', '-A')
    const diffText = git(dir, 'diff', '--cached', '--no-color')
    git(dir, 'restore', '--staged', '.')

    let commits = 0
    for (let i = 0; i < opts.summary.groups.length; i++) {
      const r = extractGroupPatch({ summary: opts.summary, diffText, groupId: `g${i}` })
      expect(r.ok).toBe(true)
      if (r.patch === '') continue // context-only group は commit skip (SKILL.md と同じ)
      const patchPath = join(dir, `.patch-g${i}.diff`)
      writeFileSync(patchPath, r.patch)
      git(dir, 'apply', '--cached', '--unidiff-zero', '--recount', patchPath)
      rmSync(patchPath)
      git(dir, 'commit', '-q', '-m', `g${i}`)
      commits++
    }

    const status = git(dir, 'status', '--porcelain')
    const headContents: Record<string, string> = {}
    for (const path of Object.keys(opts.files)) {
      // working tree ではなく HEAD を読む: working tree は冒頭で final を直接書いた内容の
      // ままなので、commit 結果と無関係に常に final と一致してしまい検証にならない。
      headContents[path] = git(dir, 'show', `HEAD:${path}`)
    }
    return { status, headContents, commits }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// rename / chmod / 新規ファイル追加など、runLinearStack の base→final モデルで表現できない
// シナリオ用。setupBase が base commit の内容、applyFinal が staged にしたい最終状態を
// 呼び出し側で直接構築する (rename は旧ファイル削除 + 新ファイル書き込み + add -A で再現)。
// diff コマンドは SKILL.md の本番経路と同一 (`git diff --cached --no-color`、-M なし) とし、
// rename 検出はテスト環境のグローバル設定に依存しないよう repo config で固定する。
// inspect は cleanup 前に repo を覗くためのフック (HEAD 内容や ls-tree の検証用)。
function runLinearStackCustom<T = undefined>(opts: {
  setupBase: (dir: string) => void
  applyFinal: (dir: string) => void
  summary: SummaryJson
  inspect?: (dir: string) => T
}): { status: string; commits: number; patches: string[]; inspected: T } {
  const dir = mkdtempSync(join(tmpdir(), 'egp-apply-'))
  try {
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.name', 'test')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'commit.gpgsign', 'false')
    git(dir, 'config', 'diff.renames', 'true')

    opts.setupBase(dir)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')

    opts.applyFinal(dir)
    git(dir, 'add', '-A')
    const diffText = git(dir, 'diff', '--cached', '--no-color')
    git(dir, 'restore', '--staged', '.')

    let commits = 0
    const patches: string[] = []
    for (let i = 0; i < opts.summary.groups.length; i++) {
      const r = extractGroupPatch({ summary: opts.summary, diffText, groupId: `g${i}` })
      expect(r.ok).toBe(true)
      patches.push(r.patch)
      if (r.patch === '') continue
      const patchPath = join(dir, `.patch-g${i}.diff`)
      writeFileSync(patchPath, r.patch)
      git(dir, 'apply', '--cached', '--unidiff-zero', '--recount', patchPath)
      rmSync(patchPath)
      git(dir, 'commit', '-q', '-m', `g${i}`)
      commits++
    }

    const status = git(dir, 'status', '--porcelain')
    const inspected = (opts.inspect ? opts.inspect(dir) : undefined) as T
    return { status, commits, patches, inspected }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function lines(...ls: string[]): string {
  return ls.join('\n') + '\n'
}

const L = (n: number) => `L${n}`
const seq = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => L(from + i))

test('(a) incident 再現: 下方純追加 (g0) + 上方に後続 group の追加 (g1)', () => {
  const base = lines(...seq(1, 30))
  const final = lines(...seq(1, 10), 'A1', 'A2', 'A3', 'A4', 'A5', ...seq(11, 20), 'B1', 'B2', 'B3', ...seq(21, 30))
  const summary = makeSummary([
    { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'B', toBe: { file: 'f.txt', ranges: [{ start: 26, end: 28 }] } }] },
    { title: 'g1', description: '', panels: [{ panelId: 'p2', intent: 'A', toBe: { file: 'f.txt', ranges: [{ start: 11, end: 15 }] } }] },
  ])
  const r = runLinearStack({ files: { 'f.txt': { base, final } }, summary })
  expect(r.status).toBe('')
  expect(r.headContents['f.txt']).toBe(final)
  expect(r.commits).toBe(2)
})

test('(b) 負デルタ: 後続 group が上方の削除を持つ', () => {
  const base = lines(...seq(1, 30))
  // g1 (後続) が L10 を削除、g0 (先頭) が L20 後に B1 を追加
  const final = lines(...seq(1, 9), ...seq(11, 20), 'B1', ...seq(21, 30))
  const summary = makeSummary([
    { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'B', toBe: { file: 'f.txt', ranges: [{ start: 20, end: 20 }] } }] },
    { title: 'g1', description: '', panels: [{ panelId: 'p2', intent: 'del', asIs: { file: 'f.txt', ranges: [{ start: 10, end: 10 }] } }] },
  ])
  const r = runLinearStack({ files: { 'f.txt': { base, final } }, summary })
  expect(r.status).toBe('')
  expect(r.headContents['f.txt']).toBe(final)
})

test('(c) 3 group + context-only group + 複数ファイル (state のファイル間リーク検証)', () => {
  // f1: g3 (最後) が上方 (toBe 6-7)、g0 が下方 (toBe 23) → g0 に -2 補正が必要
  const f1base = lines(...seq(1, 30))
  const f1final = lines(...seq(1, 5), 'X1', 'X2', ...seq(6, 20), 'Y1', ...seq(21, 30))
  // f2: g1 のみが変更 (f1 の offset が漏れたらここでずれる)
  const f2base = lines(...seq(1, 10))
  const f2final = lines(...seq(1, 8), 'Z1', ...seq(9, 10))
  const summary = makeSummary([
    { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'Y', toBe: { file: 'f1.txt', ranges: [{ start: 23, end: 23 }] } }] },
    { title: 'g1', description: '', panels: [{ panelId: 'p2', intent: 'Z', toBe: { file: 'f2.txt', ranges: [{ start: 9, end: 9 }] } }] },
    // context-only group (変更行を claim しない → 空 patch で commit skip)
    { title: 'g2-ctx', description: '', panels: [{ panelId: 'p3', intent: 'ctx', toBe: { file: 'f1.txt', ranges: [{ start: 1, end: 3 }] } }] },
    { title: 'g3', description: '', panels: [{ panelId: 'p4', intent: 'X', toBe: { file: 'f1.txt', ranges: [{ start: 6, end: 7 }] } }] },
  ])
  const r = runLinearStack({ files: { 'f1.txt': { base: f1base, final: f1final }, 'f2.txt': { base: f2base, final: f2final } }, summary })
  expect(r.status).toBe('')
  expect(r.headContents['f1.txt']).toBe(f1final)
  expect(r.headContents['f2.txt']).toBe(f2final)
  expect(r.commits).toBe(3) // context-only group は commit されない
})

test('(d) 無音誤削除の防止: 重複内容行 (DUP) 近傍の削除 hunk', () => {
  // DUP が line 10 と 16 にある。g0 = line 10 の DUP を削除、g1 (後続) = 上方に 6 行追加。
  // 補正が無いと g0 の削除が新座標 16 へ向かい、apply 成功のまま「残すべき line 16 の DUP」を
  // 消してしまう (exit code では検出できないため、最終内容の完全一致で判定する)。
  const base = lines(...seq(1, 9), 'DUP', ...seq(11, 15), 'DUP', ...seq(17, 30))
  const final = lines('N1', 'N2', 'N3', 'N4', 'N5', 'N6', ...seq(1, 9), ...seq(11, 15), 'DUP', ...seq(17, 30))
  const summary = makeSummary([
    { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'del dup', asIs: { file: 'f.txt', ranges: [{ start: 10, end: 10 }] } }] },
    { title: 'g1', description: '', panels: [{ panelId: 'p2', intent: 'N', toBe: { file: 'f.txt', ranges: [{ start: 1, end: 6 }] } }] },
  ])
  const r = runLinearStack({ files: { 'f.txt': { base, final } }, summary })
  expect(r.status).toBe('')
  expect(r.headContents['f.txt']).toBe(final)
})

test('(f) 新規ファイル追加を含む group が実 apply で commit できる', () => {
  // runLinearStack は base を必ず書くため、新規ファイルは別経路でセットアップする:
  // base 側に書かず final のみ存在 = AddedFile として diff に乗る。
  const dir = mkdtempSync(join(tmpdir(), 'egp-apply-'))
  try {
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.name', 'test')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(dir, 'existing.txt'), lines(...seq(1, 5)))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')

    const newContent = lines('N1', 'N2', 'N3')
    writeFileSync(join(dir, 'brand-new.txt'), newContent)
    git(dir, 'add', '-A')
    const diffText = git(dir, 'diff', '--cached', '--no-color')
    git(dir, 'restore', '--staged', '.')

    const summary = makeSummary([
      { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'new', toBe: { file: 'brand-new.txt', ranges: [{ start: 1, end: 3 }] } }] },
    ])
    const r = extractGroupPatch({ summary, diffText, groupId: 'g0' })
    expect(r.ok).toBe(true)
    const patchPath = join(dir, '.patch.diff')
    writeFileSync(patchPath, r.patch)
    git(dir, 'apply', '--cached', '--unidiff-zero', '--recount', patchPath)
    rmSync(patchPath)
    git(dir, 'commit', '-q', '-m', 'g0')
    expect(git(dir, 'show', 'HEAD:brand-new.txt')).toBe(newContent)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('(e) 同一 hunk 内で claim 行が交互に並ぶ', () => {
  const base = lines(...seq(1, 5))
  // L1 X1 X2 L2 Y1 L3 Z1 L4 L5 — g0 = Y1 と Z1、g1 = X1 X2
  const final = lines('L1', 'X1', 'X2', 'L2', 'Y1', 'L3', 'Z1', 'L4', 'L5')
  const summary = makeSummary([
    { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'YZ', toBe: { file: 'f.txt', ranges: [{ start: 5, end: 5 }, { start: 7, end: 7 }] } }] },
    { title: 'g1', description: '', panels: [{ panelId: 'p2', intent: 'X', toBe: { file: 'f.txt', ranges: [{ start: 2, end: 3 }] } }] },
  ])
  const r = runLinearStack({ files: { 'f.txt': { base, final } }, summary })
  expect(r.status).toBe('')
  expect(r.headContents['f.txt']).toBe(final)
})

test('(m) 新規ファイルの追加行を 2 group に分割しても apply が壊れない', () => {
  // new file mode ヘッダは「index にファイルを新規作成する」宣言なので、g0 commit 後の
  // index に同名ファイルが存在する状態で g1 が再宣言すると apply が拒否する (C-1 と同型)。
  const r = runLinearStackCustom({
    setupBase: (dir) => writeFileSync(join(dir, 'existing.txt'), lines(...seq(1, 3))),
    applyFinal: (dir) => writeFileSync(join(dir, 'brand-new.txt'), lines('N1', 'N2', 'N3', 'N4', 'N5', 'N6')),
    summary: makeSummary([
      { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'top', toBe: { file: 'brand-new.txt', ranges: [{ start: 1, end: 3 }] } }] },
      { title: 'g1', description: '', panels: [{ panelId: 'p2', intent: 'bottom', toBe: { file: 'brand-new.txt', ranges: [{ start: 4, end: 6 }] } }] },
    ]),
    inspect: (dir) => git(dir, 'show', 'HEAD:brand-new.txt'),
  })
  expect(r.commits).toBe(2)
  expect(r.status).toBe('')
  expect(r.inspected).toBe(lines('N1', 'N2', 'N3', 'N4', 'N5', 'N6'))
  // follower (g1) は new file 宣言を持たない通常 patch
  expect(r.patches[1]).not.toContain('new file mode')
  expect(r.patches[1]).not.toContain('/dev/null')
})

test('(g) rename + 内容変更を 2 group に分割: rename ヘッダは owner のみが carry する', () => {
  const final = lines('L1', 'X2', ...seq(3, 8), 'Y9', 'L10')
  const r = runLinearStackCustom({
    setupBase: (dir) => writeFileSync(join(dir, 'old.txt'), lines(...seq(1, 10))),
    applyFinal: (dir) => {
      rmSync(join(dir, 'old.txt'))
      writeFileSync(join(dir, 'new.txt'), final)
    },
    summary: makeSummary([
      { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'X', asIs: { file: 'old.txt', ranges: [{ start: 2, end: 2 }] }, toBe: { file: 'new.txt', ranges: [{ start: 2, end: 2 }] } }] },
      { title: 'g1', description: '', panels: [{ panelId: 'p2', intent: 'Y', asIs: { file: 'old.txt', ranges: [{ start: 9, end: 9 }] }, toBe: { file: 'new.txt', ranges: [{ start: 9, end: 9 }] } }] },
    ]),
    inspect: (dir) => git(dir, 'show', 'HEAD:new.txt'),
  })
  expect(r.commits).toBe(2)
  expect(r.status).toBe('')
  expect(r.inspected).toBe(final)
  expect(r.patches[0]).toContain('rename from old.txt')
  // follower は rename を再宣言しない (owner commit 後の index に old.txt は存在しないため)
  expect(r.patches[1]).not.toContain('rename from')
  expect(r.patches[1]).toContain('diff --git a/new.txt b/new.txt')
})

test('(h) rename ファイルへの context-only 言及 group が先行しても rename を壊さない', () => {
  const final = lines('L1', 'X2', ...seq(3, 10))
  const r = runLinearStackCustom({
    setupBase: (dir) => writeFileSync(join(dir, 'old.txt'), lines(...seq(1, 10))),
    applyFinal: (dir) => {
      rmSync(join(dir, 'old.txt'))
      writeFileSync(join(dir, 'new.txt'), final)
    },
    summary: makeSummary([
      // g0 は不変行のみ言及 (変更行 claim ゼロ) → patch を一切 emit しないこと
      { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'ctx', toBe: { file: 'new.txt', ranges: [{ start: 5, end: 6 }] } }] },
      { title: 'g1', description: '', panels: [{ panelId: 'p2', intent: 'X', asIs: { file: 'old.txt', ranges: [{ start: 2, end: 2 }] }, toBe: { file: 'new.txt', ranges: [{ start: 2, end: 2 }] } }] },
    ]),
    inspect: (dir) => git(dir, 'show', 'HEAD:new.txt'),
  })
  expect(r.patches[0]).toBe('')
  expect(r.patches[1]).toContain('rename from old.txt')
  expect(r.commits).toBe(1)
  expect(r.status).toBe('')
  expect(r.inspected).toBe(final)
})

test('(i) rename-only (内容変更なし): 最初に言及した group だけが rename を commit する', () => {
  const content = lines(...seq(1, 3))
  const r = runLinearStackCustom({
    setupBase: (dir) => writeFileSync(join(dir, 'old.txt'), content),
    applyFinal: (dir) => {
      rmSync(join(dir, 'old.txt'))
      writeFileSync(join(dir, 'new.txt'), content)
    },
    summary: makeSummary([
      { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'mv', toBe: { file: 'new.txt', ranges: [{ start: 1, end: 1 }] } }] },
      { title: 'g1', description: '', panels: [{ panelId: 'p2', intent: 'dup-mention', toBe: { file: 'new.txt', ranges: [{ start: 2, end: 2 }] } }] },
    ]),
    inspect: (dir) => git(dir, 'show', 'HEAD:new.txt'),
  })
  expect(r.patches[0]).toContain('rename from old.txt')
  expect(r.patches[0]).toContain('rename to new.txt')
  expect(r.patches[1]).toBe('') // 2 番目の言及 group は rename を再 emit しない
  expect(r.commits).toBe(1)
  expect(r.status).toBe('')
  expect(r.inspected).toBe(content)
})

test.skipIf(process.platform === 'win32')('(j) mode-only 変更 (chmod) が commit に乗る', () => {
  // Windows は実行ビットが no-op で staged diff に mode 変更が乗らないため skip
  const r = runLinearStackCustom({
    setupBase: (dir) => writeFileSync(join(dir, 'f.sh'), lines(...seq(1, 3))),
    applyFinal: (dir) => chmodSync(join(dir, 'f.sh'), 0o755),
    summary: makeSummary([
      // SKILL.md の表明どおり mode-only は「ファイル言及」だけで carry される
      { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'chmod', toBe: { file: 'f.sh', ranges: [{ start: 1, end: 1 }] } }] },
    ]),
    inspect: (dir) => git(dir, 'ls-tree', 'HEAD', 'f.sh'),
  })
  expect(r.patches[0]).toContain('old mode 100644')
  expect(r.patches[0]).toContain('new mode 100755')
  expect(r.commits).toBe(1)
  expect(r.status).toBe('')
  expect(r.inspected).toContain('100755')
})

test.skipIf(process.platform === 'win32')('(k) mode + 内容変更を 2 group に分割: mode 行は owner のみ', () => {
  const final = lines('L1', 'X2', ...seq(3, 8), 'Y9', 'L10')
  const r = runLinearStackCustom({
    setupBase: (dir) => writeFileSync(join(dir, 'f.sh'), lines(...seq(1, 10))),
    applyFinal: (dir) => {
      writeFileSync(join(dir, 'f.sh'), final)
      chmodSync(join(dir, 'f.sh'), 0o755)
    },
    summary: makeSummary([
      { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'X', asIs: { file: 'f.sh', ranges: [{ start: 2, end: 2 }] }, toBe: { file: 'f.sh', ranges: [{ start: 2, end: 2 }] } }] },
      { title: 'g1', description: '', panels: [{ panelId: 'p2', intent: 'Y', asIs: { file: 'f.sh', ranges: [{ start: 9, end: 9 }] }, toBe: { file: 'f.sh', ranges: [{ start: 9, end: 9 }] } }] },
    ]),
    inspect: (dir) => ({
      content: git(dir, 'show', 'HEAD:f.sh'),
      tree: git(dir, 'ls-tree', 'HEAD', 'f.sh'),
    }),
  })
  expect(r.patches[0]).toContain('old mode 100644')
  expect(r.patches[1]).not.toContain('old mode')
  expect(r.commits).toBe(2)
  expect(r.status).toBe('')
  expect(r.inspected.content).toBe(final)
  expect(r.inspected.tree).toContain('100755')
})

test('(l-1) EOF 改行を失う変更: マーカーが patch に乗り HEAD がバイト一致する', () => {
  // マーカーが落ちると git apply --recount は黙って改行付きで適用し、
  // HEAD ≠ staged の silent corruption になる (バイト一致で検証する)。
  const base = 'L1\nL2\nL3\n'
  const final = 'L1\nL2\nX3' // 末尾改行なし
  const summary = makeSummary([
    { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'X', asIs: { file: 'f.txt', ranges: [{ start: 3, end: 3 }] }, toBe: { file: 'f.txt', ranges: [{ start: 3, end: 3 }] } }] },
  ])
  const r = runLinearStack({ files: { 'f.txt': { base, final } }, summary })
  expect(r.status).toBe('')
  expect(r.headContents['f.txt']).toBe(final)
})

test('(l-2) EOF 改行を得る変更: 削除側マーカーが patch に乗る', () => {
  const base = 'L1\nL2\nL3' // 末尾改行なし
  const final = 'L1\nL2\nL3\nL4\n'
  const summary = makeSummary([
    { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'add', asIs: { file: 'f.txt', ranges: [{ start: 3, end: 3 }] }, toBe: { file: 'f.txt', ranges: [{ start: 3, end: 4 }] } }] },
  ])
  const r = runLinearStack({ files: { 'f.txt': { base, final } }, summary })
  expect(r.status).toBe('')
  expect(r.headContents['f.txt']).toBe(final)
})

test('(l-3) 2 group 分割: マーカーは EOF 行を claim した group の patch だけに乗る', () => {
  const base = 'L1\nL2\nL3\n'
  const final = 'X1\nL2\nX3' // 末尾改行なし
  const summary = makeSummary([
    { title: 'g0', description: '', panels: [{ panelId: 'p1', intent: 'top', asIs: { file: 'f.txt', ranges: [{ start: 1, end: 1 }] }, toBe: { file: 'f.txt', ranges: [{ start: 1, end: 1 }] } }] },
    { title: 'g1', description: '', panels: [{ panelId: 'p2', intent: 'eof', asIs: { file: 'f.txt', ranges: [{ start: 3, end: 3 }] }, toBe: { file: 'f.txt', ranges: [{ start: 3, end: 3 }] } }] },
  ])
  // マーカー帰属の検証は patch 文字列を直接見る
  const g0 = extractGroupPatch({ summary, diffText: gitDiffOf(base, final), groupId: 'g0' })
  const g1 = extractGroupPatch({ summary, diffText: gitDiffOf(base, final), groupId: 'g1' })
  expect(g0.patch).not.toContain('No newline')
  expect(g1.patch).toContain('\\ No newline at end of file')

  const r = runLinearStack({ files: { 'f.txt': { base, final } }, summary })
  expect(r.status).toBe('')
  expect(r.headContents['f.txt']).toBe(final)
  expect(r.commits).toBe(2)
})

// base→final の staged diff 文字列を実 git で生成する (l-3 のマーカー帰属検証用)
function gitDiffOf(base: string, final: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'egp-diff-'))
  try {
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.name', 'test')
    git(dir, 'config', 'user.email', 'test@example.com')
    git(dir, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(dir, 'f.txt'), base)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')
    writeFileSync(join(dir, 'f.txt'), final)
    git(dir, 'add', '-A')
    return git(dir, 'diff', '--cached', '--no-color')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
