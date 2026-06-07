// 1 グループの左 sticky ペイン。番号 + タイトル + 説明 (markdown) + ファイル一覧。
// クリックで右ペインのファイル diff に anchor scroll。スクロール位置の補正は
// CSS の scroll-margin-top で固定 TabBar の高さ分オフセットする。
//
// 設計判断:
//   - description は Markdown を許容 (Group.description はサーバー側で生成され信頼源)
//   - ファイル名表示は basename を強調 + dirname をディム色で続ける。Linear と同じ
//     「ファイル本体に視線が落ちる」見せ方を狙う。

import type { ParsedFile } from '../server-side/types.js'
import { renderMarkdown } from './markdown.ts'

type Props = {
  index: number
  total: number
  title: string
  description: string
  files: ParsedFile[]
  reviewed: Set<string>
  onJump: (path: string) => void
}

export function GroupNav({ index, total, title, description, files, reviewed, onJump }: Props) {
  const num = String(index + 1).padStart(2, '0')
  const tot = String(total).padStart(2, '0')
  const descHtml = renderMarkdown(description || '')

  return (
    <aside className="group-nav">
      <div className="group-number">
        {num} <span className="total">/ {tot}</span>
      </div>
      <h2 className="group-title">{title}</h2>
      {descHtml ? (
        <div className="group-desc" dangerouslySetInnerHTML={{ __html: descHtml }} />
      ) : null}
      {files.length ? (
        <div className="group-file-list">
          {files.map((f) => (
            <FileItem key={f.path} file={f} reviewed={reviewed.has(f.path)} onJump={onJump} />
          ))}
        </div>
      ) : null}
    </aside>
  )
}

function FileItem({
  file,
  reviewed,
  onJump,
}: {
  file: ParsedFile
  reviewed: boolean
  onJump: (p: string) => void
}) {
  const { name, dir } = splitPath(file.path)
  return (
    <button
      type="button"
      className={`group-file-item ${reviewed ? 'reviewed' : ''}`}
      onClick={() => onJump(file.path)}
      title={file.path}
    >
      <FileIcon />
      <span className="file-name">{name}</span>
      <span className="file-dir">{dir}</span>
      {file.additions ? <span className="stat-add">+{file.additions}</span> : null}
      {file.deletions ? <span className="stat-del">-{file.deletions}</span> : null}
    </button>
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
