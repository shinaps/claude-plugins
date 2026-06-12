// 1 Panel = 1 CSS Grid (div ベース) でレンダリングするコンポーネント (split only)。
//
// 設計判断 (旧 <table> 構造 / 旧 unified mode 廃止):
//   - 旧 <table> 構造では「左右独立横スクロール + 50/50 + 行高同期」が CSS 仕様上同時充足
//     不可能だった (table cell は per-cell scroll しか出来ず、列方向の cell 群を 1 つの scroll
//     viewport に束ねる box が CSS table model に存在しない)。
//     対症療法 (table-layout fixed/auto、useLayoutEffect で table.style.width 実測など 4 回試行)
//     はすべて根本的に解決不能だったため、DOM 構造そのものを div + CSS Grid に置換した。
//   - panel-grid を 2 列 (asIs side + toBe side) で構成。各 side は独立した overflow-x:auto
//     コンテナで、その中で gutter + code を縦に積む。
//     これにより「左右独立 1 スクロールバー」+「per-side blowout 防止 (minmax(0, 1fr))」を構造的に達成。
//   - 行高同期: ResizeObserver で各 side の同一インデックス .code-row の offsetHeight max を
//     min-height として書き戻す JS 同期方式。
//     subgrid は同一 scroll container 内でしか機能しないため per-side scroll と排他。
//   - unified mode (単一カラム) は撤去済み。split mode 一本化で UI 学習コストを下げ、
//     mode toggle に必要だった localStorage / mode toggle button / comment-side-badge も削減できた。
//   - AC-6 (panel 跨ぎコメント不可): panelContainerRef.contains(cell) で構造的に担保。
//     セレクタは `closest('[data-side][data-line-number]')` に統一 (td/div どちらでも動く)。
//   - LineCommentHandlers は panelId 単位で thread を管理する。
//   - sortAnchorKeys: 範囲 → 単一の順、で並べる (旧 DiffTable と同じ UX)。

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, SquareArrowOutUpRight } from 'lucide-react'
import type { RenderedPanel, SideBySideRow, Side, ThreadSnapshot } from '@show-me/diff-shared'
import { sideToAttr, attrToSide } from '@show-me/diff-shared'
import { parseLineCommentKey, lineCommentKey, getToken } from '../lib/state'
import { escapeHtml } from '../lib/markdown'
import { highlightCode } from '../lib/highlight-code'
import { intraLineDecorations } from '../lib/char-diff'
import { PanelHeader, type FileCommentHandlers } from './PanelHeader'
import { CommentRow, anchorMapKey, appendCommentKey, sortAnchorKeys } from './CommentRow'
import { UnifiedBody } from './UnifiedBody'
import type { LineCommentHandlers } from './useLineComments'

// v5: window 経由で editorAvailable と editor-open Toast コールバックを受け渡す。
// prop drilling を避けるための簡易チャネル (App → Panel が深いため)。
//   - __reviewDiffEditorAvailable : boolean、設定された editor preset があれば true
//   - __reviewDiffShowToast       : (msg: string) => void、Toast 表示
//   - __reviewDiffThreads         : 永続化済みスレッド (payload.initialThreads)、user/agent message を全表示
//
// CR-3: editor command 自体は server 側のみで保持される。クライアントは boolean だけ知る。
declare global {
  interface Window {
    __reviewDiffEditorAvailable?: boolean
    __reviewDiffShowToast?: (msg: string) => void
    __reviewDiffThreads?: Record<string, ThreadSnapshot>
  }
}

// panelId に紐付くコメント key を (side, anchor) で逆引きする Map を組む純関数。
// 含めるのは 3 系統で、後段ほど dedup されて追記される:
//   1. 確定済みコメント (lineComments の key 群)
//   2. 入力中フォーム (activeForm) — まだ lineComments に無い新規入力中の行にも CommentRow を出すため
//   3. 永続化された thread (= 前回 submit + Claude 応答) — 今セッションでコメントしていない行にも
//      過去スレッドを render するため
// export はユニットテスト用 (Panel render を介さず Map 構築の contract を直接検証する)。
export function buildCommentKeysByAnchor(
  panelId: string,
  lineCommentKeys: Iterable<string>,
  activeForm: string | null,
  threads: Record<string, ThreadSnapshot> | undefined,
): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const key of lineCommentKeys) {
    const parsed = parseLineCommentKey(key)
    if (parsed.panelId !== panelId) continue
    appendCommentKey(map, anchorMapKey(parsed.side, parsed.endNumber ?? parsed.number), key)
  }
  if (activeForm) {
    const parsed = parseLineCommentKey(activeForm)
    if (parsed.panelId === panelId) {
      appendCommentKey(map, anchorMapKey(parsed.side, parsed.endNumber ?? parsed.number), activeForm)
    }
  }
  if (threads) {
    for (const snap of Object.values(threads)) {
      if (snap.scope.type !== 'line') continue
      if (snap.scope.panelId !== panelId) continue
      const key = lineCommentKey(snap.scope.panelId, snap.scope.side, snap.scope.line, snap.scope.endLine)
      appendCommentKey(map, anchorMapKey(snap.scope.side, snap.scope.endLine ?? snap.scope.line), key)
    }
  }
  return map
}

type FlatRow = {
  row: SideBySideRow
  segmentIndex: number
  rowIndex: number
  isFirstOfSegment: boolean
  // 連続する addition / deletion ブロックを 1 chunk とした index。context / empty 行は -1。
  // ↑↓ キーのグローバルジャンプ (useChunkKeyNav) が `[data-chunk-idx]` を querySelectorAll で
  // 集めて panel をまたぐ全 chunk リストを構築する anchor として使う。
  chunkIdx: number
}

// chunk 検出: addition / deletion が連続する塊を 1 chunk としてまとめる。
// context や empty が挟まれば chunk 境界。chunkIdx は panel scope (各 panel で 0 から)。
// useChunkKeyNav は panel をまたいで「最初の chunk row」を順に並べることで全体 navigation を実現する。
function flattenWithChunks(panel: RenderedPanel): FlatRow[] {
  const flat: FlatRow[] = []
  panel.segments.forEach((seg, si) => {
    seg.rows.forEach((row, ri) => {
      flat.push({ row, segmentIndex: si, rowIndex: ri, isFirstOfSegment: ri === 0 && si > 0, chunkIdx: -1 })
    })
  })
  let chunkIdx = -1
  let inChunk = false
  for (const r of flat) {
    const isChange = r.row.asIs.type === 'deletion' || r.row.toBe.type === 'addition'
    if (isChange) {
      if (!inChunk) { chunkIdx++; inChunk = true }
      r.chunkIdx = chunkIdx
    } else {
      inChunk = false
    }
  }
  return flat
}

type DragState = {
  side: Side
  startNumber: number
  currentNumber: number
} | null

export type PanelProps = {
  panel: RenderedPanel
  highlight?: boolean
  // 単一カラム unified 表示 (モバイル / 狭幅ウィンドウ)。false なら従来の split。
  unified?: boolean
  // PanelHeader 右に Hide diff ボタンを出すための callback。
  // PanelBlock 側で「userOverride='collapse' 状態に切替」をハンドル。
  onCollapse?: () => void
  // ファイル単位コメント (PanelHeader に pass-through)
  fileComments?: FileCommentHandlers
} & LineCommentHandlers

export const Panel = memo(function Panel({
  panel,
  highlight = true,
  unified = false,
  onCollapse,
  fileComments,
  ...handlers
}: PanelProps) {
  const [drag, setDrag] = useState<DragState>(null)
  const dragRef = useRef<DragState>(null)
  // 旧 panelTableRef → panelContainerRef。div ベースに変わったので HTMLDivElement で受ける。
  // resolveLineAtPoint の AC-6 scope check (別 panel の cell を弾く) で使用。
  const panelContainerRef = useRef<HTMLDivElement>(null)

  // chunk = 連続する addition/deletion 塊。SplitBody に flat を渡すために計算する。
  // ナビゲーション本体は useChunkKeyNav (↑↓ キー) が document 全体を querySelectorAll で
  // 走査して panel をまたいで動くので、ここでは「chunkIdx を code-row に乗せる」だけが責務。
  const flat = useMemo(() => flattenWithChunks(panel), [panel])

  // 行高同期: per-side scroll container が分かれた結果、左右で行高がズレる
  // (例: 左 side のみ wrap して高さが伸びるケース)。subgrid なら親 grid 内で自動的に揃うが、
  // 本実装では左右が別 scroll container なので subgrid が使えない。
  // ResizeObserver で各 .code-row を観測し、両 side の同一インデックス行の offsetHeight max を
  // min-height として書き戻して同期する。requestAnimationFrame で coalesce してレイアウト
  // スラッシングを防ぐ。
  useLayoutEffect(() => {
    // unified では左右が無いので行高同期は不要。deps に unified を含めるのは、画面回転や
    // リサイズで実行時に unified⇄split が切り替わったとき effect を付け直すため
    // (ガードだけだと split 復帰後に同期が一切動かないまま固まる)。
    if (unified) return
    const container = panelContainerRef.current
    if (!container) return
    let raf = 0
    // IntersectionObserver で sync をゲートする。ゲートが無いと tab reveal 時に
    // 22 panel × per-side × N row の ResizeObserver が一斉発火して数秒級の LoAF になる。
    // viewport ± 200px 外の panel は sync を完全 skip することで「同 frame に 22 panel 集中」を防ぐ。
    let isVisible = typeof IntersectionObserver === 'undefined' // SSR / happy-dom 互換 fallback
    const sync = () => {
      raf = 0
      if (!isVisible) return  // viewport 外 panel は完全スキップ
      const leftRows = container.querySelectorAll<HTMLElement>('.panel-side-asis .code-row')
      const rightRows = container.querySelectorAll<HTMLElement>('.panel-side-tobe .code-row')
      const n = Math.min(leftRows.length, rightRows.length)
      if (n === 0) return
      // パフォーマンス最適化: display:none / content-visibility:hidden 中は offsetHeight=0 になり
      // 全 row に minHeight=0 を書く副作用を避けるため、最初の 1 行だけ probe して skip 判定。
      // ResizeObserver は display:none 復帰時に「全 row が 0→実サイズ」の遷移で一斉発火するため、
      // 非表示中の sync 呼出をスキップすれば LoAF で計測された forced-layout 3.1 秒級の主犯を抑制できる。
      if (leftRows[0].offsetHeight === 0 && rightRows[0].offsetHeight === 0) return

      // パフォーマンス最適化: read / write を 3-pass に厳密分離して forced sync layout を
      // N 回 → 1 回に削減する。元実装は loop 内で `offsetHeight` 直後に `style.minHeight` を書いていたため、
      // 各 row で layout が強制フラッシュされ N 行 = N 回の reflow になっていた (28 panel × 数千 row = 6 秒)。
      //   Pass 1: 全 row の minHeight を '' にして natural サイズに戻す (layout 無効化のみ)
      //   Pass 2: 全 row の getBoundingClientRect().height を一括 read (1 回だけ layout flush)
      //   Pass 3: 全 row に新しい minHeight を一括 write (layout 無効化のみ)
      //
      // height 計測に getBoundingClientRect().height + Math.ceil を使う理由 (sub-pixel 蓄積ずれ修正):
      //   offsetHeight は integer (Chrome は floor)。Shiki の font metrics で asis=17.00 / tobe=17.04 の
      //   ような sub-pixel 差が出ると、offsetHeight は両方 17 → min-height: 17px → tobe は 17.04 の
      //   ままで揃わず、行ごとに +0.04 ずつ累積し 数百行で数 px のずれになる (実機 DevTools で確認済)。
      //   getBoundingClientRect().height は float、Math.ceil() で sub-pixel を吸収して大きい側に揃える。
      for (let i = 0; i < n; i++) {
        leftRows[i].style.minHeight = ''
        rightRows[i].style.minHeight = ''
      }
      const heights: number[] = new Array(n)
      for (let i = 0; i < n; i++) {
        const la = leftRows[i].getBoundingClientRect().height
        const lb = rightRows[i].getBoundingClientRect().height
        heights[i] = Math.ceil(Math.max(la, lb))
      }
      for (let i = 0; i < n; i++) {
        const h = heights[i]
        leftRows[i].style.minHeight = `${h}px`
        rightRows[i].style.minHeight = `${h}px`
      }
    }
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(sync)
    }
    sync()
    const ro = new ResizeObserver(schedule)
    container.querySelectorAll<HTMLElement>('.code-row').forEach((el) => ro.observe(el))
    // viewport ±200px に入った瞬間に isVisible を立てて sync をキック。
    // tab-hidden 配下では IO は intersecting=false を返すため自然にゲートが効く。
    // happy-dom (= IntersectionObserver なし) では isVisible 初期値 true なので分岐に入らない。
    let io: IntersectionObserver | null = null
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !isVisible) {
              isVisible = true
              schedule()
            }
          }
        },
        { root: null, rootMargin: '200px 0px' },
      )
      io.observe(container)
    }
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      io?.disconnect()
      container.querySelectorAll<HTMLElement>('.code-row').forEach((el) => {
        el.style.minHeight = ''
      })
    }
  }, [panel.segments, unified])

  // v5: panel-side の実 clientWidth を CSS variable --ps-width に書き出し、
  // .comment-row が `width: var(--ps-width)` で参照する。
  //
  // 背景: 旧実装の `.comment-row` width は `calc((100vw - --nav-width - 48px) / 2 - 1px)` の
  // viewport ベースで、実際の panel-side clientWidth と +16px ほどズレていた (= .group-section の
  // gap 32px が viewport calc に含まれていない等のため)。これにより comment-row が sticky parent
  // (.panel-side-inner) の右端からはみ出し、scrollLeft = max 付近で「containing block 右端を超えない」
  // sticky 制約に押されて 16px シフトしていた (= ユーザー指摘の「右端で少し動く」ジッター)。
  //
  // 解決: ResizeObserver で .panel-side 自身の clientWidth を観測し、要素 inline style として
  // CSS variable をセットする。viewport / nav width / scrollbar gutter / grid gap などの影響を
  // 全て吸収できる (実 clientWidth は計算誤差ゼロ)。
  useLayoutEffect(() => {
    // unified では UnifiedBody が自前で --ps-width を書くため不要 (deps の unified は行高同期と同じ理由)
    if (unified) return
    const container = panelContainerRef.current
    if (!container) return
    const sides = container.querySelectorAll<HTMLElement>('.panel-side')
    const update = (el: HTMLElement) => {
      const w = el.clientWidth
      const prev = el.style.getPropertyValue('--ps-width')
      const next = `${w}px`
      // 同値 skip (App.tsx L460-477 と同じパターン、不要な reflow を抑止)
      if (prev === next) return
      el.style.setProperty('--ps-width', next)
    }
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) update(entry.target as HTMLElement)
    })
    sides.forEach((el) => {
      update(el)
      ro.observe(el)
    })
    return () => ro.disconnect()
  }, [unified])

  // 左右スクロール同期: per-side が独立 overflow-x:auto なので、片側を横スクロールすると
  // 反対側は動かない。ユーザー要望で「赤と緑のスクロールが同期」= 1 panel 内では
  // asIs / toBe の scrollLeft が常に一致するべき。双方向 mirror で sync する。
  //
  // パフォーマンス最適化: 旧実装は `syncing` フラグで再帰防止していたが、連続スクロール時に
  // 「フラグが立っている間の event が drop される」(rAF 解除まで 16ms)。その間ユーザーが
  // スクロールし続けると mirror 側は止まり、解除後に「累積分が一気に飛ぶ」カクカク現象が出ていた。
  // 新実装: scroll event は drop せず latest scrollLeft を rAF にバッチ保留 → frame 単位で apply。
  // 再帰防止は「dst が src と同値なら skip」で取る (sync 直後の反対側 scroll event は no-op)。
  useLayoutEffect(() => {
    // unified では mirror すべき反対 side が無い (deps の unified は行高同期と同じ理由)
    if (unified) return
    const container = panelContainerRef.current
    if (!container) return
    const asis = container.querySelector<HTMLElement>('.panel-side-asis')
    const tobe = container.querySelector<HTMLElement>('.panel-side-tobe')
    if (!asis || !tobe) return
    let rafId = 0
    let pendingFrom: HTMLElement | null = null
    // comment-row の横 pinning: in-flow の comment-row は transform: translateX(var(--ps-scroll-x))
    // で panel-side の visible 左端に固定する (globals.css .comment-row)。
    // sticky を使わない理由: .panel-block / .group-section の content-visibility: auto の暗黙 contain が
    // sticky の containing block を redirect し、コメントが横スクロールに追従して流れてしまうため。
    // transform は containing block に依存しないので cv:auto と共存できる。
    const pinComments = (el: HTMLElement) => {
      el.style.setProperty('--ps-scroll-x', `${el.scrollLeft}px`)
    }
    const flush = () => {
      rafId = 0
      const src = pendingFrom
      pendingFrom = null
      if (!src) return
      const dst = src === asis ? tobe : asis
      if (Math.abs(dst.scrollLeft - src.scrollLeft) > 0.5) {
        dst.scrollLeft = src.scrollLeft
        pinComments(dst)
      }
    }
    const handler = (src: HTMLElement) => () => {
      // pinning は rAF バッチを待たず同期更新する: 1 frame でも遅れると
      // 「コメントだけ横に置いていかれて戻る」ジッターが見えるため (sticky と同じ即応性を保つ)
      pinComments(src)
      pendingFrom = src
      if (rafId) return
      rafId = requestAnimationFrame(flush)
    }
    const onAsis = handler(asis)
    const onTobe = handler(tobe)
    asis.addEventListener('scroll', onAsis, { passive: true })
    tobe.addEventListener('scroll', onTobe, { passive: true })
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      asis.removeEventListener('scroll', onAsis)
      tobe.removeEventListener('scroll', onTobe)
    }
  }, [unified])

  const setDragBoth = useCallback((next: DragState) => {
    dragRef.current = next
    setDrag(next)
  }, [])

  // カーソル位置 → 対象行 (panel scoped)。別 panel の cell はここで null に落ちる (AC-6)。
  // セレクタは td でも div でも動くように `[data-side][data-line-number]` で統一。
  const resolveLineAtPoint = useCallback((
    clientX: number, clientY: number, expectSide: Side,
  ): number | null => {
    // hot-path: cursor 直下に expectSide の cell があれば即返却。
    // panel 内で expectSide 上をドラッグしている通常ケースをこの分岐で 99% 捌く。
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    if (el) {
      const cell = el.closest('[data-side][data-line-number]') as HTMLElement | null
      // panelContainerRef.contains で AC-6 構造的担保: 別 panel の cell は無視
      if (cell && (!panelContainerRef.current || panelContainerRef.current.contains(cell))) {
        const sideAttr = cell.dataset.side
        const side = sideAttr ? attrToSide(sideAttr) : null
        if (side === expectSide) {
          const num = cell.dataset.lineNumber
          const n = num ? Number(num) : NaN
          if (Number.isFinite(n)) return n
        }
      }
    }
    // cold-path: cursor が panel 外 / 反対 side / 中央コラム / panel 上下端の外側にいるとき、
    // expectSide の cell-ln 群を線形探索して cursor Y に最も近い行を選ぶ (clamp 効果)。
    // drag indicator の onMove と同じ snap ポリシーで、行ハイライトも同じ行に追従する。
    if (!panelContainerRef.current) return null
    const sideAttr = sideToAttr(expectSide)
    const cellLns = panelContainerRef.current.querySelectorAll<HTMLElement>(
      `.cell-ln[data-side="${sideAttr}"]`,
    )
    let closestNum: number | null = null
    let closestDist = Infinity
    for (const ln of cellLns) {
      const num = ln.dataset.lineNumber
      if (!num) continue
      const n = Number(num)
      if (!Number.isFinite(n)) continue
      const r = ln.getBoundingClientRect()
      const center = r.top + r.height / 2
      const dist = Math.abs(clientY - center)
      if (dist < closestDist) {
        closestDist = dist
        closestNum = n
      }
    }
    return closestNum
  }, [])

  // ドラッグ完了時の選択コミット (唯一のコミット実装)。終了座標を行に解決し (解決不能なら
  // drag 中の currentNumber にフォールバック)、単一行 or 範囲で onOpenLineForm を呼んで
  // drag 状態をクリアする。React の onPointerUp と window 保険ハンドラの両経路から呼ばれる
  // 共通仕様なので、コミット挙動を変えるときはここだけ直せばよい。
  const commitDragSelection = useCallback((
    clientX: number, clientY: number, cur: NonNullable<DragState>,
  ) => {
    const endNumber = resolveLineAtPoint(clientX, clientY, cur.side) ?? cur.currentNumber
    const lo = Math.min(cur.startNumber, endNumber)
    const hi = Math.max(cur.startNumber, endNumber)
    if (lo === hi) {
      handlers.onOpenLineForm(panel.panelId, { side: cur.side, number: lo })
    } else {
      handlers.onOpenLineForm(panel.panelId, { side: cur.side, number: lo, endNumber: hi })
    }
    setDragBoth(null)
  }, [resolveLineAtPoint, handlers, panel.panelId, setDragBoth])

  // ドラッグ中 Escape キャンセル + window pointerup 保険 (cross-panel drag は完全に弾く)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setDragBoth(null)
    }
    // pointer capture が外れて React の onPointerUp に届かないケース (panel 外で離した等) でも
    // drag を必ずコミット / 解消するための window レベル保険。React 経路でコミット済みの
    // pointerup が bubble してきたときは dragRef が null なので二重コミットしない。
    function onWindowPointerUp(e: PointerEvent) {
      const cur = dragRef.current
      if (!cur) return
      commitDragSelection(e.clientX, e.clientY, cur)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerup', onWindowPointerUp)
    window.addEventListener('pointercancel', onWindowPointerUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerup', onWindowPointerUp)
      window.removeEventListener('pointercancel', onWindowPointerUp)
    }
  }, [setDragBoth, commitDragSelection])

  // ドラッグ中の line-snap インジケータ (GitHub PR 風)。
  // 仕様: カーソルが横切っている行の gutter 上 (= 普段 + ボタンが出る位置) に `+` をスナップ表示。
  // 自由追従ではなく「いま hover している行の gutter center」に「いつもの + ボタン」と同じ場所で
  // 出すことで「ドラッグして範囲選択中」のリアルタイム選択フィードバックになる。
  // 実装: pointermove で cursor 直下の cell-ln を elementFromPoint → その cell の rect で位置決定。
  const [dragIndicator, setDragIndicator] = useState<{ left: number; top: number } | null>(null)
  useEffect(() => {
    if (!drag) {
      setDragIndicator(null)
      document.body.classList.remove('is-dragging-line-range')
      return
    }
    // drag indicator は **drag 開始 side** にロックする。
    // 反対 side のパネルや空白領域 (summary / 中央コラム) にカーソルが移動しても、
    // X は開始 side のアンカーで固定、Y だけカーソルに追従して開始 side の行に snap する。
    // (resolveLineAtPoint と同じ side ロックポリシー: 範囲選択も開始 side 内で完結する)
    const sideAttr = sideToAttr(drag.side)
    const cellLns = Array.from(
      panelContainerRef.current?.querySelectorAll<HTMLElement>(`.cell-ln[data-side="${sideAttr}"]`) ?? []
    )
    // anchorX: drag 開始 side の最初の cell-ln から trigger ボタン中心を実測。
    // ハードコード (旧: lnRect.left + 9) だと button 幅変更で drag 中だけズレるため動的測定。
    // is-dragging-line-range クラス付与前に測ること: クラスが付くと trigger は display:none される。
    let anchorX = 0
    if (cellLns.length > 0) {
      const firstLn = cellLns[0]
      const lnRect = firstLn.getBoundingClientRect()
      let triggerCenterX = 9 // フォールバック (button 未マウントの極稀ケース)
      const sampleTrigger = firstLn.querySelector<HTMLElement>('.line-comment-trigger')
      if (sampleTrigger) {
        const tr = sampleTrigger.getBoundingClientRect()
        triggerCenterX = (tr.left - lnRect.left) + tr.width / 2
      }
      anchorX = lnRect.left + triggerCenterX
    }
    document.body.classList.add('is-dragging-line-range')
    function onMove(e: PointerEvent) {
      if (cellLns.length === 0) return
      // hot-path: anchorX 縦線上で elementsFromPoint。drag 開始 side の cell-ln 縦列に
      // 必ず当たるので画面上どこでカーソルがあっても Y で snap できる。
      // 高速 (stacked element 数 = せいぜい 5-10 個) で 99% のケースを捌く。
      let ln: HTMLElement | null = null
      const els = document.elementsFromPoint(anchorX, e.clientY)
      for (const el of els) {
        if (el instanceof HTMLElement && el.classList.contains('cell-ln') && el.dataset.side === sideAttr) {
          ln = el
          break
        }
      }
      // cold-path: 画面外 (Y が panel 上下端の外) や行間ギャップで miss したとき、
      // cell-ln 群を線形探索して cursor Y に最も近い行を選ぶ (panel 端で clamp する効果)。
      if (!ln) {
        let closest = cellLns[0]
        let closestDist = Infinity
        for (const candidate of cellLns) {
          const r = candidate.getBoundingClientRect()
          const center = r.top + r.height / 2
          const dist = Math.abs(e.clientY - center)
          if (dist < closestDist) {
            closestDist = dist
            closest = candidate
          }
        }
        ln = closest
      }
      const lnRect = ln.getBoundingClientRect()
      setDragIndicator({
        left: anchorX,
        top: lnRect.top + lnRect.height / 2,
      })
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.body.classList.remove('is-dragging-line-range')
    }
  }, [drag])

  function isInDragRange(side: Side, lineNumber: number | undefined): boolean {
    if (lineNumber == null) return false
    // drag 中: drag.startNumber..currentNumber を accent ハイライト
    if (drag && drag.side === side) {
      const lo = Math.min(drag.startNumber, drag.currentNumber)
      const hi = Math.max(drag.startNumber, drag.currentNumber)
      if (lineNumber >= lo && lineNumber <= hi) return true
    }
    // form open 中: activeForm が指す行も同じ accent ハイライトを継続。
    // ユーザー要望: textarea が表示されてる間は「どの行に対するコメントか」が視線で追えるよう、
    // 選択行 (単一行 or 範囲) の line-selected を維持する。
    if (handlers.activeForm) {
      const parsed = parseLineCommentKey(handlers.activeForm)
      if (parsed.panelId === panel.panelId && parsed.side === side) {
        const lo = Math.min(parsed.number, parsed.endNumber ?? parsed.number)
        const hi = Math.max(parsed.number, parsed.endNumber ?? parsed.number)
        if (lineNumber >= lo && lineNumber <= hi) return true
      }
    }
    return false
  }

  function handlePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    side: Side,
    lineNumber: number,
  ) {
    if (e.button !== 0) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
    setDragBoth({ side, startNumber: lineNumber, currentNumber: lineNumber })
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const cur = dragRef.current
    if (!cur) return
    const next = resolveLineAtPoint(e.clientX, e.clientY, cur.side)
    if (next == null || next === cur.currentNumber) return
    setDragBoth({ ...cur, currentNumber: next })
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const cur = dragRef.current
    if (!cur) return
    if (e.type === 'pointerup' && e.button > 0) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* noop */ }
    commitDragSelection(e.clientX, e.clientY, cur)
  }

  // panelId に紐付くコメント key を (side, anchor) で逆引き。
  // deps に threads (window.__reviewDiffThreads) を含めないのは意図的: thread の anchor 集合は
  // initialThreads の時点で確定しており、セッション中の返信は既存 anchor への append なので
  // Map の再計算は不要。返信本文の表示更新は「App の fileComments useMemo (deps: threads) の
  // 参照変化が Panel の memo を破る → render 時に最新の window mirror を読む」連鎖で届く
  // (App.tsx の mirror コメント参照)。途中の PanelBlock の memo も同じく fileComments prop の
  // 参照変化で破れるため、この連鎖は memo 境界を貫通して届く。
  const commentKeysByAnchor = useMemo(
    () => buildCommentKeysByAnchor(
      panel.panelId,
      handlers.lineComments.keys(),
      handlers.activeForm,
      typeof window !== 'undefined' ? window.__reviewDiffThreads : undefined,
    ),
    [handlers.lineComments, handlers.activeForm, panel.panelId],
  )

  return (
    <div
      className="font-mono text-xs bg-surface"
      data-panel-id={panel.panelId}
      ref={panelContainerRef}
    >
      <PanelHeader panel={panel} onCollapse={onCollapse} fileComments={fileComments} />
      {panel.sourcesUnavailable ? (
        <SourcesUnavailableBanner info={panel.sourcesUnavailable} />
      ) : null}
      {unified ? (
        <UnifiedBody
          panel={panel}
          highlight={highlight}
          commentKeysByAnchor={commentKeysByAnchor}
          handlers={handlers}
        />
      ) : (
        <SplitBody
          panel={panel}
          flat={flat}
          highlight={highlight}
          commentKeysByAnchor={commentKeysByAnchor}
          handlers={handlers}
          isInDragRange={isInDragRange}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      )}
      {/* ドラッグ中の line-snap インジケータ。`+` を hover 行の gutter 中央にスナップ表示し、
          普段の + ボタンと同じ場所で「いま範囲選択中の行」を視認化。
          perf-fix: panel-block に content-visibility: auto を当てたことで暗黙的に
          contain: paint が効き、position: fixed の containing block が panel-block に redirect されて
          中心に固定されるデグレが発生していた。createPortal で document.body 直下に逃がして
          viewport 座標で動く本来の挙動に戻す。 */}
      {/* 寸法 / box-shadow / radius / opacity は hover 時の .line-comment-trigger と完全に揃える。
          幅高は w-4/h-4 (= 1rem)。px で書くと body font-size に応じて rem 側が縮んで両者の実サイズが
          ズレるため、rem 統一でユーザー font-size 拡大にも追従させる。 */}
      {dragIndicator
        ? createPortal(
            <div
              className="fixed -translate-x-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center bg-accent text-white rounded-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.35)] opacity-85 pointer-events-none z-[9999] select-none"
              aria-hidden="true"
              style={{ left: dragIndicator.left, top: dragIndicator.top }}
            >
              <Plus className="w-3 h-3" strokeWidth={3} aria-hidden="true" />
            </div>,
            document.body,
          )
        : null}
    </div>
  )
})

type RowHandlerProps = {
  isInDragRange: (side: Side, lineNumber: number | undefined) => boolean
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, side: Side, lineNumber: number) => void
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
}

type BodyProps = {
  panel: RenderedPanel
  // chunkIdx 付きで Panel から受け取る。↑↓ ジャンプの anchor として code-row に data-chunk-idx を撒く。
  flat: FlatRow[]
  highlight: boolean
  commentKeysByAnchor: Map<string, string[]>
  handlers: LineCommentHandlers
} & RowHandlerProps

// split mode body: 親 grid を 2 列に分け、各列を独立 overflow-x:auto コンテナにする。
// 各 side 内では「コードセル + その下に該当 side のコメントスレッド」を縦に積む。
// asIs コメントは左 side、toBe コメントは右 side に出る (構造上左右に紐づくので自然)。
function SplitBody({
  panel, flat, highlight, commentKeysByAnchor, handlers, ...rowProps
}: BodyProps) {
  return (
    // panel-body-split: split mode の親 2 列 grid。border-soft 色 + gap: 1px で列境界を表現。
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] bg-border-soft gap-px">
      {/*
        panel-side BEM 維持: drag-select.test.tsx が `querySelector('.cell-ln[data-side=...]')` で
        参照する側ラベル + per-side ::-webkit-scrollbar カスタム + asis/tobe scoped の line-comment-trigger
        点灯 rule + Panel.tsx 自身が `querySelector('.panel-side-asis .code-row')` で row 取得する
        contract。utility 化不可。
      */}
      <div className="panel-side panel-side-asis" data-side-container="asis">
        {/* panel-side-inner も BEM 維持: width: max-content + min-width: 100% の uniform-width row 要件 +
            sticky cell-ln の containing block が壊れない構造前提。 */}
        <div className="panel-side-inner">
          {flat.map(({ row, segmentIndex, rowIndex, isFirstOfSegment, chunkIdx }) => (
            <SideRow
              key={`asis-${segmentIndex}-${rowIndex}`}
              side="asIs"
              row={row}
              panel={panel}
              highlight={highlight}
              isFirstOfSegment={isFirstOfSegment}
              chunkIdx={chunkIdx}
              commentKeysByAnchor={commentKeysByAnchor}
              handlers={handlers}
              {...rowProps}
            />
          ))}
        </div>
      </div>
      <div className="panel-side panel-side-tobe" data-side-container="tobe">
        <div className="panel-side-inner">
          {flat.map(({ row, segmentIndex, rowIndex, isFirstOfSegment, chunkIdx }) => (
            <SideRow
              key={`tobe-${segmentIndex}-${rowIndex}`}
              side="toBe"
              row={row}
              panel={panel}
              highlight={highlight}
              isFirstOfSegment={isFirstOfSegment}
              chunkIdx={chunkIdx}
              commentKeysByAnchor={commentKeysByAnchor}
              handlers={handlers}
              {...rowProps}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// split mode 内の 1 side 1 行 + (その side の) コメント。
// 行高同期 (ResizeObserver) のために .code-row class を必ず付ける。
// chunkIdx: -1 なら context、>=0 なら chunk 内 row。code-row に data-chunk-idx として出して
// PanelHeader の prev/next ボタン + ↑↓ キーが querySelector で参照する anchor になる。
function SideRow({
  side, row, panel, highlight, isFirstOfSegment, chunkIdx,
  commentKeysByAnchor, handlers,
  isInDragRange, onPointerDown, onPointerMove, onPointerUp,
}: {
  side: Side
  row: SideBySideRow
  panel: RenderedPanel
  highlight: boolean
  isFirstOfSegment: boolean
  chunkIdx: number
  commentKeysByAnchor: Map<string, string[]>
  handlers: LineCommentHandlers
} & RowHandlerProps) {
  const lang = side === 'asIs' ? (panel.asIsLanguage ?? 'plaintext') : (panel.toBeLanguage ?? 'plaintext')
  const cell = side === 'asIs' ? row.asIs : row.toBe
  // 同一 SideBySideRow に deletion と addition が同居している行だけが intra-line diff の対象
  // (ブロック内位置対応ペア)。相手側が empty の余り行・context 行は対象外。
  const pairRaw =
    side === 'asIs'
      ? (cell.type === 'deletion' && row.toBe.type === 'addition' ? row.toBe.raw : undefined)
      : (cell.type === 'addition' && row.asIs.type === 'deletion' ? row.asIs.raw : undefined)
  // deps に pairRaw を含める: 自分の raw が同じでも相手側が変われば変更文字範囲は変わるため
  const html = useMemo(() => {
    if (!highlight) return escapeHtml(cell.raw)
    const decorations =
      pairRaw != null
        ? side === 'asIs'
          ? intraLineDecorations(cell.raw, pairRaw, 'del')
          : intraLineDecorations(pairRaw, cell.raw, 'add')
        : undefined
    return highlightCode(cell.raw, lang, decorations)
  }, [highlight, cell.raw, lang, pairRaw, side])

  const anchorKeys = cell.line != null
    ? (commentKeysByAnchor.get(anchorMapKey(side, cell.line)) ?? [])
    : []

  const inRange = isInDragRange(side, cell.line)
  const selectedClass = inRange ? ' line-selected' : ''
  const sideClass = side === 'asIs' ? 'asis' : 'tobe'

  function gutterPointerProps(lineNumber: number | undefined) {
    if (lineNumber == null) return {}
    return {
      'data-side': sideToAttr(side),
      'data-line-number': String(lineNumber),
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) =>
        onPointerDown(e, side, lineNumber),
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    }
  }
  function codeDataAttrs(lineNumber: number | undefined) {
    if (lineNumber == null) return {}
    return {
      'data-side': sideToAttr(side),
      'data-line-number': String(lineNumber),
    }
  }

  return (
    <>
      {isFirstOfSegment ? (
        <div className="h-0 border-t border-dashed border-border-soft my-1" aria-hidden="true" />
      ) : null}
      {/*
        以下の BEM は全て維持必須:
          - code-row / code-row-${sideClass} / code-row-${type} / line-selected
              → drag-select.test.tsx の closest('.code-row') と toHaveClass('line-selected') 依存 +
                addition/deletion/empty の row bg 動的合成 (globals.css の @layer components)
          - cell-ln / cell-ln-${sideClass} / cell-ln-${type}
              → test の querySelector('.cell-ln[data-side=...]') 依存 + sticky gutter + add/del 色合成
          - cell-code / cell-code-${sideClass} / cell-code-${type}
              → test の querySelector('.cell-code[data-side=...]') 依存 + Shiki pre 透過化セレクタ
        変更時はテストが落ちる + 動的合成が壊れるため、ここは BEM 文字列を直接編集してはならない。
      */}
      <div
        className={`code-row code-row-${sideClass} code-row-${cell.type}${selectedClass}`}
        {...(chunkIdx >= 0 ? { 'data-chunk-idx': String(chunkIdx) } : {})}
      >
        <div
          className={`cell-ln cell-ln-${sideClass} cell-ln-${cell.type}`}
          {...gutterPointerProps(cell.line)}
        >
          {cell.line ?? ''}
          {cell.line != null ? (
            <LineTrigger
              panelId={panel.panelId}
              side={side}
              lineNumber={cell.line}
              onOpenLineForm={handlers.onOpenLineForm}
            />
          ) : null}
          {/* v5: editor link trigger. toBe + addition 行のみ表示。
              editorAvailable は window 経由 (CR-3: command 自体は server 側のみ)。
              hover 時に gutter 右端に lucide-react の SquareArrowOutUpRight アイコンが
              fade-in する (CSS は globals.css 側に置く: Tailwind v4 cascade で opacity utility が
              :hover ルールに勝ってしまうため tsx 側に opacity-* を書かない)。 */}
          {cell.line != null && side === 'toBe' && cell.type === 'addition'
            && getEditorTarget(panel, side)
            && (typeof window !== 'undefined' && window.__reviewDiffEditorAvailable) ? (
              <EditorLinkTrigger
                file={getEditorTarget(panel, side) as string}
                line={cell.line}
              />
          ) : null}
        </div>
        <div
          className={`cell-code cell-code-${sideClass} cell-code-${cell.type}`}
          {...codeDataAttrs(cell.line)}
        >
          <pre dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
      {anchorKeys.length > 0
        ? sortAnchorKeys(anchorKeys).map((key) => (
            <CommentRow
              key={key}
              lineKey={key}
              panel={panel}
              handlers={handlers}
            />
          ))
        : null}
    </>
  )
}

// v5: panel から開く対象ファイル名を解決する。toBe 側は panel.toBe.file、asIs 側は panel.asIs.file。
function getEditorTarget(panel: RenderedPanel, side: Side): string | null {
  if (side === 'toBe') return panel.toBe?.file ?? null
  return panel.asIs?.file ?? null
}

// EditorLinkTrigger: 行右隣の余白に hover で出るリンクアイコン。click で:
//   1. clipboard に `file:line` をコピー (フォールバック保証)
//   2. POST /editor-open で server 経由で deep-link 起動 (editor preset 必須)
//   3. Toast 表示 (window.__reviewDiffShowToast)
//
// 配置: 行番号と重ならないよう、cell-ln の **外側右** (right-[-18px]) に押し出し、code 行の左頭に被せる。
// クリック競合対策: pointerdown/pointerup を stopPropagation して、gutter の drag-select / line-form
// 開始イベントに到達させない (= クリックでコメントフォームが開く問題の修正)。
// hover/focus-visible の opacity / transition は globals.css 側に書く (Tailwind v4 cascade 制約)。
function EditorLinkTrigger({ file, line }: { file: string; line: number }) {
  async function onClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    const fileLine = `${file}:${line}`
    const toast = typeof window !== 'undefined' ? window.__reviewDiffShowToast : undefined
    // W-3 fix: clipboard 成否で Toast 文面を変える (失敗時に "Copied" を出すと虚偽通知になる)
    let copied = false
    try {
      await navigator.clipboard.writeText(fileLine)
      copied = true
    } catch {
      /* clipboard 拒否時 (https 必須 / permission policy 等) は copied=false のまま */
    }
    toast?.(copied ? `Copied ${fileLine}` : `Opening ${fileLine}`)
    try {
      await fetch(`/editor-open?token=${encodeURIComponent(getToken())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file, line }),
      })
    } catch {
      /* server が落ちていたり editor preset 未設定でも、clipboard コピーで人間が手動 cd できる */
    }
  }
  // pointerdown/up: gutter pointerProps の drag-select 開始ハンドラに到達させない。
  function stop(e: React.PointerEvent<HTMLButtonElement>) {
    e.stopPropagation()
  }
  return (
    <button
      type="button"
      className="editor-link-trigger absolute right-[-18px] top-1/2 -translate-y-1/2 w-4 h-4 p-0 inline-flex items-center justify-center border-0 rounded-[4px] bg-surface text-text cursor-pointer z-[3] shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
      aria-label="Open file in editor"
      title="Open in editor (copies file:line to clipboard)"
      tabIndex={0}
      onPointerDown={stop}
      onPointerUp={stop}
      onClick={onClick}
    >
      <SquareArrowOutUpRight className="w-3 h-3" strokeWidth={2.5} aria-hidden="true" />
    </button>
  )
}

function LineTrigger({
  panelId, side, lineNumber, onOpenLineForm,
}: {
  panelId: string
  side: Side
  lineNumber: number
  onOpenLineForm: LineCommentHandlers['onOpenLineForm']
}) {
  // line-comment-trigger BEM 維持: row hover scoped selector (panel-side-asis .code-row:hover .cell-ln-asis
  // .line-comment-trigger { opacity }) と body.is-dragging-line-range で display:none させる JS contract +
  // hover/focus-visible 状態の transform: scale 効果が globals.css に集約されているため。
  // 静的見た目 (絶対位置 / 形状) は utility で表現。
  //
  // opacity / transition は utility に書かない: Tailwind v4 cascade で utilities が components より
  // 優先されるため、utility に opacity-0 を書くと globals.css 側の :hover { opacity: 0.85 } が常に負ける
  // (= ホバーしても + が出ないバグ)。base opacity:0 と transition は globals.css の .line-comment-trigger
  // に書いてあるので、ここでは形だけ utility で済ませる。
  return (
    <button
      type="button"
      className="line-comment-trigger absolute left-0.5 top-1/2 -translate-y-1/2 w-4 h-4 p-0 inline-flex items-center justify-center border-0 rounded-[4px] bg-accent text-white cursor-pointer z-[2] shadow-[0_1px_3px_rgba(0,0,0,0.35)]"
      aria-label="Add comment to this line"
      title="Add comment / drag to select range"
      onClick={(e) => {
        // キーボード Enter のみ form を開く (マウスは pointerdown/up 経由)
        if (e.detail === 0) onOpenLineForm(panelId, { side, number: lineNumber })
      }}
    >
      <Plus className="w-3 h-3" strokeWidth={3} aria-hidden="true" />
    </button>
  )
}

// I-4: panel source unavailable のバナー。kind に応じて文言を変える。
function SourcesUnavailableBanner({ info }: { info: NonNullable<RenderedPanel['sourcesUnavailable']> }) {
  const text = info.kind === 'pr-fetch-failed'
    ? 'Source unavailable: PR base/head fetch failed (gh CLI auth or PR closed?).'
    : 'Source unavailable: panel file not found in working tree (AI may have mis-typed the file path in summary.json).'
  const sides: string[] = []
  if (info.asIs) sides.push('asIs')
  if (info.toBe) sides.push('toBe')
  const detail = sides.length > 0 ? ` Affected side: ${sides.join(' + ')}.` : ''
  return (
    // sources-unavailable-banner BEM 維持: [data-kind="unknown-file"] の attribute selector で色切替する rule が
    // globals.css にあるため。base 色 (赤系) のみ utility で表現し、yellow への切替は selector に任せる。
    <div
      className="sources-unavailable-banner flex items-center gap-2.5 px-3.5 py-2.5 bg-[rgba(248,113,113,0.08)] border-b border-[rgba(248,113,113,0.25)] text-text text-xs leading-[1.5]"
      role="status"
      data-kind={info.kind}
    >
      <span className="text-sm shrink-0" aria-hidden="true">⚠</span>
      <span className="text-text-muted">{text}{detail}</span>
    </div>
  )
}

