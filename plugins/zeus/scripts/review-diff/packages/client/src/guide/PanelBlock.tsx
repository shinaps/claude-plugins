// 1 Panel をラップする最小コンテナ。
// 役割:
//   - viewport 近接時のみ shiki ハイライトを有効化する lazy 制御 (IntersectionObserver)
//   - data-panel-id 属性を持って GroupNav の scroll-spy / jump がここを anchor にする
//   - panel.segments の row 数合計から panel 高さを実測ベースで推定して
//     inline contain-intrinsic-size に反映 (cv:auto placeholder の精度を上げて CLS pop-in 抑制)
//   - defaultCollapsed=true を受けたら初期 collapsed 状態で開く (Show diff ボタンで個別 expand)
//     Approve 済み group の panels / 巨大 file (raw diff の build artifact 等) に使う
//
// panel ごとの Reviewed チェックは廃止 (group 単位 Approve/Request Changes に統合)。
// Guide / Diff 両タブで同一の lazy highlight 戦略を使う。

import { useCallback, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { RenderedPanel } from '@zeus/review-diff-shared'
import { Panel } from './Panel'
import { PanelHeader, type FileCommentHandlers } from './PanelHeader'
import { useLazyHighlight } from '../lib/useLazyHighlight'
import type { LineCommentHandlers } from './useLineComments'

export type PanelBlockProps = {
  panel: RenderedPanel
  highlight?: boolean
  // 初期 collapsed 状態。ユーザーが Show diff を押すと expand 可能。
  // defaultCollapsed の値変更には反応しない (= mount 後に group decision が変わっても collapsed 状態は維持)。
  defaultCollapsed?: boolean
  // ファイル単位コメント (PanelHeader に pass-through、collapsed 状態でも付けられる)
  fileComments?: FileCommentHandlers
} & LineCommentHandlers

// 行高見積もり (推定値): 1 行 ~22px。多少のズレは cv:auto の auto キーワードでブラウザが
// 実測後に学習するので、初回 placeholder の精度として十分。
const ROW_HEIGHT_PX = 22
const PANEL_HEADER_PX = 56

export function PanelBlock(props: PanelBlockProps) {
  const { panel, highlight, defaultCollapsed, fileComments, ...handlers } = props

  // segments の row 数合計から panel 高さを推定。これを contain-intrinsic-size に流すことで、
  // cv:auto の placeholder が 500px 固定 (CSS default) ではなく、各 panel に正確な値になる。
  const totalRows = useMemo(() => {
    let n = 0
    for (const s of panel.segments) n += s.rows.length
    return n
  }, [panel.segments])

  const intrinsicHeight = useMemo(
    () => PANEL_HEADER_PX + Math.max(totalRows, 4) * ROW_HEIGHT_PX,
    [totalRows],
  )

  // userOverride: ユーザーが Show diff / Hide diff を明示クリックした場合の上書き状態。
  //   null = 上書き無し → defaultCollapsed に追従
  //   'expand' = ユーザーが明示 expand → 常に表示
  //   'collapse' = ユーザーが明示 collapse → 常に collapsed (defaultCollapsed=false でも閉じる)
  // これで「通常状態の panel をユーザーが任意で閉じる」「approved auto-collapse をユーザーが開く」の
  // 両方が UX 意思を尊重して実現できる。
  const [userOverride, setUserOverride] = useState<'expand' | 'collapse' | null>(null)
  const isCollapsed = userOverride === 'collapse' || (userOverride === null && defaultCollapsed === true)

  // collapse / expand のクリック時に View Transitions API で crossfade。
  // 非対応ブラウザ (Firefox 一部バージョンなど) では即時 state 更新フォールバック。
  // flushSync で state 更新を同期 commit して、startViewTransition の前後で snapshot が
  // 正しく撮られるようにする (concurrent rendering を待たない)。
  //
  // パフォーマンス + UX:
  // collapse 時にスティッキー header が見えていた viewport 位置を保持する scroll anchoring。
  // 「スクロールして body 途中で sticky になっていた状態で Hide」を押すと、ナイーブには
  // panel-block が大きく縮小して下のコンテンツが viewport の上半分に移動してしまう。
  // ユーザー期待は「collapsed header が元 sticky 位置に来て、次の panel がその真下に出る」。
  // 実装: collapse 直前の sticky header 位置を記録 → state commit 後の panel-block 位置との差で
  // window.scrollBy で補正する。scrollY が負になる場合は 0 にクランプ。
  const setOverrideWithTransition = useCallback((next: 'expand' | 'collapse') => {
    let anchorViewportY: number | null = null
    if (next === 'collapse') {
      const block = blockRef.current
      const header = block?.querySelector('.panel-header') as HTMLElement | null
      if (header) anchorViewportY = header.getBoundingClientRect().top
    }
    const commit = () => {
      flushSync(() => setUserOverride(next))
      if (next === 'collapse' && anchorViewportY !== null) {
        const block = blockRef.current
        if (block) {
          const newTop = block.getBoundingClientRect().top
          const delta = newTop - anchorViewportY
          if (Math.abs(delta) > 0.5) {
            window.scrollBy(0, delta)
          }
        }
      }
    }
    const doc = typeof document !== 'undefined'
      ? (document as Document & { startViewTransition?: (cb: () => void) => unknown })
      : null
    if (doc && typeof doc.startViewTransition === 'function' &&
        !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      doc.startViewTransition(commit)
    } else {
      commit()
    }
  }, [])

  // viewport 近接時のみ shiki ハイライトを有効化することで、初回マウントのレンダリング負荷を激減させる。
  // 一度可視になったら以後 true 固定。明示的に highlight=false なら lazy 判定 skip。
  const blockRef = useRef<HTMLDivElement>(null)
  const lazyVisible = useLazyHighlight(blockRef)
  const effectiveHighlight = highlight !== false && lazyVisible

  if (isCollapsed) {
    // collapsed 状態でも PanelHeader (intent + ファイル名) を維持。
    // 右端の Show diff ボタンに「N rows」を併記し、UX 上「ここに何行ある panel か」が一目で分かる。
    //
    // panel-block BEM 維持: globals.css で content-visibility:auto + scroll-margin-top + sticky panel-header
    // のスコープ用に必要。panel-block-collapsed は scroll anchor 用の panel-header 内 selector
    // (`.panel-block-collapsed .panel-header { border-bottom: none }`) があるため維持。
    return (
      <div
        ref={blockRef}
        className="panel-block panel-block-collapsed bg-surface border border-border-soft rounded-[10px] mb-4 overflow-hidden"
        data-panel-id={panel.panelId}
        style={{ containIntrinsicSize: 'auto 60px' }}
      >
        <PanelHeader
          panel={panel}
          onExpand={() => setOverrideWithTransition('expand')}
          totalRowsHint={totalRows}
          fileComments={fileComments}
        />
      </div>
    )
  }

  return (
    <div
      ref={blockRef}
      className="panel-block bg-surface border border-border-soft rounded-[10px] mb-4"
      data-panel-id={panel.panelId}
      style={{ containIntrinsicSize: `auto ${intrinsicHeight}px` }}
    >
      <Panel
        panel={panel}
        highlight={effectiveHighlight}
        onCollapse={() => setOverrideWithTransition('collapse')}
        fileComments={fileComments}
        {...handlers}
      />
    </div>
  )
}

// 閾値は App.tsx 側 (DIFF_TAB_COLLAPSE_ROW_THRESHOLD) で管理するように移動済み。
// Guide タブは decision-based + ファイル名 pattern、Diff タブは row 数 + ファイル名 pattern で
// それぞれ判定する。PanelBlock は defaultCollapsed: boolean を受けるだけのシンプルな contract。
