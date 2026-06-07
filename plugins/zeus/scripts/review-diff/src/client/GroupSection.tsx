// 1 グループ全体の section コンポーネント。
// CSS Grid で 320px の sticky 左 nav と、可変幅の右 file 列を並べる。
// グループ間の境界は section の border-top で表現するため、ここではコンテナだけ提供する。

import type { ParsedFile } from '../server-side/types.js'
import { GroupNav } from './GroupNav.tsx'
import { FileBlock } from './FileBlock.tsx'
import type { LineCommentHandlers } from './useLineComments.ts'

// App.tsx の BucketEntry と同じ shape。型重複を避けるためここで再定義しているが、
// 構造上は App 側がオーナー。
type BucketEntry = {
  file: ParsedFile
  hunks: number[] | 'all'
}

type Props = {
  index: number
  total: number
  title: string
  description: string
  entries: BucketEntry[]
  expandable: boolean
  token: string
  reviewed: Set<string>
  comments: Map<string, string>
  onJump: (path: string) => void
  onToggleReviewed: (path: string, checked: boolean) => void
  onChangeComment: (path: string, body: string) => void
} & LineCommentHandlers

export function GroupSection({
  index,
  total,
  title,
  description,
  entries,
  expandable,
  token,
  reviewed,
  comments,
  onJump,
  onToggleReviewed,
  onChangeComment,
  ...lineCommentHandlers
}: Props) {
  const navFiles = entries.map((e) => e.file)
  return (
    <section className="group-section" data-group-index={index}>
      <GroupNav
        index={index}
        total={total}
        title={title}
        description={description}
        files={navFiles}
        reviewed={reviewed}
        onJump={onJump}
      />
      <div className="group-files-column">
        {entries.map((entry, i) => (
          <FileBlock
            // hunks 分割で 1 ファイルが同 group に複数回出ることは無いが、
            // 念のため index も key に混ぜて React の reconcile を安定させる。
            key={`${entry.file.path}::${i}`}
            file={entry.file}
            hunks={entry.hunks}
            expandable={expandable}
            token={token}
            reviewed={reviewed.has(entry.file.path)}
            comment={comments.get(entry.file.path) ?? ''}
            onToggleReviewed={onToggleReviewed}
            onChangeComment={onChangeComment}
            {...lineCommentHandlers}
          />
        ))}
      </div>
    </section>
  )
}
