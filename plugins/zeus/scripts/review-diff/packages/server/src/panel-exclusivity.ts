// validatePanelExclusivity: 同一の変更行 (deletion/addition) が複数 group の panel に
// claim されていないかを検証する。
//
// 背景:
//   「Submit → linear-stack で group ごと 1 commit ずつ作る」モデルでは、
//   同一の変更行を 2 group が touch していると extract-group-patch の生成と git apply --cached が
//   破綻する。不変な context 行 (= changedLines に含まれない行) は複数 group で重複して表示するのは
//   OK だが、変更行は必ず 1 group の所有でなければならない。
//
// アルゴリズム:
//   1. changes から (file, side) → Set<number> の changedLineMap を 1 回構築
//   2. ownerMap: Map<string (file|side), Map<number (line), {groupId, title, panelId}>>
//   3. 各 group の各 panel の各 range の各 line について:
//      - changedLineMap に含まれない line はスキップ (不変行は重複 OK)
//      - ownerMap に既に owner があり groupId が異なるなら conflict 追加
//      - 同一 group 内の重複は no-conflict
//      - 無ければ owner として記録
//   4. 全 conflict を集めて返す (early-exit せず AI 修正用に情報量最大化)

import type { Panel } from '@zeus/review-diff-shared'
import type { FileChange } from './diff-parser'

export type ExclusivityConflict = {
  file: string
  side: 'asIs' | 'toBe'
  line: number
  groupIdA: string
  groupTitleA: string
  panelIdA: string
  groupIdB: string
  groupTitleB: string
  panelIdB: string
}

export type ExclusivityReport = {
  ok: boolean
  conflicts: ExclusivityConflict[]
}

type GroupInput = {
  groupId: string
  title: string
  panels: Panel[]
}

type Owner = {
  groupId: string
  title: string
  panelId: string
}

export function validatePanelExclusivity(params: {
  changes: FileChange[]
  groups: GroupInput[]
}): ExclusivityReport {
  const { changes, groups } = params

  // canonical path 解決: asIs 側は oldPath (rename)、toBe 側は newPath (= path) に正規化する。
  // panel が rename を oldPath/newPath どちらの表記で書いても同一 (file, side) キーに収斂させる
  // ことで、表記ゆれ越しの重複 claim (g0 が old.ts L5 / g1 が new.ts L5) を確実に conflict 検出する。
  // owner を panel 宣言値のまま別キーに分けると、この重複が素通りして extract-group-patch が
  // 同一 deletion を二重抽出 → 2 commit 目の git apply が失敗する。
  //
  // 2 パス構築の理由: 1 つの diff に「old → new の rename」と「old の新規再作成」が同居した場合、
  // alias (old→new) が再作成側の identity (old→old) を潰すと再作成ファイルへの claim が
  // 誤正規化されるため、identity を必ず優先する。
  const canonAsIs = new Map<string, string>()
  const canonToBe = new Map<string, string>()
  for (const c of changes) {
    const asIsFile = c.oldPath ?? c.path
    canonAsIs.set(asIsFile, asIsFile)
    canonToBe.set(c.path, c.path)
  }
  for (const c of changes) {
    if (c.oldPath && c.oldPath !== c.path) {
      if (!canonAsIs.has(c.path)) canonAsIs.set(c.path, c.oldPath)
      if (!canonToBe.has(c.oldPath)) canonToBe.set(c.oldPath, c.path)
    }
  }
  const canonical = { asIs: canonAsIs, toBe: canonToBe }

  // changedLineMap: (canonical file, side) → Set<line>
  const changedLineMap = new Map<string, Set<number>>()
  for (const c of changes) {
    const asIsFile = c.oldPath ?? c.path
    if (c.asIsChangedLines.size > 0) {
      changedLineMap.set(key(asIsFile, 'asIs'), c.asIsChangedLines)
    }
    if (c.toBeChangedLines.size > 0) {
      changedLineMap.set(key(c.path, 'toBe'), c.toBeChangedLines)
    }
  }

  // ownerMap: (canonical file, side) → (line → Owner)
  // 2 段構成にしているのは「(file, side) ごとに小さい Map に分割すれば
  // 大規模 diff でも line 単位の lookup が O(1) で済む」のと、ownerMap 全体走査が不要なため。
  const ownerMap = new Map<string, Map<number, Owner>>()
  const conflicts: ExclusivityConflict[] = []

  for (const g of groups) {
    for (const p of g.panels) {
      checkSide(p, 'asIs', g, ownerMap, changedLineMap, canonical, conflicts)
      checkSide(p, 'toBe', g, ownerMap, changedLineMap, canonical, conflicts)
    }
  }

  return { ok: conflicts.length === 0, conflicts }
}

function checkSide(
  panel: Panel,
  side: 'asIs' | 'toBe',
  group: GroupInput,
  ownerMap: Map<string, Map<number, Owner>>,
  changedLineMap: Map<string, Set<number>>,
  canonical: { asIs: Map<string, string>; toBe: Map<string, string> },
  conflicts: ExclusivityConflict[],
): void {
  const ps = side === 'asIs' ? panel.asIs : panel.toBe
  if (!ps) return
  // panel 宣言値を canonical path に解決してから owner 照合する (conflict.file も canonical 値で報告)。
  // diff に存在しないファイルへの言及は解決できず宣言値のまま → changedLines 不在で early return。
  const file = canonical[side].get(ps.file) ?? ps.file
  const k = key(file, side)
  const changedLines = changedLineMap.get(k)
  if (!changedLines || changedLines.size === 0) return

  let owners = ownerMap.get(k)
  if (!owners) {
    owners = new Map<number, Owner>()
    ownerMap.set(k, owners)
  }

  for (const r of ps.ranges) {
    for (let line = r.start; line <= r.end; line++) {
      if (!changedLines.has(line)) continue
      const prev = owners.get(line)
      if (prev) {
        // 同一 group 内の panel 重複は許容 (commit 単位で問題ないため)。
        if (prev.groupId === group.groupId) continue
        conflicts.push({
          file,
          side,
          line,
          groupIdA: prev.groupId,
          groupTitleA: prev.title,
          panelIdA: prev.panelId,
          groupIdB: group.groupId,
          groupTitleB: group.title,
          panelIdB: panel.panelId,
        })
      } else {
        owners.set(line, { groupId: group.groupId, title: group.title, panelId: panel.panelId })
      }
    }
  }
}

function key(file: string, side: 'asIs' | 'toBe'): string {
  return `${file}\x1f${side}`
}

export function formatExclusivityConflicts(report: ExclusivityReport): string {
  if (report.conflicts.length === 0) return ''
  const out: string[] = []
  out.push(
    'Panel exclusivity validation failed. The same changed line is claimed by multiple groups:',
  )
  for (const c of report.conflicts) {
    out.push(`  ${c.file} [${c.side}] line ${c.line}:`)
    out.push(`    group ${c.groupIdA} "${c.groupTitleA}" panel ${c.panelIdA}`)
    out.push(`    group ${c.groupIdB} "${c.groupTitleB}" panel ${c.panelIdB}`)
  }
  out.push('')
  out.push(
    'Fix: assign each changed line to exactly one group in summary.json. ' +
      '不変な context 行は複数 group で重複 OK ですが、変更行 (deletion/addition) は 1 group の panel だけが claim してください。',
  )
  return out.join('\n')
}

