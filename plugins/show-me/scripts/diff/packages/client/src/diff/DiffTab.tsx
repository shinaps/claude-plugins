// Diff タブ: GitHub 風の「ファイル単位 split-side-by-side 差分」を縦積みで表示。
// Guide タブの AI グルーピングを介さず、git diff の出力ファイル順にすべて並べる。
// PanelBlock は Guide タブと完全同一実装 (lazyHighlight + intrinsic-size + sticky header)。
//
// 左 sticky nav にファイル一覧 (intent + +N/-M 差分カウント) を配置。
// GitHub PR の Files Changed タブと同じ感覚で「全ファイル俯瞰 + クリックで該当ファイルへジャンプ」できる。
//
// memo 境界として App から分離している: rawPanels (payload 由来で不変) と安定 callback しか
// 受けないため、App の state 変化 (group コメント入力等) では再 render されず、
// O(全 row) の差分カウント集計も Diff タブ初回 mount まで一切走らない。

import { memo, useMemo } from 'react'
import type { RenderedPanel } from '@show-me/diff-shared'
import { PanelBlock } from '../guide/PanelBlock'
import type { FileCommentHandlers } from '../guide/PanelHeader'
import type { LineCommentHandlers } from '../guide/useLineComments'
import { shouldAutoCollapseFile } from '../guide/auto-collapse'
import { basename } from '../lib/path'

// Diff タブで初期 collapsed にする行数の閾値。Guide タブと違って 1 panel = 1 file 全体なので
// 「ちょっとした変更でもファイル全部表示」になりがち。閾値を低めに振って俯瞰時の応答性を確保。
const DIFF_TAB_COLLAPSE_ROW_THRESHOLD = 200

export type DiffTabProps = {
  rawPanels: ReadonlyArray<RenderedPanel>
  fileComments?: FileCommentHandlers
  onJumpToRawPanel: (panelId: string) => void
} & LineCommentHandlers

type PanelStats = { add: number; del: number; totalRows: number }

export const DiffTab = memo(function DiffTab(props: DiffTabProps) {
  const { rawPanels, fileComments, onJumpToRawPanel, ...lineCommentHandlers } = props

  // 差分カウント (+N/-M) と行数 (collapsed 判定用) を 1 パスで集計。
  // rawPanels は payload 由来で不変なので実質 mount 時 1 回だけ走る。
  const statsByPanel = useMemo(() => {
    const m = new Map<string, PanelStats>()
    for (const p of rawPanels) {
      let add = 0
      let del = 0
      let totalRows = 0
      for (const seg of p.segments) {
        totalRows += seg.rows.length
        for (const row of seg.rows) {
          if (row.toBe.type === 'addition') add++
          if (row.asIs.type === 'deletion') del++
        }
      }
      m.set(p.panelId, { add, del, totalRows })
    }
    return m
  }, [rawPanels])

  return (
    // raw-diff-tab BEM 維持 (App の jumpToRawPanel の querySelector で参照される) + 内側 scope に
    // `--nav-width: 280px` を設定。grid-template-columns は var(--nav-width) を参照し、内側
    // .comment-row も同じ var を calc で使うため、280 を 1 箇所だけ書く形にして将来の変更漏れを防ぐ。
    <div className="raw-diff-tab grid gap-6 px-6 pt-4 pb-20 grid-cols-[var(--nav-width)_minmax(0,1fr)] [--nav-width:280px]">
      {/* raw-diff-nav BEM 維持: ::-webkit-scrollbar 非表示 rule を globals.css でスコープしているため */}
      <aside
        className="raw-diff-nav sticky top-14 self-start max-h-[calc(100vh-80px)] overflow-y-auto pr-1 flex flex-col gap-0.5 [scrollbar-width:none] [-ms-overflow-style:none]"
        aria-label="Changed files"
      >
        {rawPanels.map((p) => {
          const stats = statsByPanel.get(p.panelId)
          const add = stats?.add ?? 0
          const del = stats?.del ?? 0
          return (
            <button
              key={p.panelId}
              type="button"
              className="grid grid-cols-[1fr_auto] grid-rows-[auto_auto] gap-x-2 px-2.5 py-1.5 bg-transparent border-0 rounded-md text-left text-text font-sans cursor-pointer transition-colors duration-100 hover:bg-surface-2"
              onClick={() => onJumpToRawPanel(p.panelId)}
              title={p.intent}
            >
              <span className="col-start-1 row-start-1 text-xs font-medium overflow-hidden text-ellipsis whitespace-nowrap">{basenameFromIntent(p.intent)}</span>
              <span className="col-start-2 row-start-1 inline-flex gap-1 items-baseline font-mono text-2xs tabular-nums">
                {add > 0 ? <span className="text-add-fg">+{add}</span> : null}
                {del > 0 ? <span className="text-del-fg">-{del}</span> : null}
              </span>
              <span className="col-span-full row-start-2 text-2xs text-text-dim font-mono overflow-hidden text-ellipsis whitespace-nowrap">{p.intent}</span>
            </button>
          )
        })}
      </aside>
      <div className="flex flex-col min-w-0">
        {rawPanels.map((p) => {
          // 巨大 panel (build artifact 等) は初期 collapsed で開いてレンダリングコストを抑制。
          // segments の合計 row 数で判定。
          const totalRows = statsByPanel.get(p.panelId)?.totalRows ?? 0
          const file = p.toBe?.file ?? p.asIs?.file
          const isAutoCollapseByPattern = shouldAutoCollapseFile(file)
          const isAutoCollapseByRows = totalRows > DIFF_TAB_COLLAPSE_ROW_THRESHOLD
          return (
            <PanelBlock
              key={p.panelId}
              panel={p}
              defaultCollapsed={isAutoCollapseByPattern || isAutoCollapseByRows}
              fileComments={fileComments}
              {...lineCommentHandlers}
            />
          )
        })}
        {rawPanels.length === 0 ? (
          <div className="px-6 py-[60px] text-center text-text-dim text-sm leading-normal">No file changes to display.</div>
        ) : null}
      </div>
    </div>
  )
})

// panel の intent 表示用 basename。lib/path の basename と違い、rename 矢印表記
// "old → new" を new 側 (矢印の後) に分解してから basename を取る。
function basenameFromIntent(intentOrPath: string): string {
  const arrowIdx = intentOrPath.indexOf('→')
  const target = arrowIdx >= 0 ? intentOrPath.slice(arrowIdx + 1).trim() : intentOrPath
  return basename(target)
}
