// side-by-side の diff テーブル。
// rows[].left.raw / right.raw は git diff からの生コード文字列。
// 表示時にこのコンポーネントで Shiki に通して <span> 列にハイライトする。
// 入力は信頼できる (CLI 側で生成された git diff の中身) ので XSS 経路にはならない。
//
// 行番号セルにも row type のクラスを付けて、addition / deletion の背景色を gutter まで
// 続けるのが Linear / GitHub の見せ方。コード側だけ色を付けると視線が切れる。
//
// hunks + 「⇕ N unchanged lines」バナー:
//   visibleHunks は表示対象の Hunk[] (FileBlock 側でフィルタ済み)。
//   隣接 hunk 間で oldStart/newStart のギャップを計算し、その分だけ unchanged 行があったと
//   みなしてバナーを挟む。expandable=true (staged モード) のときはクリックで /source を fetch、
//   text/plain を行分割して context 行として該当 tbody に挿入する。
//   PR モードでは fallback で「Expand unavailable in PR mode」と表示しクリック不可。
//
// 行コメント (Linear / GitHub PR スタイル):
//   - 各 <tr.code-row> を hover すると gutter セル右側に「+」ボタンが薄く出る
//   - 単一行コメント: 「+」クリック / コード列の単純クリック (pointerdown==pointerup 同一行) で
//     activeForm を立ち上げ、その行の直下に <tr.comment-row> を挿入
//   - 範囲コメント: コード列で行をまたぐドラッグ (pointerdown → pointerup を別行) で範囲を確定し、
//     endNumber の行の直下に <tr.comment-row> を挿入。フォーム/バブルのヘッダに「行 N-M」と表示
//   - 保存済みコメントは同じ comment-row の中に吹き出しブロックとして積み上がる
//   - hover で各 bubble に「編集」「削除」ボタンが出る
//   - textarea で Cmd/Ctrl+Enter = 保存、Escape = キャンセル / ドラッグ中の Escape で選択解除
//   - side 判定: right に line 番号があれば right、無ければ left (deletion 行)。
//     context 行 (両側に番号あり) は右側で扱う = after ファイルの行番号で記録する。
//   - ドラッグ中に side をまたいだ場合: 開始 side のみ追従。反対側は無視 (UX をシンプルに保つ)。
//
// ドラッグ実装 (Pointer Events ベース):
//   - 旧実装は td.code 単位の onMouseEnter で範囲を伸ばしていたが、押下中の mouseenter は
//     React で取りこぼされやすく「ぐいーっとした選択感」が出なかった。
//   - 改善: onPointerDown → setPointerCapture(pointerId) で pointer をキャプチャし、
//     以降の onPointerMove は currentTarget (= 開始 td) で受ける。move 中は
//     document.elementFromPoint(clientX, clientY) でカーソル直下要素を取り、
//     その祖先 <tr data-line-number data-side> を読んで対象行を決定する。
//     これにより:
//       * セル境界・comment-row・「+」ボタンを跨いでも取りこぼし無し
//       * カーソルが diff の外に出ても pointer capture でイベント継続
//       * 1 frame 単位で追従するので「ぬるっと」した感触になる

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Hunk, ParsedFile, SideBySideRow } from '@zeus/review-diff-shared'
import { parseLineCommentKey } from './state.ts'
import type { LineCommentHandlers } from './useLineComments.ts'
import { createShiki } from './shiki-bundle.ts'

// なぜ Shiki シングルトン:
//   createHighlighterCoreSync は 13 言語 + 1 theme をロードして数 MB の正規表現を保持する。
//   ファイル/行ごとに作り直すと初期描画が破綻する。モジュール評価時に 1 回だけ生成して使い回す。
const SHIKI = createShiki()

// なぜ pre ではなく code 内のみを返すか:
//   Shiki は <pre><code>…</code></pre> で包むが、テーブルセルでは外側の pre は不要。
//   <pre> は呼び出し側 (DiffTable) で 1 つだけ用意する想定で、span 列だけを抜き出す。
function highlightCode(raw: string, lang: string): string {
  try {
    const html = SHIKI.codeToHtml(raw, { lang, theme: 'github-dark' })
    const m = html.match(/<code[^>]*>([\s\S]*?)<\/code>/)
    return (m ? m[1] : escapeHtml(raw)).replace(/\n$/, '')
  } catch {
    return escapeHtml(raw)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

type Props = {
  file: ParsedFile
  visibleHunks: Hunk[]
  expandable: boolean
  token: string
  // viewport 付近にあるかを示すフラグ。
  //   true  → 既存通り Shiki で highlight した HTML を <pre> に流す
  //   false → escapeHtml した raw を <pre> に流す (Shiki を呼ばないことで初回マウントを軽くする)
  // 省略時は true (既存挙動 / 既存テスト互換)。
  highlight?: boolean
} & LineCommentHandlers

// ドラッグ範囲選択の途中状態。
//   side: 開始 side。move 中も開始 side で固定 (反対側は無視) — テキスト選択ライクの単純さ重視。
//   startNumber: pointerdown された行番号
//   currentNumber: 現在カーソル下の行番号 (同じ side のみ)
//   startedAt: pointerdown のタイムスタンプ。同一行 + 短時間離した場合に単一クリックとして扱うため。
type DragState = {
  side: 'left' | 'right'
  startNumber: number
  currentNumber: number
  startedAt: number
} | null

// 単一クリック判定の閾値 (ms)。pointerdown→pointerup が同じ行 & この時間内なら単一行扱い。
// 200ms より長くなったら「ゆっくりドラッグした」とみなして範囲扱い (= 同じ行を range として確定)。
const CLICK_THRESHOLD_MS = 200

// React.memo で props 浅比較。FileBlock の他 state (collapsed) や上位の軽微な再 render で
// 数千行の DiffTable を毎回 reconcile し直すのを避ける。
// 注意: handlers (lineCommentHandlers) は useLineComments の useMemo で安定化済み、
// visibleHunks は FileBlock の useMemo で安定化済み。これらが破られると memo は効かない。
export const DiffTable = memo(function DiffTable({
  file,
  visibleHunks,
  expandable,
  token,
  highlight = true,
  ...handlers
}: Props) {
  const [drag, setDrag] = useState<DragState>(null)
  // ドラッグ中に「縦方向のみ」マウスに追従する "+" インジケータ。
  // GitHub PR の挙動を模倣: 横は gutter (drag 開始 td の rect.left) に固定し、
  // 縦だけがマウス y に合わせて滑らかにスライドする = ユーザーは「自分が今どの行に
  // 何をしている最中か」を視覚で追える。横追従だと「アイコンが画面上を浮遊する」だけになり
  // 行コメント機能としての文脈が伝わらない。
  // パフォーマンス上、毎フレーム React で再 render しないよう ref + DOM 直接更新で位置を制御する。
  const dragIndicatorRef = useRef<HTMLDivElement>(null)
  // ドラッグ開始時に固定する gutter の x 座標 (viewport 基準)。pointerdown で計算 → pointermove では使い回す。
  const dragGutterXRef = useRef<number>(0)
  // DiffTable は file ごとにマウントされる。data-line-number は file 内で 1 から始まるため、
  // document 全体での querySelector は別 file の同じ行番号にヒットする (= インジケータが
  // 別 file のページ上部に飛ぶ症状の原因)。tableRef でこの DiffTable 自身の <table> に
  // querySelector / closest をスコープして、cross-file の誤マッチを構造的に防ぐ。
  const tableRef = useRef<HTMLTableElement>(null)
  // setState は非同期で、pointermove のフレーム毎ロジック (差分判定) で最新値を読みたいので
  // ref も併用する。React 19 のバッチング下でも ref 経由なら同期的に取れる。
  const dragRef = useRef<DragState>(null)
  const setDragBoth = useCallback((next: DragState) => {
    dragRef.current = next
    setDrag(next)
  }, [])

  // ドラッグ中 Escape でキャンセル + window pointerup 保険 (dragRef-aware)。
  //
  // なぜ window pointerup 保険が必要か (zeus-debug v2 確信度 78):
  //   60 ファイル × 7931 行の重 reconciliation 中、pointermove の setState で全 Row が
  //   同期再 render され、その隙間で setPointerCapture した td が `lostpointercapture` 経由で
  //   capture を失う。結果 pointerup は capture 要素ではなく「カーソル直下の別 td or 非 td 要素」で
  //   発火し、td.code に attach した React onPointerUp に届かず handlePointerUp 自体が呼ばれない。
  //
  // 過去の事故と何が違うか:
  //   旧実装は dragRef を読まずに setDragBoth(null) を先打ちしていたため、後続の React onPointerUp で
  //   dragRef.current が null になって onOpenLineForm が呼ばれず「範囲コメントが動かない」を生んだ。
  //   今回は `if (!cur) return` の dragRef-aware にし、capture 取りこぼし時にこの window 保険が
  //   handlePointerUp 等価の処理 (onOpenLineForm + setDragBoth(null)) を完走させる。
  //   pointer capture が機能した正常パスでは React onPointerUp が先に setDragBoth(null) 済みなので
  //   この保険は何もしない (cur が既に null)。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setDragBoth(null)
        hideIndicator()
      }
    }
    function onWindowPointerUp(e: PointerEvent) {
      const cur = dragRef.current
      if (!cur) return
      console.log('[drag] window', e.type, 'FALLBACK (React onPointerUp did not fire)', { x: e.clientX | 0, y: e.clientY | 0, hitTag: (e.target as HTMLElement)?.tagName, filePath: file.path })
      const endNumber = resolveLineAtPoint(e.clientX, e.clientY, cur.side) ?? cur.currentNumber
      const lo = Math.min(cur.startNumber, endNumber)
      const hi = Math.max(cur.startNumber, endNumber)
      const elapsed = performance.now() - cur.startedAt
      const isSingle = lo === hi && elapsed < CLICK_THRESHOLD_MS
      console.log('[drag] window fallback opening form', { lo, hi, elapsed: elapsed | 0, isSingle, side: cur.side })
      if (isSingle || lo === hi) {
        handlers.onOpenLineForm(file.path, { side: cur.side, number: lo })
      } else {
        handlers.onOpenLineForm(file.path, { side: cur.side, number: lo, endNumber: hi })
      }
      setDragBoth(null)
      hideIndicator()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerup', onWindowPointerUp)
    window.addEventListener('pointercancel', onWindowPointerUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerup', onWindowPointerUp)
      window.removeEventListener('pointercancel', onWindowPointerUp)
    }
  }, [setDragBoth, handlers, file.path])

  // 範囲選択ハイライト判定: drag 中、ある (side, lineNumber) が選択範囲に入っているか。
  function isInDragRange(side: 'left' | 'right', lineNumber: number | undefined): boolean {
    if (!drag || lineNumber == null) return false
    if (drag.side !== side) return false
    const lo = Math.min(drag.startNumber, drag.currentNumber)
    const hi = Math.max(drag.startNumber, drag.currentNumber)
    return lineNumber >= lo && lineNumber <= hi
  }

  // カーソル位置から「対象行」を逆引きする。
  // 戻り値の side / number は、開始 side と一致するもののみ採用する (反対側に行ったら null)。
  // <tr data-side data-line-number> を <tr.code-row> に付けてあるので、closest('tr[data-side]') で拾える。
  function resolveLineAtPoint(
    clientX: number,
    clientY: number,
    expectSide: 'left' | 'right',
  ): number | null {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null
    if (!el) return null
    // td.code と td.ln の両方に data-side / data-line-number を attach しているので
    // どちらが直下にあっても拾える。closest('td[data-side]') で gutter / code 両方ヒット。
    const cell = el.closest('td[data-side]') as HTMLElement | null
    if (!cell) return null
    // 自分の DiffTable 内のセルでなければ「範囲外」扱い (別 file / banner / 空白上を
    // 通過したケース): null を返すと handlePointerMove 側で「直前の選択を維持」になり
    // インジケータも前回位置に留まる。
    if (tableRef.current && !tableRef.current.contains(cell)) return null
    const side = cell.dataset.side as 'left' | 'right' | undefined
    const num = cell.dataset.lineNumber
    if (!side || side !== expectSide || !num) return null
    const n = Number(num)
    if (!Number.isFinite(n)) return null
    return n
  }

  // pointerdown: ドラッグ開始。capture を取って、以降の move/up を currentTarget で受ける。
  function handlePointerDown(
    e: React.PointerEvent<HTMLTableCellElement>,
    side: 'left' | 'right',
    lineNumber: number,
  ) {
    console.log('[drag] pointerdown', { side, lineNumber, button: e.button, pointerId: e.pointerId, target: (e.target as HTMLElement).tagName, currentTarget: e.currentTarget.tagName, filePath: file.path })
    // 左クリック (主ボタン) のみ。タッチ / ペンも button===0 で来る。
    if (e.button !== 0) {
      console.log('[drag] pointerdown REJECTED: button !== 0', e.button)
      return
    }
    // テキスト選択開始を抑止。pointerdown 段階で preventDefault しないと selection が走る。
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
      console.log('[drag] setPointerCapture OK')
    } catch (err) {
      console.log('[drag] setPointerCapture FAILED', err)
    }
    setDragBoth({
      side,
      startNumber: lineNumber,
      currentNumber: lineNumber,
      startedAt: performance.now(),
    })
    // 開始 td の rect.left を gutter 固定 x として保存。
    // 通常の + ボタン位置 (styles.css で left: 2px; width: 14px → 中心 = td.ln.left + 9) と
    // 揃えるため、td 左端から +9px を indicator 中心 x とする。
    // CSS の transform: translate(-50%, -50%) で left/top をそれぞれ中心点として配置する。
    const startRect = e.currentTarget.getBoundingClientRect()
    dragGutterXRef.current = startRect.left + 9
    snapIndicatorToLine(side, lineNumber)
  }

  // インジケータを「指定 side / 行番号の td」の中央にスナップ。
  // GitHub PR の挙動: + ボタンが行から行へ「カクッ」と飛ぶ。連続的に動くスムーズな追従より
  // 「今この行が選択範囲の端」が一目で分かる方が UX として強い。
  function snapIndicatorToLine(side: 'left' | 'right', lineNumber: number) {
    const el = dragIndicatorRef.current
    if (!el) return
    // この DiffTable の <table> 内だけを検索する (cross-file の誤マッチ防止)。
    const cell = tableRef.current?.querySelector(
      `td[data-side="${side}"][data-line-number="${lineNumber}"]`
    ) as HTMLElement | null
    if (!cell) return
    const r = cell.getBoundingClientRect()
    el.style.display = 'flex'
    el.style.left = `${dragGutterXRef.current}px`
    el.style.top = `${r.top + r.height / 2}px`
    // ドラッグ中は通常の + ボタンを消す (CSS .is-dragging .line-comment-trigger { display: none })。
    // body に class を立てるのは React state を経由しない DOM 直接操作 — drag 中の表示制御を
    // viewport 全 file に一括反映でき、re-render コストもゼロ。
    document.body.classList.add('is-dragging-line-range')
  }

  function hideIndicator() {
    const el = dragIndicatorRef.current
    if (el) el.style.display = 'none'
    document.body.classList.remove('is-dragging-line-range')
  }

  function handlePointerMove(e: React.PointerEvent<HTMLTableCellElement>) {
    const cur = dragRef.current
    if (!cur) return
    const next = resolveLineAtPoint(e.clientX, e.clientY, cur.side)
    if (next == null) return
    if (next === cur.currentNumber) return
    // 行が変わったので、インジケータを新しい行の中央 y にスナップ (連続追従ではなくカクッと飛ぶ)
    snapIndicatorToLine(cur.side, next)
    setDragBoth({ ...cur, currentNumber: next })
  }

  function handlePointerUp(e: React.PointerEvent<HTMLTableCellElement>) {
    console.log('[drag] React onPointerUp triggered', { type: e.type, button: e.button, hasCur: dragRef.current !== null })
    const cur = dragRef.current
    if (!cur) {
      console.log('[drag] pointerup REJECTED: no drag in progress (cur=null)')
      return
    }
    // Safari (WebKit) は pointerup の e.button に -1 を返す仕様があり、Chrome の 0 と互換性が無い。
    // pointercancel も button を見ず通したいので、明示的に「>0 (右クリックや中クリック離した時)」のみ拒否。
    if (e.type === 'pointerup' && e.button > 0) {
      console.log('[drag] pointerup REJECTED: button > 0', e.button)
      return
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // 既に release 済みでも特に問題ない
    }
    // pointer 直下の行を最終確定値とする (cur.currentNumber は move 中に追従済みなので通常同じ)。
    const endNumber = resolveLineAtPoint(e.clientX, e.clientY, cur.side) ?? cur.currentNumber
    const lo = Math.min(cur.startNumber, endNumber)
    const hi = Math.max(cur.startNumber, endNumber)
    const elapsed = performance.now() - cur.startedAt
    const isSingle = lo === hi && elapsed < CLICK_THRESHOLD_MS
    console.log('[drag] pointerup OK', { lo, hi, elapsed: elapsed | 0, isSingle, side: cur.side, filePath: file.path })
    if (isSingle || lo === hi) {
      handlers.onOpenLineForm(file.path, { side: cur.side, number: lo })
    } else {
      handlers.onOpenLineForm(file.path, { side: cur.side, number: lo, endNumber: hi })
    }
    setDragBoth(null)
    hideIndicator()
  }

  // この file に紐付くコメント key を行番号で逆引きするマップ。
  // ある (side, lineNumber) で「この行の直下に展開すべき comment thread」(複数あり得る) を
  // 即座に取得できるよう、key 単位で endNumber || number と side をキーにグルーピング。
  // 範囲コメントは endNumber 行の下に展開する。
  const commentKeysByAnchor = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const key of handlers.lineComments.keys()) {
      const parsed = parseLineCommentKey(key)
      if (parsed.file !== file.path) continue
      const anchor = parsed.endNumber ?? parsed.number
      const mapKey = `${parsed.side}\x1f${anchor}`
      const arr = map.get(mapKey) ?? []
      arr.push(key)
      map.set(mapKey, arr)
    }
    // activeForm が今この file のものなら、それも anchor に追加。
    if (handlers.activeForm) {
      const parsed = parseLineCommentKey(handlers.activeForm)
      if (parsed.file === file.path) {
        const anchor = parsed.endNumber ?? parsed.number
        const mapKey = `${parsed.side}\x1f${anchor}`
        const arr = map.get(mapKey) ?? []
        if (!arr.includes(handlers.activeForm)) arr.push(handlers.activeForm)
        map.set(mapKey, arr)
      }
    }
    return map
  }, [handlers.lineComments, handlers.activeForm, file.path])

  if (file.status === 'binary') {
    return <div className="binary-notice">Binary file (preview not available)</div>
  }
  if (visibleHunks.length === 0) {
    return <div className="binary-notice">No hunks to display.</div>
  }
  return (
    <>
      {/* ドラッグ中のカーソル追従インジケータ。position: fixed で table の外に出すことで、
          horizontal scroll / sticky header の影響を受けず viewport 座標で位置を決められる。
          初期は display: none、handlePointerDown で表示 + 位置設定、handlePointerMove で
          位置更新、handlePointerUp / Escape で非表示。React state を経由しないため
          毎フレームの再 render コストはゼロ。 */}
      <div ref={dragIndicatorRef} className="drag-cursor-indicator" style={{ display: 'none' }} aria-hidden>+</div>
      {/* 新規ファイル (file.status === 'added') のときだけ左カラム (旧コード) を畳む。
          「既存ファイルへの追加だけ」(deletions === 0 だが context 行は存在する) は
          左カラムを残さないと context が消えて差分が読めなくなるため畳まない。
          削除だけのファイル (status === 'deleted') は逆に右が空になるが、視覚的な空白として
          そのまま残す (削除確認の文脈で意味があるため畳まない方が安全)。 */}
      <table
        ref={tableRef}
        className="diff-table"
        data-no-left={file.status === 'added' ? 'true' : undefined}
      >
        {/* gutter (行番号セル) は 52px 固定、code 列は均等 (calc((100% - 104px) / 2))。
            短い行が並ぶときは container 幅で左右が等分。長い行があるときは
            .diff-table の min-width: max-content と .file-block の overflow-x: auto で
            パネル全体が横スクロールする (行単位ではなく)。 */}
        <colgroup>
          <col style={{ width: 52 }} />
          <col style={{ width: 'calc((100% - 104px) / 2)' }} />
          <col style={{ width: 52 }} />
          <col style={{ width: 'calc((100% - 104px) / 2)' }} />
        </colgroup>
      {visibleHunks.map((h, i) => {
        const prev = i > 0 ? visibleHunks[i - 1] : null
        // 直前の hunk が無ければ「ファイル先頭 〜 この hunk の開始まで」、
        // あれば「直前 hunk の末尾 〜 この hunk の開始まで」を unchanged 範囲とする。
        // newStart 側の数値を使う (after ファイルに対する fetch を想定)。
        const gapStartAfter = prev ? prev.newStart + prev.newLines : 1
        const gapEndAfter = h.newStart - 1
        const gapStartBefore = prev ? prev.oldStart + prev.oldLines : 1
        const gapEndBefore = h.oldStart - 1
        const gapLines = Math.max(0, gapEndAfter - gapStartAfter + 1)
        return (
          <HunkBody
            key={h.index}
            hunk={h}
            file={file}
            highlight={highlight}
            // gapLines が 0 のときはバナーを出さない (隣接 hunk が連続している場合)。
            banner={
              gapLines > 0
                ? {
                    lines: gapLines,
                    startAfter: gapStartAfter,
                    endAfter: gapEndAfter,
                    startBefore: gapStartBefore,
                    endBefore: gapEndBefore,
                  }
                : null
            }
            expandable={expandable}
            token={token}
            handlers={handlers}
            commentKeysByAnchor={commentKeysByAnchor}
            isInDragRange={isInDragRange}
            onLinePointerDown={handlePointerDown}
            onLinePointerMove={handlePointerMove}
            onLinePointerUp={handlePointerUp}
          />
        )
      })}
      {/* 最後の hunk の後 〜 ファイル末尾までの unchanged 範囲。
          afterTotal は CLI 側で sources から計算した「after ファイルの総行数」。
          無い (= 取得失敗 / 削除ファイル) ときはバナーを省略する。 */}
      {(() => {
        if (visibleHunks.length === 0) return null
        const last = visibleHunks[visibleHunks.length - 1]
        const afterTotal = file.afterTotal
        if (afterTotal == null) return null
        const startAfter = last.newStart + last.newLines
        const endAfter = afterTotal
        const lines = Math.max(0, endAfter - startAfter + 1)
        if (lines === 0) return null
        const startBefore = last.oldStart + last.oldLines
        const endBefore = startBefore + lines - 1
        return (
          <TrailingBanner
            file={file}
            banner={{ lines, startAfter, endAfter, startBefore, endBefore }}
            expandable={expandable}
            token={token}
            highlight={highlight}
            handlers={handlers}
            commentKeysByAnchor={commentKeysByAnchor}
            isInDragRange={isInDragRange}
            onLinePointerDown={handlePointerDown}
            onLinePointerMove={handlePointerMove}
            onLinePointerUp={handlePointerUp}
          />
        )
      })()}
      </table>
    </>
  )
})

type BannerRange = {
  lines: number
  startAfter: number
  endAfter: number
  startBefore: number
  endBefore: number
}

// 「N unchanged lines」の畳まれた領域を表すバナー。
// HunkBody (hunk 間ギャップ) と TrailingBanner (最終 hunk 後の末尾) の両方から呼ばれる。
// 内部状態は持たず、loading / error / expand トリガは親から props で受ける純粋表示コンポーネント。
// 親 (HunkBody / TrailingBanner) が「state を持つ」「expand fetch を実行する」責務を負い、
// このコンポーネントは「現状をどう見せるか」だけに集中するため、表示パターンが追加されても
// 状態管理に波及しない。
function UnchangedBanner({
  lines,
  expandable,
  loading,
  error,
  onExpand,
}: {
  lines: number
  expandable: boolean
  loading: boolean
  error: string | null
  onExpand: () => void
}) {
  const state = expandable ? 'interactive' : 'readonly'
  const label = `${lines.toLocaleString()} unchanged line${lines === 1 ? '' : 's'}`
  const hint = !expandable
    ? 'Expand unavailable in PR mode'
    : loading
      ? 'Loading…'
      : 'Click to expand'
  return (
    <tr className="unchanged-banner-row">
      <td colSpan={4}>
        <button
          type="button"
          className="unchanged-banner-btn"
          data-state={state}
          onClick={expandable ? onExpand : undefined}
          disabled={loading || !expandable}
          aria-label={`${label}. ${expandable ? 'Click to expand.' : 'Expand unavailable.'}`}
        >
          {/* double-chevron アイコン: 「上下に展開できる」ことを直感的に示す。
              GitHub PR の expand icon と同じ「˅ ˄」スタイル。stroke で描画し
              親 button の color を継承させて hover で accent 色に変わる。 */}
          <span className="unchanged-banner-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M4 5.5L8 2L12 5.5M4 10.5L8 14L12 10.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="unchanged-banner-text">{label}</span>
          {error ? (
            <span className="unchanged-banner-error">Retry ({error})</span>
          ) : (
            <span className="unchanged-banner-hint">{hint}</span>
          )}
        </button>
      </td>
    </tr>
  )
}

type RowInteractionProps = {
  commentKeysByAnchor: Map<string, string[]>
  isInDragRange: (side: 'left' | 'right', lineNumber: number | undefined) => boolean
  onLinePointerDown: (
    e: React.PointerEvent<HTMLTableCellElement>,
    side: 'left' | 'right',
    lineNumber: number,
  ) => void
  onLinePointerMove: (e: React.PointerEvent<HTMLTableCellElement>) => void
  onLinePointerUp: (e: React.PointerEvent<HTMLTableCellElement>) => void
}

function HunkBody({
  hunk,
  file,
  banner,
  expandable,
  token,
  highlight,
  handlers,
  commentKeysByAnchor,
  isInDragRange,
  onLinePointerDown,
  onLinePointerMove,
  onLinePointerUp,
}: {
  hunk: Hunk
  file: ParsedFile
  banner: BannerRange | null
  expandable: boolean
  token: string
  highlight: boolean
  handlers: LineCommentHandlers
} & RowInteractionProps) {
  // 展開済み行を保持する local state。初期は null、fetch 成功で SideBySideRow[] が入る。
  // null のまま = バナー表示、配列入り = context 行として描画。
  const [expanded, setExpanded] = useState<SideBySideRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function expand() {
    if (!expandable || loading || expanded) return
    setLoading(true)
    setError(null)
    try {
      const url = `/source?token=${encodeURIComponent(token)}&path=${encodeURIComponent(
        file.path,
      )}&side=after&start=${banner!.startAfter}&end=${banner!.endAfter}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`status ${res.status}`)
      const text = await res.text()
      const lines = text.split('\n')
      // unchanged 行なので before/after を同じ内容で並べる。
      // 行番号: before 側は startBefore から、after 側は startAfter から連番。
      // raw は素のコード文字列。レンダリング時に DiffTable 側の Shiki で highlight する。
      const rows: SideBySideRow[] = lines.map((line, i) => ({
        left: { type: 'context', line: banner!.startBefore + i, raw: line },
        right: { type: 'context', line: banner!.startAfter + i, raw: line },
      }))
      setExpanded(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // origin に応じた最小限の視覚マーカー。テキストでは説明せず、
  // 左端の細いアクセントバーだけ立てる (= 視線の流れで「これは AI が付けたコンテキスト」と分かる)。
  const origin = hunk.origin ?? 'changed'
  const originClass =
    origin === 'ai-context'
      ? ' hunk-ai-context'
      : origin === 'auto-bridge'
        ? ' hunk-auto-bridge'
        : ''

  return (
    <tbody className={`hunk-body${originClass}`}>
      {banner ? (
        expanded ? (
          expanded.map((r, i) => (
            <Row
              key={`exp-${i}`}
              row={r}
              file={file}
              highlight={highlight}
              handlers={handlers}
              commentKeysByAnchor={commentKeysByAnchor}
              isInDragRange={isInDragRange}
              onLinePointerDown={onLinePointerDown}
              onLinePointerMove={onLinePointerMove}
              onLinePointerUp={onLinePointerUp}
            />
          ))
        ) : (
          <UnchangedBanner
            lines={banner.lines}
            expandable={expandable}
            loading={loading}
            error={error}
            onExpand={expand}
          />
        )
      ) : null}
      {hunk.rows.map((r, i) => (
        <Row
          key={i}
          row={r}
          file={file}
          highlight={highlight}
          handlers={handlers}
          commentKeysByAnchor={commentKeysByAnchor}
          isInDragRange={isInDragRange}
          onLinePointerDown={onLinePointerDown}
          onLinePointerMove={onLinePointerMove}
          onLinePointerUp={onLinePointerUp}
        />
      ))}
    </tbody>
  )
}

// 末尾 unchanged バナー専用 tbody。
// HunkBody と banner 描画ロジックを共有したいが、HunkBody は「banner → hunk 行」の順で描画する
// 前提なので、末尾だけは hunk を持たない別 tbody として切り出す方が責務が綺麗 (HunkBody に
// 「banner だけ」モードを足すよりシンプル)。expand したら context 行を描画する点は同じ。
function TrailingBanner({
  file,
  banner,
  expandable,
  token,
  highlight,
  handlers,
  commentKeysByAnchor,
  isInDragRange,
  onLinePointerDown,
  onLinePointerMove,
  onLinePointerUp,
}: {
  file: ParsedFile
  banner: BannerRange
  expandable: boolean
  token: string
  highlight: boolean
  handlers: LineCommentHandlers
} & RowInteractionProps) {
  const [expanded, setExpanded] = useState<SideBySideRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function expand() {
    if (!expandable || loading || expanded) return
    setLoading(true)
    setError(null)
    try {
      const url = `/source?token=${encodeURIComponent(token)}&path=${encodeURIComponent(
        file.path,
      )}&side=after&start=${banner.startAfter}&end=${banner.endAfter}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`status ${res.status}`)
      const text = await res.text()
      const lines = text.split('\n')
      const rows: SideBySideRow[] = lines.map((line, i) => ({
        left: { type: 'context', line: banner.startBefore + i, raw: line },
        right: { type: 'context', line: banner.startAfter + i, raw: line },
      }))
      setExpanded(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <tbody>
      {expanded ? (
        expanded.map((r, i) => (
          <Row
            key={`tail-${i}`}
            row={r}
            file={file}
            highlight={highlight}
            handlers={handlers}
            commentKeysByAnchor={commentKeysByAnchor}
            isInDragRange={isInDragRange}
            onLinePointerDown={onLinePointerDown}
            onLinePointerMove={onLinePointerMove}
            onLinePointerUp={onLinePointerUp}
          />
        ))
      ) : (
        <UnchangedBanner
          lines={banner.lines}
          expandable={expandable}
          loading={loading}
          error={error}
          onExpand={expand}
        />
      )}
    </tbody>
  )
}

function LineCommentTriggerButton({
  side,
  filePath,
  lineNumber,
  onOpenLineForm,
}: {
  side: 'left' | 'right'
  filePath: string
  lineNumber: number
  onOpenLineForm: LineCommentHandlers['onOpenLineForm']
}) {
  // GitHub PR スタイル: + ボタンを単一クリックすると単一行コメント、+ ボタンを掴んでそのまま
  // 下方向にドラッグすると範囲コメント。pointerdown は親 td.ln の onPointerDown (drag 開始) に
  // 委ねるため stopPropagation **しない**。pointerup での単一行展開も Row 側の handlePointerUp
  // で「同一行 + 200ms 以内」を isSingle 判定して開くので、ここで onClick を持つ必要もない。
  // (旧実装は stopPropagation + onClick で単一行を開いていたが、drag 開始経路を塞いでいた)
  return (
    <button
      type="button"
      className="line-comment-trigger"
      aria-label="Add comment to this line"
      title="Add comment / drag to select range"
      // 残るのは focus 経由の Enter キー操作のみ。マウスは親 td へ pointerdown を流す。
      onClick={(e) => {
        // pointerdown / pointerup が流れて Row 側で onOpenLineForm が呼ばれるので
        // 通常クリック時はここでは何もしない。キーボード Enter (button のデフォルト) のときだけ
        // 明示的に form を開く: マウスでクリックされた直後は detail !== 0、キーボード由来は detail === 0
        if (e.detail === 0) onOpenLineForm(filePath, { side, number: lineNumber })
      }}
    >
      +
    </button>
  )
}

function Row({
  row,
  file,
  highlight,
  handlers,
  commentKeysByAnchor,
  isInDragRange,
  onLinePointerDown,
  onLinePointerMove,
  onLinePointerUp,
}: {
  row: SideBySideRow
  file: ParsedFile
  highlight: boolean
  handlers: LineCommentHandlers
} & RowInteractionProps) {
  // highlight=false の間は Shiki を呼ばずに escapeHtml した raw を <pre> に流す。
  // viewport 付近に来て highlight=true になった瞬間に、各行が初めて Shiki を通る。
  // useMemo で raw + lang + highlight をキーに結果をキャッシュし、再 render 時の再ハイライトを防ぐ。
  const leftHtml = useMemo(
    () => (highlight ? highlightCode(row.left.raw, file.language) : escapeHtml(row.left.raw)),
    [highlight, row.left.raw, file.language],
  )
  const rightHtml = useMemo(
    () => (highlight ? highlightCode(row.right.raw, file.language) : escapeHtml(row.right.raw)),
    [highlight, row.right.raw, file.language],
  )
  // この行を anchor (= endNumber || number) として持つコメント key 一覧。
  // 単一行コメント、範囲コメント (この行が終端)、現在開いているフォームの全部が含まれ得る。
  //
  // ⚠ 左右独立に lookup する: 旧実装は resolveCommentTarget(row) で「target を 1 個」に
  //   絞ってから片側だけ引いていたが、context 行 (両側 line 有) では target が常に right に
  //   なるため、left 側でドラッグして開いた form の key (left\x1fN) が anchorKeys に乗らず、
  //   赤側のコメント form が DOM に出ない症状を生んでいた (zeus-debug 確信度 95)。
  //   formOpenFor が既に side 独立で評価されているのと同じ設計に揃え、ここでも左右の
  //   row.left.line / row.right.line から独立に lookup して連結する。
  const leftAnchorKeys =
    row.left.line != null
      ? commentKeysByAnchor.get(`left\x1f${row.left.line}`) ?? []
      : []
  const rightAnchorKeys =
    row.right.line != null
      ? commentKeysByAnchor.get(`right\x1f${row.right.line}`) ?? []
      : []
  const anchorKeys = leftAnchorKeys.length || rightAnchorKeys.length
    ? [...leftAnchorKeys, ...rightAnchorKeys]
    : []
  const formOpenKey = handlers.activeForm
  // 左右それぞれの side で「単一行フォームがこの行に開いているか」を判定し、
  // 開いている side だけ + ボタンを隠す。両 side 独立で評価することで、片側に行コメントを
  // 入力中でももう片側の + は利用可能になる。
  function formOpenFor(side: 'left' | 'right', lineNumber: number | undefined): boolean {
    if (lineNumber == null || !formOpenKey) return false
    const p = parseLineCommentKey(formOpenKey)
    return p.endNumber == null && p.side === side && p.number === lineNumber
  }
  // hover で動的に表示する仕様 (CSS 側で td.ln-l:hover / :has(td.code-l:hover) の組合せで制御)。
  // ボタン自体は「その side に行番号があれば常に DOM に置く」: render 戦略は単純化、表示制御は
  // CSS の :hover に一任 (React 再 render なし → 軽快)。
  const showLeftTrigger = row.left.line != null && !formOpenFor('left', row.left.line)
  const showRightTrigger = row.right.line != null && !formOpenFor('right', row.right.line)

  // ドラッグ中のハイライト判定 (左右それぞれ)。
  const leftInRange = isInDragRange('left', row.left.line)
  const rightInRange = isInDragRange('right', row.right.line)
  const rowSelectedClass = leftInRange || rightInRange ? ' line-selected' : ''

  // gutter (td.ln) に渡す pointer ハンドラ + data 属性。
  // ドラッグ範囲行コメントは gutter / + ボタンからのみ開始させる仕様。
  // コード列 (td.code) は通常の text selection (コピー用) を許可するため、ハンドラを付けない。
  // ただし td.code にも data-side / data-line-number は付ける: ドラッグ中に
  // resolveLineAtPoint がカーソル下のセルから side / 行番号を逆引きするため必須。
  function gutterPointerPropsFor(side: 'left' | 'right', lineNumber: number | undefined) {
    if (lineNumber == null) return {}
    return {
      'data-side': side,
      'data-line-number': String(lineNumber),
      onPointerDown: (e: React.PointerEvent<HTMLTableCellElement>) =>
        onLinePointerDown(e, side, lineNumber),
      onPointerMove: onLinePointerMove,
      onPointerUp: onLinePointerUp,
      onPointerCancel: onLinePointerUp,
    }
  }
  // td.code はデータ属性のみ (event handler なし)。
  function codeDataAttrs(side: 'left' | 'right', lineNumber: number | undefined) {
    if (lineNumber == null) return {}
    return {
      'data-side': side,
      'data-line-number': String(lineNumber),
    }
  }

  return (
    <>
      <tr className={`code-row${rowSelectedClass}`}>
        {/* td.ln から drag 開始可能。td.code は data 属性のみで pointer handler 無し
            (= テキスト選択 / コピーが普通にできる)。 */}
        <td className={`ln ln-l ln-${row.left.type}`} {...gutterPointerPropsFor('left', row.left.line)}>
          {row.left.line ?? ''}
          {showLeftTrigger && row.left.line != null ? (
            <LineCommentTriggerButton
              side="left"
              filePath={file.path}
              lineNumber={row.left.line}
              onOpenLineForm={handlers.onOpenLineForm}
            />
          ) : null}
        </td>
        <td
          className={`code code-${row.left.type}`}
          {...codeDataAttrs('left', row.left.line)}
        >
          <pre dangerouslySetInnerHTML={{ __html: leftHtml }} />
        </td>
        <td className={`ln ln-r ln-${row.right.type}`} {...gutterPointerPropsFor('right', row.right.line)}>
          {row.right.line ?? ''}
          {showRightTrigger && row.right.line != null ? (
            <LineCommentTriggerButton
              side="right"
              filePath={file.path}
              lineNumber={row.right.line}
              onOpenLineForm={handlers.onOpenLineForm}
            />
          ) : null}
        </td>
        <td
          className={`code code-${row.right.type}`}
          {...codeDataAttrs('right', row.right.line)}
        >
          <pre dangerouslySetInnerHTML={{ __html: rightHtml }} />
        </td>
      </tr>
      {/* この行を anchor とする全コメント (単一 / 範囲 / 開いているフォーム) を順に描画。
          複数 key (例: 同じ行に単一コメントと「この行で終わる範囲コメント」が共存) ある場合は、
          範囲 → 単一の順で並べると視覚的に分かりやすい。 */}
      {anchorKeys.length > 0
        ? sortAnchorKeys(anchorKeys).map((key) => (
            <CommentRowFor
              key={key}
              lineKey={key}
              file={file}
              handlers={handlers}
            />
          ))
        : null}
    </>
  )
}

// 同じ anchor 行に複数 thread がある場合の順序: 範囲 (endNumber あり) を先、単一を後。
// 「行 N-M」のヘッダを上に出して、その下に単一行コメントを並べる方が読みやすい。
function sortAnchorKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const pa = parseLineCommentKey(a)
    const pb = parseLineCommentKey(b)
    const ra = pa.endNumber != null ? 0 : 1
    const rb = pb.endNumber != null ? 0 : 1
    if (ra !== rb) return ra - rb
    return pa.number - pb.number
  })
}

function CommentRowFor({
  lineKey,
  file,
  handlers,
}: {
  lineKey: string
  file: ParsedFile
  handlers: LineCommentHandlers
}) {
  const parsed = parseLineCommentKey(lineKey)
  const savedList = handlers.lineComments.get(lineKey)
  const hasSaved = !!savedList && savedList.length > 0
  const formOpen = handlers.activeForm === lineKey
  if (!hasSaved && !formOpen) return null

  const label =
    parsed.endNumber != null && parsed.endNumber !== parsed.number
      ? `行 ${parsed.number}-${parsed.endNumber}`
      : `行 ${parsed.number}`

  // 吹き出し / フォームは「ドラッグ元 (parsed.side) のパネルに収める」設計。
  // 左 (deletion パネル) と右 (addition パネル) で独立した選択が成り立つように、
  // それぞれの side の 2 つの td (gutter + code) を colSpan={2} で確保し、
  // 反対 side の 2 つは空セルとして残す (= テーブルの列構造は崩さない)。
  const thread = (
    <div className="comment-thread" data-side={parsed.side}>
      <div className="comment-thread-header">{label}</div>
      {savedList?.map((body, i) => (
        <SavedComment
          key={`${lineKey}-${i}`}
          lineKey={lineKey}
          index={i}
          body={body}
          editingBody={handlers.editing.get(`${lineKey}#${i}`)}
          onStartEdit={handlers.onStartEditLineComment}
          onCancelEdit={handlers.onCancelEditLineComment}
          onSaveEdit={handlers.onSaveEditLineComment}
          onDelete={handlers.onDeleteLineComment}
        />
      ))}
      {formOpen ? (
        <NewCommentForm
          onSave={(body) =>
            handlers.onAddLineComment(
              file.path,
              { side: parsed.side, number: parsed.number, endNumber: parsed.endNumber },
              body,
            )
          }
          onCancel={handlers.onCloseLineForm}
        />
      ) : null}
    </div>
  )

  return (
    <tr className="comment-row" data-comment-side={parsed.side}>
      {parsed.side === 'left' ? (
        <>
          <td colSpan={2} className="comment-cell">{thread}</td>
          <td colSpan={2} className="comment-cell comment-cell-empty" />
        </>
      ) : (
        <>
          <td colSpan={2} className="comment-cell comment-cell-empty" />
          <td colSpan={2} className="comment-cell">{thread}</td>
        </>
      )}
    </tr>
  )
}

function NewCommentForm({
  onSave,
  onCancel,
}: {
  onSave: (body: string) => void
  onCancel: () => void
}) {
  const [body, setBody] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  // マウント時に自動 focus。Linear / GitHub の挙動に合わせて、開いたらすぐ書けるように。
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <form
      className="comment-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(body)
      }}
    >
      <textarea
        ref={ref}
        className="comment-textarea"
        placeholder="コメントを書く (Cmd/Ctrl+Enter で保存、Esc でキャンセル)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            onSave(body)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="comment-form-actions">
        <button type="button" className="comment-btn comment-btn-cancel" onClick={onCancel}>
          キャンセル
        </button>
        <button type="submit" className="comment-btn comment-btn-save">
          保存
        </button>
      </div>
    </form>
  )
}

function SavedComment({
  lineKey,
  index,
  body,
  editingBody,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
}: {
  lineKey: string
  index: number
  body: string
  editingBody: string | undefined
  onStartEdit: (key: string, index: number, body: string) => void
  onCancelEdit: (key: string, index: number) => void
  onSaveEdit: (key: string, index: number, body: string) => void
  onDelete: (key: string, index: number) => void
}) {
  const isEditing = editingBody !== undefined
  const [draft, setDraft] = useState(editingBody ?? body)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (isEditing) {
      setDraft(editingBody ?? body)
      ref.current?.focus()
    }
    // editingBody が undefined ↔ string で切り替わるタイミングで draft を再同期する。
    // body 変化時は別 saved として扱うので追従しなくて OK。
  }, [isEditing, editingBody])

  if (isEditing) {
    return (
      <div className="comment-bubble is-editing">
        <textarea
          ref={ref}
          className="comment-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              onSaveEdit(lineKey, index, draft)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancelEdit(lineKey, index)
            }
          }}
        />
        <div className="comment-form-actions">
          <button
            type="button"
            className="comment-btn comment-btn-cancel"
            onClick={() => onCancelEdit(lineKey, index)}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="comment-btn comment-btn-save"
            onClick={() => onSaveEdit(lineKey, index, draft)}
          >
            保存
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="comment-bubble">
      <div className="comment-body">{body}</div>
      <div className="comment-actions">
        <button
          type="button"
          className="comment-action-btn"
          onClick={() => onStartEdit(lineKey, index, body)}
        >
          編集
        </button>
        <button
          type="button"
          className="comment-action-btn comment-action-danger"
          onClick={() => {
            if (confirm('このコメントを削除しますか？')) onDelete(lineKey, index)
          }}
        >
          削除
        </button>
      </div>
    </div>
  )
}

