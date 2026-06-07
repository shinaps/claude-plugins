// 1 Panel を side-by-side 表示用の RenderedPanel に変換する。
//
// 設計判断:
//   - 行 LCS は parse-git-diff の hunks ではなく jsdiff の diffArrays で改めて取り直す。
//     panel は「asIs.ranges と toBe.ranges のペアの集合」であり、git の hunk 単位と一致しない
//     (1 panel が複数 hunk を跨いだり、unchanged 行だけを panel に含める "context-only panel" が
//     ありえる)。raw before/after を panel range で slice してから LCS を取るのが素直。
//   - subpath import (`diff/lib/diff/array.js`) で bundle size を抑える。
//     jsdiff は line/word/character/css/json など多くのアルゴリズムを含むが、本実装は array のみ使う。
//   - cross-file 異言語 (例: .js → .ts) を許容するため asIsLanguage / toBeLanguage を別持ち。
//     unified モードでは toBeLanguage を優先 (新コード側を正しい言語で見せる意図)、
//     split モードでは左右それぞれで別言語ハイライト。
//   - ranges 不一致 (asIs.ranges.length !== toBe.ranges.length) を許容するため、
//     pairCount = max(...)。余った側は空 range として segment を生成 (片側 empty 行が出る)。

// 注: bundle size 抑制のため subpath import 'diff/lib/diff/array.js' を試したが、
// @types/diff が subpath を declare module してくれず、ambient .d.ts shim も実 .js を
// 優先するため型エラーが解消できなかった。esbuild の tree-shaking で未使用 export は
// 落ちる前提で top-level import に倒す (Phase 0 baseline + Phase J で bundle 計測して確認)。
import { diffArrays } from 'diff'
import type {
  Panel,
  RenderedPanel,
  RenderedSegment,
  SideBySideRow,
  DisplayRange,
} from '@zeus/review-diff-shared'
import { langForPath } from './diff-parser'
import type { SourcesMap } from './server'

export function renderPanel(panel: Panel, sources: SourcesMap): RenderedPanel {
  const asIsFile = panel.asIs?.file
  const toBeFile = panel.toBe?.file

  const asIsLanguage = asIsFile ? langForPath(asIsFile) : undefined
  const toBeLanguage = toBeFile ? langForPath(toBeFile) : undefined

  const asIsRanges = panel.asIs?.ranges ?? []
  const toBeRanges = panel.toBe?.ranges ?? []
  const pairCount = Math.max(asIsRanges.length, toBeRanges.length)
  const segments: RenderedSegment[] = []

  for (let i = 0; i < pairCount; i++) {
    const aR = asIsRanges[i]
    const bR = toBeRanges[i]
    const asIsLines = aR && asIsFile ? sliceLines(sources, asIsFile, 'before', aR) : []
    const toBeLines = bR && toBeFile ? sliceLines(sources, toBeFile, 'after', bR) : []
    const rows = pairToRows({
      asIsLines,
      asIsStart: aR?.start ?? 1,
      toBeLines,
      toBeStart: bR?.start ?? 1,
    })
    segments.push({ asIsRange: aR, toBeRange: bR, rows })
  }

  return {
    ...panel,
    asIsLanguage,
    toBeLanguage,
    segments,
    asIsTotal: asIsFile ? countLinesOfSource(sources, asIsFile, 'before') : undefined,
    toBeTotal: toBeFile ? countLinesOfSource(sources, toBeFile, 'after') : undefined,
  }
}

// jsdiff diffArrays は added/removed/共通 の連続ブロックを返す。
// removed の直後が added なら「modified pair」とみなして同一 row に並べる
// (左 deletion / 右 addition)。長さが異なる場合は max で揃え、余った側を empty にする。
function pairToRows(params: {
  asIsLines: string[]; asIsStart: number
  toBeLines: string[]; toBeStart: number
}): SideBySideRow[] {
  const { asIsLines, asIsStart, toBeLines, toBeStart } = params
  const diff = diffArrays(asIsLines, toBeLines) as Array<{
    value: string[]
    added?: boolean
    removed?: boolean
  }>
  const rows: SideBySideRow[] = []
  let aCur = asIsStart
  let bCur = toBeStart

  for (let idx = 0; idx < diff.length; idx++) {
    const part = diff[idx]
    if (part.removed) {
      const next = diff[idx + 1]
      if (next?.added) {
        const max = Math.max(part.value.length, next.value.length)
        for (let i = 0; i < max; i++) {
          const a = part.value[i]
          const b = next.value[i]
          rows.push({
            asIs: a != null ? { type: 'deletion', line: aCur++, raw: a } : { type: 'empty', raw: '' },
            toBe: b != null ? { type: 'addition', line: bCur++, raw: b } : { type: 'empty', raw: '' },
          })
        }
        idx++
        continue
      }
      for (const a of part.value) {
        rows.push({
          asIs: { type: 'deletion', line: aCur++, raw: a },
          toBe: { type: 'empty', raw: '' },
        })
      }
    } else if (part.added) {
      for (const b of part.value) {
        rows.push({
          asIs: { type: 'empty', raw: '' },
          toBe: { type: 'addition', line: bCur++, raw: b },
        })
      }
    } else {
      // 共通部分 (context)。左右両方に同じ raw を入れる。
      for (const v of part.value) {
        rows.push({
          asIs: { type: 'context', line: aCur++, raw: v },
          toBe: { type: 'context', line: bCur++, raw: v },
        })
      }
    }
  }
  return rows
}

// 指定 range (1-based, inclusive) を file 原文から切り出す。
// sources に file が無い場合は空配列を返す (panel-renderer は空 segment を生成する)。
function sliceLines(
  sources: SourcesMap,
  file: string,
  side: 'before' | 'after',
  range: DisplayRange,
): string[] {
  const src = sources.get(file)
  if (!src) return []
  const text = side === 'before' ? src.before : src.after
  if (!text) return []
  const lines = text.split('\n')
  return lines.slice(range.start - 1, range.end)
}

// 末尾改行を 1 行と数えないことで afterTotal / asIsTotal の "phantom 空行" を防ぐ。
// shared/countLines と同じ式 (重複コードだが server を shared 依存にしない方針)。
function countLinesOfSource(
  sources: SourcesMap,
  file: string,
  side: 'before' | 'after',
): number {
  const src = sources.get(file)
  if (!src) return 0
  const text = side === 'before' ? src.before : src.after
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}
