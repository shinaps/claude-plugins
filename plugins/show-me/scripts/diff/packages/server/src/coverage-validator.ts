// 網羅性検証: git diff の変更行集合が、全 panel の asIs.ranges / toBe.ranges に
// 完全に包含されていることを確認する。漏れがあれば fail させ、ファイル + 側 + 行範囲を stderr に出す。
//
// 設計判断:
//   - asIs 軸と toBe 軸を別々に検証する。
//     - asIs 軸 (before / oldPath): 削除された行 (deletion) が漏れていないか
//     - toBe 軸 (after / path): 追加された行 (addition) が漏れていないか
//     これは「rename + 内容変更」のケースで asIs.file = oldPath, toBe.file = newPath と
//     書くのが自然な設計に追従するため (FileChange.oldPath が asIs 側 lookup を駆動する)。
//   - 構造のみ変更 (rename だけ / binary / mode change) は「行」ではなく「ファイル言及」を確認する。
//     panel が当該 file (newPath or oldPath) に言及していなければ「構造変更が carry されていない」miss として報告。
//   - EOL-only 変更 (末尾改行のみ追加/削除) は厳格 coverage を skip + warn。
//     これは parse-git-diff が "\ No newline at end of file" を MessageLine として返すケースで、
//     panel を切る粒度として実用上意味がないため (UI 上も差分なしに見える)。
//   - rename 対称性サジェスト: AI が rename + 内容変更を asIs.file = newPath と書いた場合、
//     asIs 軸の miss が確実に発生する。miss report に「old → new の rename だった、asIs を oldPath にしませんでしたか」
//     サジェストを付ける。

import type { Panel, DisplayRange } from '@show-me/diff-shared'
import type { FileChange } from './diff-parser'

export type CoverageMiss = {
  file: string
  side: 'asIs' | 'toBe'
  lines: number[]
  ranges: DisplayRange[]
  // rename の場合の「asIs.file = oldPath, toBe.file = newPath」サジェスト。
  // miss が rename に関係している時のみ付与する。
  renameSuggestion?: { from: string; to: string }
}

export type CoverageReport = {
  ok: boolean
  misses: CoverageMiss[]
  // ok=true でも warn だけ出すケース (EOL-only など) を fail と分離するための受け皿。
  warnings: string[]
}

export function validateCoverage(params: {
  changes: FileChange[]
  panels: Panel[]
}): CoverageReport {
  const { changes, panels } = params

  // panel が言及する (file, side) → 行集合 と、全 panel が言及する file 集合を構築。
  const panelCover = new Map<string, Set<number>>()
  const panelFileSet = new Set<string>()
  const key = (file: string, side: 'asIs' | 'toBe') => `${file}\x1f${side}`
  for (const p of panels) {
    if (p.asIs) {
      panelFileSet.add(p.asIs.file)
      const k = key(p.asIs.file, 'asIs')
      const s = panelCover.get(k) ?? new Set<number>()
      for (const r of p.asIs.ranges) for (let n = r.start; n <= r.end; n++) s.add(n)
      panelCover.set(k, s)
    }
    if (p.toBe) {
      panelFileSet.add(p.toBe.file)
      const k = key(p.toBe.file, 'toBe')
      const s = panelCover.get(k) ?? new Set<number>()
      for (const r of p.toBe.ranges) for (let n = r.start; n <= r.end; n++) s.add(n)
      panelCover.set(k, s)
    }
  }

  const misses: CoverageMiss[] = []
  const warnings: string[] = []

  for (const c of changes) {
    // EOL-only は厳格検証 skip
    if (c.eolOnlyChange) {
      warnings.push(`EOL-only change in ${c.path} — coverage check skipped`)
      continue
    }

    // 構造のみ変更 (rename without content / binary): ファイル言及だけ確認
    if (!c.hasContentChange && c.hasStructuralChange) {
      const mentioned =
        panelFileSet.has(c.path) ||
        (c.oldPath != null && panelFileSet.has(c.oldPath))
      if (!mentioned) {
        misses.push({
          file: c.path,
          side: 'toBe',
          lines: [],
          ranges: [],
          renameSuggestion: c.oldPath != null
            ? { from: c.oldPath, to: c.path }
            : undefined,
        })
      }
      continue
    }

    // 通常の内容変更検証 (deleted/added/modified/renamed-with-content)
    // asIs 軸の lookup key は oldPath (rename) があれば oldPath、なければ path
    const asIsFile = c.oldPath ?? c.path
    const asIsCover = panelCover.get(key(asIsFile, 'asIs')) ?? new Set<number>()
    const asIsMissed = [...c.asIsChangedLines]
      .filter(n => !asIsCover.has(n))
      .sort((a, b) => a - b)
    if (asIsMissed.length > 0) {
      const miss: CoverageMiss = {
        file: asIsFile,
        side: 'asIs',
        lines: asIsMissed,
        ranges: compressRanges(asIsMissed),
      }
      // AI が rename を asIs.file = newPath と書いて asIs 軸で oldPath miss が起きたケース。
      // newPath 側に asIs cover があるなら rename サジェストを付ける。
      if (c.oldPath != null && panelCover.has(key(c.path, 'asIs'))) {
        miss.renameSuggestion = { from: c.oldPath, to: c.path }
      }
      misses.push(miss)
    }

    const toBeCover = panelCover.get(key(c.path, 'toBe')) ?? new Set<number>()
    const toBeMissed = [...c.toBeChangedLines]
      .filter(n => !toBeCover.has(n))
      .sort((a, b) => a - b)
    if (toBeMissed.length > 0) {
      misses.push({
        file: c.path,
        side: 'toBe',
        lines: toBeMissed,
        ranges: compressRanges(toBeMissed),
      })
    }
  }

  return { ok: misses.length === 0, misses, warnings }
}

// 連続する行番号を圧縮して inclusive range の配列にする。
// 例: [1,2,3,5,7,8] → [{1,3}, {5,5}, {7,8}]
function compressRanges(sortedLines: number[]): DisplayRange[] {
  if (sortedLines.length === 0) return []
  const out: DisplayRange[] = []
  let s = sortedLines[0]
  let prev = s
  for (let i = 1; i < sortedLines.length; i++) {
    const n = sortedLines[i]
    if (n === prev + 1) {
      prev = n
      continue
    }
    out.push({ start: s, end: prev })
    s = n
    prev = n
  }
  out.push({ start: s, end: prev })
  return out
}

export function formatMissesForStderr(report: CoverageReport): string {
  const out: string[] = []
  if (report.warnings.length > 0) {
    for (const w of report.warnings) out.push(`[warn] ${w}`)
  }
  if (report.misses.length === 0) return out.join('\n')

  out.push('Coverage validation failed. The following changes are not carried by any panel:')
  for (const m of report.misses) {
    const rangeStrs = m.ranges.length === 0
      ? '<structural-only change, no panel mentions this file>'
      : m.ranges.map(r => r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`).join(', ')
    out.push(`  ${m.file} [${m.side}]: ${rangeStrs}`)
    if (m.renameSuggestion) {
      out.push(`    ↳ This file was renamed from "${m.renameSuggestion.from}" to "${m.renameSuggestion.to}".`)
      out.push(`      Did you mean to set asIs.file = "${m.renameSuggestion.from}" and toBe.file = "${m.renameSuggestion.to}"?`)
    }
  }
  out.push('')
  out.push('Fix: extend asIs.ranges / toBe.ranges (or add a panel covering the file) in summary.json.')
  return out.join('\n')
}
