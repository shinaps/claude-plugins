// 1 ファイル分のヘッダ + diff + per-file コメント。
// 旧 FileView.tsx の機能 (Reviewed / コメント / collapse / WARN) を継承。
// レイアウトを Linear 風のカード型ヘッダにリスタイルした。
//
// COLLAPSE_THRESHOLD: 大きい diff を初期表示すると Shiki ハイライト済み HTML を
// 大量にマウントして初期描画が重くなるため、行数で自動折り畳み。
// scroll-margin-top は固定 TabBar の高さ + 余白を見越して styles.ts 側で設定。
//
// hunks prop:
//   'all'      ファイルの全 hunks を表示 (従来形式の Group.files: string[] 相当)
//   number[]   指定 hunk.index のみ表示 (目的別ファイル分割)。
//   1 ファイルが 2 つの Group にまたがる時、別 Group には別 hunks 番号で出すことで
//   同一ファイルの異なる側面をそれぞれの文脈で読める。

import { useMemo, useState } from 'react'
import type { ParsedFile } from '../server-side/types.js'
import { DiffTable } from './DiffTable.tsx'
import type { LineCommentHandlers } from './useLineComments.ts'

const COLLAPSE_THRESHOLD = 2000
const WARN_THRESHOLD = 10000

type Props = {
  file: ParsedFile
  hunks: number[] | 'all'
  expandable: boolean
  token: string
  reviewed: boolean
  comment: string
  onToggleReviewed: (path: string, checked: boolean) => void
  onChangeComment: (path: string, body: string) => void
} & LineCommentHandlers

export function FileBlock({
  file,
  hunks,
  expandable,
  token,
  reviewed,
  comment,
  onToggleReviewed,
  onChangeComment,
  ...lineCommentHandlers
}: Props) {
  // 表示対象 hunks をフィルタ。元順序を維持し、未知 index は黙って捨てる。
  const visibleHunks = useMemo(() => {
    if (hunks === 'all') return file.hunks
    const set = new Set(hunks)
    return file.hunks.filter((h) => set.has(h.index))
  }, [file.hunks, hunks])

  const visibleLines = visibleHunks.reduce((sum, h) => sum + h.rows.length, 0)
  const [collapsed, setCollapsed] = useState(visibleLines > COLLAPSE_THRESHOLD)
  const { name, dir } = splitPath(file.path)

  return (
    <article className="file-block file" data-path={file.path}>
      <header className="file-block-header">
        <FileIcon />
        <span className="file-path">
          {file.oldPath ? <span className="rename">{file.oldPath} → </span> : null}
          <span className="dir">{dir}</span>
          <span>{name}</span>
        </span>
        {file.status !== 'modified' ? (
          <span className={`badge badge-${file.status}`}>{file.status}</span>
        ) : null}
        <span className="stats">
          {file.additions ? <span className="add">+{file.additions}</span> : null}
          {file.deletions ? <span className="del">-{file.deletions}</span> : null}
        </span>
        <label className={`reviewed-toggle ${reviewed ? 'is-reviewed' : ''}`}>
          <input
            type="checkbox"
            className="reviewed-check"
            checked={reviewed}
            onChange={(e) => onToggleReviewed(file.path, e.target.checked)}
          />
          Reviewed
        </label>
        <button
          type="button"
          className="menu-btn"
          aria-label={collapsed ? 'expand' : 'collapse'}
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '+' : '−'}
        </button>
      </header>
      {visibleLines > WARN_THRESHOLD ? (
        <div className="warning">⚠ {visibleLines} lines; performance may degrade.</div>
      ) : null}
      {!collapsed ? (
        <div className="file-body">
          <DiffTable
            file={file}
            visibleHunks={visibleHunks}
            expandable={expandable}
            token={token}
            {...lineCommentHandlers}
          />
          <div className="comment-block">
            <textarea
              className="file-comment"
              placeholder="このファイルへのコメント (任意)"
              value={comment}
              onChange={(e) => onChangeComment(file.path, e.target.value)}
            />
          </div>
        </div>
      ) : null}
    </article>
  )
}

function splitPath(p: string): { name: string; dir: string } {
  const idx = p.lastIndexOf('/')
  if (idx < 0) return { name: p, dir: '' }
  return { name: p.slice(idx + 1), dir: p.slice(0, idx + 1) }
}

function FileIcon() {
  return (
    <svg className="file-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 2.5h6.5L13 6v7.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5Z" />
      <path d="M9.5 2.5v3a.5.5 0 0 0 .5.5h3" />
    </svg>
  )
}
