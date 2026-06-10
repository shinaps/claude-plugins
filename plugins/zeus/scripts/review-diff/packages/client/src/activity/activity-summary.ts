// Activity タブの「全体規模」「言語/レイヤ別内訳」「group ごとの file 一覧」を計算する純関数群。
// React component から切り離して TS only にすることで、テスト容易性 + 再計算が
// useMemo で済む形に。computeDiffStats / groupFiles はどちらも O(panels × rows) で線形。
//
// 設計判断:
//   - rawPanels (= 1 file = 1 panel) を入力にし、file 単位の集計を二重カウントしない
//     (同じ file が複数 panel に出るケースは現状無いが defensive に dedupe する)
//   - file change kind は (asIs/toBe の有無 + 同名/別名) の 4 値で discriminated union 的に分類
//   - 言語/レイヤ別 bucket は「上位 N-1 + その他」に正規化し、bar の segment 数を爆発させない

import type { RenderedPanel } from '@zeus/review-diff-shared'
import { basename } from '../lib/path'

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed'

export type GroupFileInfo = {
  // 表示用: basename。rename は "oldBase → newBase"。
  display: string
  // tooltip 用 full path。rename は "oldPath → newPath"。
  fullPath: string
  kind: FileChangeKind
}

export type Bucket = {
  label: string
  count: number
  // 0..1。bar segment の flex-basis に直接渡せる。
  percent: number
}

export type DiffStats = {
  filesTotal: number
  filesAdded: number
  filesModified: number
  filesDeleted: number
  filesRenamed: number
  linesAdded: number
  linesDeleted: number
  // 拡張子別 (ts / tsx / css / json …)。count 降順。長すぎる場合は「その他」に圧縮。
  byLanguage: Bucket[]
  // パスの「意味のあるレイヤ」別 (client / server / cli …)。同様。
  byLayer: Bucket[]
}

// バー segment 数の上限。これを超える bucket は末尾を「その他」にまとめる。
// 6 = SEGMENT_COLORS の長さと一致 (色サイクルが破綻しない最大値)。
const MAX_BUCKETS = 6

function extOf(path: string): string {
  const base = basename(path)
  const dotIdx = base.lastIndexOf('.')
  // dotfile (".gitignore" など) や拡張子なし (Dockerfile / Makefile) はそのままラベル化。
  // 「dotIdx <= 0」で先頭ドット (= dotfile) と未発見 (-1) を両方カバー。
  if (dotIdx <= 0) return base.toLowerCase()
  return base.slice(dotIdx + 1).toLowerCase()
}

// monorepo の入れ子 wrapper を 1 段だけ剥がして「実質のレイヤ名」を取り出す。
// 例 `plugins/zeus/scripts/review-diff/packages/client/src/App.tsx` では `src` の親 `client` を返す。
// `src` が見つからなければ shallow wrapper (plugins/packages/apps...) を 1 段スキップして最初の意味語を取る。
const SHALLOW_LAYER_WRAPPERS = new Set([
  'plugins', 'packages', 'apps', 'modules', 'workspace', 'crates', 'cmd', 'src', 'lib',
])
function inferLayer(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return '(root)'
  // root 直下の file (e.g. package.json) は「(root)」とまとめる。
  if (parts.length === 1) return '(root)'
  // src の親が package / レイヤ名であることが多い (monorepo の packages/X/src 構造、src/ 直下構造の両方をカバー)。
  const srcIdx = parts.indexOf('src')
  if (srcIdx > 0) return parts[srcIdx - 1]
  let i = 0
  while (i < parts.length - 1 && SHALLOW_LAYER_WRAPPERS.has(parts[i])) i++
  return parts[i]
}

function inferKind(panel: RenderedPanel): FileChangeKind {
  const a = panel.asIs?.file
  const b = panel.toBe?.file
  if (!a && b) return 'added'
  if (a && !b) return 'deleted'
  if (a && b && a !== b) return 'renamed'
  return 'modified'
}

function toBuckets(counts: Map<string, number>): Bucket[] {
  let total = 0
  for (const v of counts.values()) total += v
  if (total === 0) return []
  const all: Bucket[] = []
  for (const [label, count] of counts.entries()) {
    all.push({ label, count, percent: count / total })
  }
  all.sort((a, b) => b.count - a.count)
  if (all.length <= MAX_BUCKETS) return all
  // 上位 (MAX_BUCKETS - 1) 件 + 残りを「その他」1 件に圧縮。
  const head = all.slice(0, MAX_BUCKETS - 1)
  const tail = all.slice(MAX_BUCKETS - 1)
  const tailCount = tail.reduce((s, b) => s + b.count, 0)
  const tailPercent = tail.reduce((s, b) => s + b.percent, 0)
  head.push({ label: 'other', count: tailCount, percent: tailPercent })
  return head
}

export function computeDiffStats(rawPanels: ReadonlyArray<RenderedPanel>): DiffStats {
  let filesAdded = 0
  let filesModified = 0
  let filesDeleted = 0
  let filesRenamed = 0
  let linesAdded = 0
  let linesDeleted = 0
  const langCounts = new Map<string, number>()
  const layerCounts = new Map<string, number>()
  const seenFiles = new Set<string>()

  for (const p of rawPanels) {
    const a = p.asIs?.file
    const b = p.toBe?.file
    const key = b ?? a ?? ''
    if (!key) continue
    if (seenFiles.has(key)) continue
    seenFiles.add(key)

    const kind = inferKind(p)
    if (kind === 'added') filesAdded++
    else if (kind === 'deleted') filesDeleted++
    else if (kind === 'renamed') filesRenamed++
    else filesModified++

    for (const seg of p.segments) {
      for (const row of seg.rows) {
        if (row.toBe.type === 'addition') linesAdded++
        if (row.asIs.type === 'deletion') linesDeleted++
      }
    }

    const ext = extOf(key)
    langCounts.set(ext, (langCounts.get(ext) ?? 0) + 1)
    const layer = inferLayer(key)
    layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1)
  }

  const filesTotal = filesAdded + filesModified + filesDeleted + filesRenamed
  return {
    filesTotal,
    filesAdded,
    filesModified,
    filesDeleted,
    filesRenamed,
    linesAdded,
    linesDeleted,
    byLanguage: toBuckets(langCounts),
    byLayer: toBuckets(layerCounts),
  }
}

// group の panels から「ユニークな file 集合」を kind 付きで取り出す。
// 表示順は panel の出現順 (= AI が決めた読み順)。
export function groupFiles(panels: ReadonlyArray<RenderedPanel>): GroupFileInfo[] {
  const seen = new Map<string, GroupFileInfo>()
  for (const p of panels) {
    const a = p.asIs?.file
    const b = p.toBe?.file
    const key = b ?? a ?? ''
    if (!key || seen.has(key)) continue
    const kind = inferKind(p)
    let display: string
    let fullPath: string
    if (kind === 'renamed' && a && b) {
      display = `${basename(a)} → ${basename(b)}`
      fullPath = `${a} → ${b}`
    } else if (b) {
      display = basename(b)
      fullPath = b
    } else if (a) {
      display = basename(a)
      fullPath = a
    } else {
      continue
    }
    seen.set(key, { display, fullPath, kind })
  }
  return Array.from(seen.values())
}
