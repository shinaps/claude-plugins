// アプリのトップレベル。
// 設計判断:
//   - 旧 App はビュー切替式 (Overview / Files の 2 画面)。Linear Guide タブ風の
//     「縦に全グループが並ぶ単一スクロール」に作り直したため、view state は廃止。
//   - reviewed / comments は useState のローカル state で十分。再描画範囲は file-block 単位、
//     件数も人間が同時にレビューする現実的な diff 規模では数十〜数百件まで。
//   - アクティブグループの「ハイライト」は CSS の sticky だけで体感できるため、
//     IntersectionObserver は導入しない (失敗時フォールバック方針)。
//     scroll-margin-top で TabBar 高さを補正する。
//   - Approve/Reject 押下時は fetch で /result?token=... に POST、成功したら
//     "<decision> received" 画面に置き換えて二重送信を防ぐ。
//   - ファイルジャンプは scrollIntoView を useEffect (state.scrollTarget) で副作用化
//     (DOM querySelector を render 内で叩かないため)。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientPayload, Comment, ParsedFile, PrMeta } from '@zeus/review-diff-shared'
import { TabBar } from './TabBar.tsx'
import { GroupSection } from './GroupSection.tsx'
import { ActionBar } from './ActionBar.tsx'
import { SubmitModal } from './SubmitModal.tsx'
import { renderMarkdown, escapeHtml } from './markdown.ts'
import { getToken, parseLineCommentKey } from './state.ts'
import { useLineComments } from './useLineComments.ts'

// 左サイドナビ (GroupNav) の幅。大きいモニターでもデフォルトでは 320px だが、ユーザーがハンドルで
// 動的に調整できる。永続化はしない (毎セッション 320 から開始) — レビュー用途は短命なので保存価値が低い。
//
// パフォーマンス上の WHY:
//   旧実装は navWidth を React state で持ち、pointermove 毎に setState → App 全体 (含む diff テーブル
//   13 ファイル分) が毎フレーム再レンダーされてカクついていた。改修後は state を一切使わず、
//   pointermove 内で containerRef.current.style.setProperty('--nav-width', ...) を直接書き込み、
//   rAF で間引く。React は再レンダーゼロ、CSS variable の伝播だけでレイアウト追従させる。
const NAV_WIDTH_DEFAULT = 320
const NAV_WIDTH_MIN = 240
const NAV_WIDTH_MAX = 480

type Props = { payload: ClientPayload }
type Tab = 'activity' | 'guide' | 'diff'

// バケット内の各エントリは「ファイル本体 + そのグループで表示する hunk 範囲」を持つ。
// hunks が 'all' なら全 hunks (= 旧来の string 形式の files 指定相当)、
// number[] なら該当 hunk.index のみレンダリング (目的別ファイル分割)。
type BucketEntry = {
  file: ParsedFile
  hunks: number[] | 'all'
}

type GroupBucket = {
  title: string
  description: string
  entries: BucketEntry[]
}

export function App({ payload }: Props) {
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set())
  const [comments, setComments] = useState<Map<string, string>>(() => new Map())
  // 行コメント関連の state + 7 ハンドラを hook に集約。詳細は useLineComments.ts。
  const lineCommentHandlers = useLineComments()
  // overall コメントは SubmitModal 内部 state に colocate 済み (keystroke 毎に App ルートを
  // 再 render させないため)。submit のときだけモーダルから body を受け取って collectComments に流す。
  const [tab, setTab] = useState<Tab>('guide')
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<null | 'approve' | 'reject'>(null)
  const [toast, setToast] = useState<string | null>(null)
  // Approve/Reject ボタン押下時に開く確認モーダル。null = 閉じている。
  // 設計判断: 「ボタン押下 = モーダルで意思確認 + overall コメント入力」と 1 アクションに統合し、
  // 上部の textarea (削除済み) と下部の ActionBar を往復するスクロールコストを無くす。
  const [modalDecision, setModalDecision] = useState<null | 'approve' | 'reject'>(null)
  // 左 nav 幅の state は意図的に持たない。
  // pointermove 毎に setState すると App 配下 (= 全 diff テーブル) が再レンダーされてカクつくため、
  // 値は containerRef.current.style の CSS variable に直接書き込み、React の管理外に置く。
  // 初期値は CSS 側の `var(--nav-width, 320px)` フォールバックが供給する。

  const containerRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<string>(getToken())

  // payload.summary.groups + orphan ファイルからセクションを組み立てる。
  // groups に載っていないファイル (新規追加されたが summary が古い等) は "Other" に集約。
  const buckets = useMemo<GroupBucket[]>(() => buildBuckets(payload), [payload])

  useEffect(() => {
    if (!scrollTarget) return
    const sel = `article.file[data-path="${cssEscape(scrollTarget)}"]`
    const el = containerRef.current?.querySelector(sel) as HTMLElement | null
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setScrollTarget(null)
  }, [scrollTarget])

  function toggleReviewed(path: string, checked: boolean) {
    setReviewed((prev) => {
      const next = new Set(prev)
      if (checked) next.add(path)
      else next.delete(path)
      return next
    })
  }

  function changeComment(path: string, body: string) {
    setComments((prev) => {
      const next = new Map(prev)
      if (body) next.set(path, body)
      else next.delete(path)
      return next
    })
  }

  function markAll() {
    setReviewed(new Set(payload.allFiles))
  }

  function jumpToFile(path: string) {
    setScrollTarget(path)
  }

  function collectComments(overallBody: string): Comment[] {
    const out: Comment[] = []
    const g = overallBody.trim()
    if (g) out.push({ file: null, body: g })
    for (const [file, body] of comments) {
      const trimmed = body.trim()
      if (trimmed) out.push({ file, body: trimmed })
    }
    for (const [key, bodies] of lineCommentHandlers.lineComments) {
      const { file, side, number, endNumber } = parseLineCommentKey(key)
      // endNumber が number と同値 / 未定義なら出力側でも省略し、単一行コメントの JSON 形状を
      // range 機能登場前と完全互換に保つ (CLI 側の既存パーサを変更不要にするため)。
      const line =
        endNumber != null && endNumber !== number
          ? { side, number, endNumber }
          : { side, number }
      for (const body of bodies) {
        const trimmed = body.trim()
        if (trimmed) out.push({ file, body: trimmed, line })
      }
    }
    return out
  }

  async function submit(decision: 'approve' | 'reject', overallBody: string) {
    if (submitted) return
    // Reject 時の「コメント無し confirm」は廃止: モーダル内で overall コメントを書く UI が明確になり、
    // ユーザーが意図的に空のまま Confirm したなら尊重する (再質問はテンポを削ぐだけ)。
    const cs = collectComments(overallBody)
    try {
      await fetch(`/result?token=${encodeURIComponent(tokenRef.current)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          reviewedFiles: Array.from(reviewed),
          comments: cs,
        }),
      })
      setSubmitted(decision)
      setModalDecision(null)
      // タブ自動 close: CLI が結果を受け取った後はもうユーザーが見るものは無いので、
      // ブラウザを閉じる手間を省く。Chrome は script open でないタブに対して window.close を
      // 拒否することがあるため、失敗時はそのまま「閉じてください」表示にフォールバック。
      setTimeout(() => {
        try { window.close() } catch {}
      }, 300)
    } catch {
      setToast('Failed to submit.')
      setTimeout(() => setToast(null), 3000)
    }
  }

  // リサイズハンドル: pointerdown で開始 → resizer 要素に pointer capture → pointermove で
  // CSS variable を rAF batch で直接書き換え → pointerup で終了。
  //
  // パフォーマンスの WHY:
  //   旧実装は pointermove ごとに React state を更新していたため、子の DiffTable まで含めて
  //   毎フレーム再レンダー → カクつき。改修後は React state を一切触らず、
  //   containerRef.current.style.setProperty('--nav-width', ...) で DOM 直更新する。
  //   CSS Grid の grid-template-columns は CSS variable を読むだけなのでブラウザ側の
  //   レイアウト計算のみが走り、React の reconciliation はゼロ。
  //
  //   さらに pointermove が 120Hz+ デバイス (ProMotion 等) で過剰に発火するケースに備え、
  //   rAF で 1 frame ごとに間引く。
  //
  //   pointer capture を resizer 要素に張ることで、カーソルが diff 領域に逸れても move を
  //   取りこぼさない (window listener より stop 条件が確実)。
  const onNavResizerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const resizer = e.currentTarget
    const pointerId = e.pointerId
    const container = containerRef.current
    if (!container) return
    // 計算基準は最寄りの .group-section (= grid 1 列目の起点)。
    // .groups-container には padding-left:24px があり、ここを基準にすると --nav-width が
    // 常に 24px 過大になり、視覚バーがポインタの 24px 右にずれていた (root cause 確定)。
    // 書き込み先は引き続き .groups-container (CSS variable の継承で全 section に効く)。
    const section = resizer.closest('.group-section') as HTMLElement | null
    if (!section) return

    // ドラッグ中のスタイルは DOM 直接操作。state 経由にすると再レンダーが走るため。
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    resizer.classList.add('dragging')

    try {
      resizer.setPointerCapture(pointerId)
    } catch {
      // setPointerCapture が失敗しても window listener にフォールバックされるので致命ではない
    }

    // rAF で間引く: 高 Hz デバイスで pointermove が秒間 120+ 来ても、書き込みは 1 frame に 1 回。
    let rafId: number | null = null
    let pendingClientX = 0

    function flush() {
      rafId = null
      if (!container) return
      // nav 列の幅 = ポインタ x − nav 列の起点 x。
      // 起点は section の rect.left (= grid 1 列目の left edge)。
      // groups-container 基準だと padding-left が混入してずれるため使わない。
      const sectionLeft = section!.getBoundingClientRect().left
      const next = pendingClientX - sectionLeft
      const clamped = Math.max(NAV_WIDTH_MIN, Math.min(NAV_WIDTH_MAX, next))
      container.style.setProperty('--nav-width', `${clamped}px`)
    }

    function onMove(ev: PointerEvent) {
      pendingClientX = ev.clientX
      if (rafId !== null) return
      rafId = requestAnimationFrame(flush)
    }
    function onUp() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      resizer.classList.remove('dragging')
      try {
        resizer.releasePointerCapture(pointerId)
      } catch {
        // 既に release 済みなら無視
      }
      resizer.removeEventListener('pointermove', onMove)
      resizer.removeEventListener('pointerup', onUp)
      resizer.removeEventListener('pointercancel', onUp)
    }

    // pointer capture 中はターゲット要素自身に move が届くため、window ではなく resizer に張る。
    resizer.addEventListener('pointermove', onMove)
    resizer.addEventListener('pointerup', onUp)
    resizer.addEventListener('pointercancel', onUp)
  }, [])

  if (submitted) {
    return <div className="done">{submitted} received. You can close this tab.</div>
  }

  const meta = formatMeta(payload)
  const overallHtml = renderMarkdown(payload.summary.overallSummary || '')
  const title = payload.prMeta
    ? payload.prMeta.title
    : payload.summary.mode === 'staged'
      ? 'Staged Diff Review'
      : 'Diff Review'

  return (
    <>
      <TabBar active={tab} onChange={setTab} meta={`${payload.allFiles.length} files`} />
      <div className="page-header">
        <div className="report-card">
          <div className="report-card-eyebrow">AI Review Report</div>
          <h1>{title}</h1>
          <div className="meta" dangerouslySetInnerHTML={{ __html: meta }} />
          {overallHtml ? (
            <div className="markdown" dangerouslySetInnerHTML={{ __html: overallHtml }} />
          ) : null}
          {buckets.length > 0 ? (
            <ul className="report-index">
              {buckets.map((b, i) => (
                <li
                  key={i}
                  className="report-index-item"
                  onClick={() => b.entries[0] && jumpToFile(b.entries[0].file.path)}
                  title="Jump to this group"
                >
                  <span className="report-index-number">{String(i + 1).padStart(2, '0')}</span>
                  <span className="report-index-title">{b.title}</span>
                  <span className="report-index-meta">{b.entries.length} file{b.entries.length === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {/* style に --nav-width を渡さない: 値は onNavResizerPointerDown 内で DOM に直接書き込む。
          初期表示は CSS 側の var(--nav-width, 320px) フォールバックが効く。 */}
      <div className="groups-container" ref={containerRef}>
        {buckets.map((b, i) => (
          <GroupSection
            key={i}
            index={i}
            total={buckets.length}
            title={b.title}
            description={b.description}
            entries={b.entries}
            expandable={payload.expandable}
            token={tokenRef.current}
            reviewed={reviewed}
            comments={comments}
            onJump={jumpToFile}
            onToggleReviewed={toggleReviewed}
            onChangeComment={changeComment}
            onNavResizerPointerDown={onNavResizerPointerDown}
            {...lineCommentHandlers}
          />
        ))}
      </div>
      <ActionBar
        reviewedCount={reviewed.size}
        totalFiles={payload.allFiles.length}
        onMarkAll={markAll}
        onApprove={() => setModalDecision('approve')}
        onReject={() => setModalDecision('reject')}
      />
      {modalDecision ? (
        <SubmitModal
          decision={modalDecision}
          onCancel={() => setModalDecision(null)}
          onConfirm={(body) => submit(modalDecision, body)}
        />
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </>
  )
}

function buildBuckets(payload: ClientPayload): GroupBucket[] {
  const byPath = new Map<string, ParsedFile>()
  for (const f of payload.files) byPath.set(f.path, f)

  const groups = payload.summary.groups || []
  // seen は「いずれかの group に少なくとも 1 hunk でも振られたファイル」を Other 判定で除外するため。
  // 同じファイルが複数 group に hunks 指定で割れているケースでも、Other には載せたくない。
  const seen = new Set<string>()
  const buckets: GroupBucket[] = []
  for (const g of groups) {
    const entries: BucketEntry[] = []
    for (const ref of g.files || []) {
      const path = typeof ref === 'string' ? ref : ref.path
      const f = byPath.get(path)
      if (!f) continue
      // displayRanges 形式は CLI 側 composeHunks で既に「表示すべき hunks」だけに絞られているため、
      // client では 'all' として扱う (再 index フィルタ不要)。
      // 既存 { path, hunks: [n] } 形式は従来通り index フィルタを通す。
      const hunks: number[] | 'all' = typeof ref === 'string'
        ? 'all'
        : 'displayRanges' in ref
          ? 'all'
          : ref.hunks
      entries.push({ file: f, hunks })
      seen.add(path)
    }
    if (entries.length === 0) continue
    buckets.push({ title: g.title, description: g.description || '', entries })
  }
  // groups で言及されていない (= AI サマリ後に追加された等) ファイルを Other バケットへ。
  // groups が空でも、ここで全ファイルを Other に押し込めば最低限のレイアウトが成立する。
  const orphans = payload.files.filter((f) => !seen.has(f.path))
  if (orphans.length) {
    buckets.push({
      title: groups.length ? 'Other' : 'Changes',
      description: groups.length
        ? 'これらのファイルはサマリのグループに含まれていません。'
        : '',
      entries: orphans.map((f) => ({ file: f, hunks: 'all' as const })),
    })
  }
  return buckets
}

function formatMeta(payload: ClientPayload): string {
  const pr: PrMeta | null = payload.prMeta
  if (pr) {
    const author = typeof pr.author === 'string' ? pr.author : (pr.author?.login ?? '')
    return `PR #${pr.number} · ${escapeHtml(author)} · ${escapeHtml(pr.headRefName || '')} → ${escapeHtml(pr.baseRefName || '')}`
  }
  return `${payload.summary.mode === 'staged' ? 'staged diff' : 'diff'} · ${payload.allFiles.length} files`
}

// querySelector のセレクタに渡すファイルパスをエスケープ。CSS.escape のフォールバック付き。
function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
  return s.replace(/["\\]/g, '\\$&')
}
