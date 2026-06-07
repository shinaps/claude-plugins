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

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClientPayload, Comment, ParsedFile, PrMeta } from '../server-side/types.js'
import { TabBar } from './TabBar.tsx'
import { GroupSection } from './GroupSection.tsx'
import { ActionBar } from './ActionBar.tsx'
import { renderMarkdown, escapeHtml } from './markdown.ts'
import { getToken, parseLineCommentKey } from './state.ts'
import { useLineComments } from './useLineComments.ts'

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
  const [overallComment, setOverallComment] = useState('')
  const [tab, setTab] = useState<Tab>('guide')
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<null | 'approve' | 'reject'>(null)
  const [toast, setToast] = useState<string | null>(null)

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

  function collectComments(): Comment[] {
    const out: Comment[] = []
    const g = overallComment.trim()
    if (g) out.push({ file: null, body: g })
    for (const [file, body] of comments) {
      const trimmed = body.trim()
      if (trimmed) out.push({ file, body: trimmed })
    }
    for (const [key, bodies] of lineCommentHandlers.lineComments) {
      const { file, side, number } = parseLineCommentKey(key)
      for (const body of bodies) {
        const trimmed = body.trim()
        if (trimmed) out.push({ file, body: trimmed, line: { side, number } })
      }
    }
    return out
  }

  async function submit(decision: 'approve' | 'reject') {
    if (submitted) return
    if (decision === 'approve' && reviewed.size < payload.allFiles.length) {
      if (!confirm('Not all files marked as Reviewed. Approve anyway?')) return
    }
    const cs = collectComments()
    if (decision === 'reject' && cs.length === 0) {
      if (!confirm('Reject with no comments. Continue?')) return
    }
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
    } catch {
      setToast('Failed to submit.')
      setTimeout(() => setToast(null), 3000)
    }
  }

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
        <h1>{title}</h1>
        <div className="meta" dangerouslySetInnerHTML={{ __html: meta }} />
        {overallHtml ? (
          <div className="markdown" dangerouslySetInnerHTML={{ __html: overallHtml }} />
        ) : null}
      </div>
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
            {...lineCommentHandlers}
          />
        ))}
        <div className="global-comment-block">
          <label htmlFor="overall-comment">Overall comment</label>
          <textarea
            id="overall-comment"
            className="global-comment"
            placeholder="全体に対するコメント (任意)"
            value={overallComment}
            onChange={(e) => setOverallComment(e.target.value)}
          />
        </div>
      </div>
      <ActionBar
        reviewedCount={reviewed.size}
        totalFiles={payload.allFiles.length}
        onMarkAll={markAll}
        onApprove={() => submit('approve')}
        onReject={() => submit('reject')}
      />
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
      const hunks: number[] | 'all' = typeof ref === 'string' ? 'all' : ref.hunks
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
