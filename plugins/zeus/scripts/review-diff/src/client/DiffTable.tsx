// side-by-side の diff テーブル。
// rows[].left.html / right.html は Shiki 済みの <span> 列なので dangerouslySetInnerHTML で展開。
// Shiki の入力は信頼できる (CLI 側で git diff を生成 → サーバー内で highlight) ので
// XSS 経路にはならない。
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
//   - クリックで activeForm を立ち上げ、その行の直下に <tr.comment-row> を挿入
//   - 保存済みコメントは同じ comment-row の中に吹き出しブロックとして積み上がる
//   - hover で各 bubble に「編集」「削除」ボタンが出る
//   - textarea で Cmd/Ctrl+Enter = 保存、Escape = キャンセル
//   - side 判定: right に line 番号があれば right、無ければ left (deletion 行)。
//     context 行 (両側に番号あり) は右側で扱う = after ファイルの行番号で記録する。

import { useEffect, useRef, useState } from 'react'
import type { Hunk, ParsedFile, SideBySideRow } from '../server-side/types.js'
import { lineCommentKey } from './state.ts'
import type { LineCommentHandlers } from './useLineComments.ts'

type Props = {
  file: ParsedFile
  visibleHunks: Hunk[]
  expandable: boolean
  token: string
} & LineCommentHandlers

export function DiffTable({ file, visibleHunks, expandable, token, ...handlers }: Props) {
  if (file.status === 'binary') {
    return <div className="binary-notice">Binary file (preview not available)</div>
  }
  if (visibleHunks.length === 0) {
    return <div className="binary-notice">No hunks to display.</div>
  }
  return (
    <table className="diff-table">
      <colgroup>
        <col style={{ width: 52 }} />
        <col />
        <col style={{ width: 52 }} />
        <col />
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
          />
        )
      })}
    </table>
  )
}

type BannerRange = {
  lines: number
  startAfter: number
  endAfter: number
  startBefore: number
  endBefore: number
}

function HunkBody({
  hunk,
  file,
  banner,
  expandable,
  token,
  handlers,
}: {
  hunk: Hunk
  file: ParsedFile
  banner: BannerRange | null
  expandable: boolean
  token: string
  handlers: LineCommentHandlers
}) {
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
      const rows: SideBySideRow[] = lines.map((line, i) => {
        const html = escapeHtmlForRow(line)
        return {
          left: { type: 'context', line: banner!.startBefore + i, html },
          right: { type: 'context', line: banner!.startAfter + i, html },
        }
      })
      setExpanded(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <tbody>
      {banner ? (
        expanded ? (
          expanded.map((r, i) => (
            <Row key={`exp-${i}`} row={r} file={file} handlers={handlers} />
          ))
        ) : (
          <tr>
            <td colSpan={4} className="unchanged-banner">
              {expandable ? (
                <button
                  type="button"
                  // インラインで装飾を少しだけ調整 (テキストリンク風)。CSS にクラスを増やす
                  // ほどの差分ではないため、ここでスタイル指定する。
                  style={{
                    background: 'transparent',
                    border: 0,
                    color: 'inherit',
                    cursor: loading ? 'wait' : 'pointer',
                    font: 'inherit',
                    textDecoration: 'underline',
                  }}
                  onClick={expand}
                  disabled={loading}
                >
                  {loading
                    ? `Loading ${banner.lines} unchanged lines…`
                    : error
                      ? `⇕ ${banner.lines} unchanged lines (error: ${error}, click to retry)`
                      : `⇕ ${banner.lines} unchanged lines`}
                </button>
              ) : (
                <span>
                  ⇕ {banner.lines} unchanged lines (Expand unavailable in PR mode)
                </span>
              )}
            </td>
          </tr>
        )
      ) : null}
      {hunk.rows.map((r, i) => (
        <Row key={i} row={r} file={file} handlers={handlers} />
      ))}
    </tbody>
  )
}

type CommentTarget = { side: 'left' | 'right'; number: number }

// この行のコメント側 (side) と行番号を決める。
// 優先: right に line 番号があれば right (context / addition)、無ければ left (deletion)。
// どちらにも無ければコメント不可 (empty 行)。
function resolveCommentTarget(row: SideBySideRow): CommentTarget | null {
  if (row.right.line != null) return { side: 'right', number: row.right.line }
  if (row.left.line != null) return { side: 'left', number: row.left.line }
  return null
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
  return (
    <button
      type="button"
      className="line-comment-trigger"
      aria-label="Add comment to this line"
      title="Add comment"
      onClick={() => onOpenLineForm(filePath, side, lineNumber)}
    >
      +
    </button>
  )
}

function Row({
  row,
  file,
  handlers,
}: {
  row: SideBySideRow
  file: ParsedFile
  handlers: LineCommentHandlers
}) {
  const target = resolveCommentTarget(row)
  const key = target ? lineCommentKey(file.path, target.side, target.number) : null
  const savedList = key ? handlers.lineComments.get(key) : undefined
  const hasSaved = !!savedList && savedList.length > 0
  const formOpen = key !== null && handlers.activeForm === key
  // 左 gutter は deletion 行 (right に番号が無いケース) のとき、
  // 右 gutter は context / addition のときにトリガを出す。
  // 反対側はその行に対しては行番号自体が無いので描画しない。
  const showLeftTrigger = target?.side === 'left' && !formOpen
  const showRightTrigger = target?.side === 'right' && !formOpen

  return (
    <>
      <tr className="code-row">
        <td className={`ln ln-l ln-${row.left.type}`}>
          {row.left.line ?? ''}
          {showLeftTrigger && target ? (
            <LineCommentTriggerButton
              side="left"
              filePath={file.path}
              lineNumber={target.number}
              onOpenLineForm={handlers.onOpenLineForm}
            />
          ) : null}
        </td>
        <td className={`code code-${row.left.type}`}>
          <pre dangerouslySetInnerHTML={{ __html: row.left.html }} />
        </td>
        <td className={`ln ln-r ln-${row.right.type}`}>
          {row.right.line ?? ''}
          {showRightTrigger && target ? (
            <LineCommentTriggerButton
              side="right"
              filePath={file.path}
              lineNumber={target.number}
              onOpenLineForm={handlers.onOpenLineForm}
            />
          ) : null}
        </td>
        <td className={`code code-${row.right.type}`}>
          <pre dangerouslySetInnerHTML={{ __html: row.right.html }} />
        </td>
      </tr>
      {/* 保存済みコメント or 新規フォーム がある行だけコメント行を描画。
          colSpan=4 で行全幅を覆い、上下に小さく margin を入れて吹き出し感を出す。 */}
      {key && target && (hasSaved || formOpen) ? (
        <tr className="comment-row">
          <td colSpan={4}>
            <div className="comment-thread" data-side={target.side}>
              {savedList?.map((body, i) => (
                <SavedComment
                  key={`${key}-${i}`}
                  lineKey={key}
                  index={i}
                  body={body}
                  editingBody={handlers.editing.get(`${key}#${i}`)}
                  onStartEdit={handlers.onStartEditLineComment}
                  onCancelEdit={handlers.onCancelEditLineComment}
                  onSaveEdit={handlers.onSaveEditLineComment}
                  onDelete={handlers.onDeleteLineComment}
                />
              ))}
              {formOpen ? (
                <NewCommentForm
                  onSave={(body) =>
                    handlers.onAddLineComment(file.path, target.side, target.number, body)
                  }
                  onCancel={handlers.onCloseLineForm}
                />
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
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

// /source の応答はプレーンテキスト。Shiki ハイライトは持っていないため、
// XSS を避けるべく素直にエスケープして <pre> に流す。
// (元の hunk 行は CLI 側で highlight 済みなので、見た目の差は context 行の色付きの有無のみ。)
function escapeHtmlForRow(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  )
}
