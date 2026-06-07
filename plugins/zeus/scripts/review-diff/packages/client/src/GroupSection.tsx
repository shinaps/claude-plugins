// 1 グループ全体の section コンポーネント。
// CSS Grid で 320px の sticky 左 nav と、可変幅の右 file 列を並べる。
// グループ間の境界は section の border-top で表現するため、ここではコンテナだけ提供する。

import { memo } from 'react'
import type { ParsedFile } from '@zeus/review-diff-shared'
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
  // 左 nav カラムの右端に置くリサイズハンドル用。ドラッグ開始の pointerdown だけ親に渡し、
  // move / up は App ルートで window 経由で処理する (handle 上だけで完結させると、カーソルが
  // diff 領域に逸れた瞬間に move を取りこぼすため)。
  onNavResizerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
} & LineCommentHandlers

// React.memo で props 浅比較。SubmitModal の textarea keystroke 等で App ルートが軽く再 render しても、
// reviewed / comments / lineCommentHandlers 等の参照が同一なら子のツリーごと再 render を skip できる。
// App 側で reviewed=Set / comments=Map / lineCommentHandlers=useMemo を維持しているのが前提。
export const GroupSection = memo(function GroupSection({
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
  onNavResizerPointerDown,
  ...lineCommentHandlers
}: Props) {
  const navFiles = entries.map((e) => e.file)
  return (
    <section className="group-section" data-group-index={index}>
      <div className="group-nav-wrapper">
        <GroupNav
          index={index}
          total={total}
          title={title}
          description={description}
          files={navFiles}
          reviewed={reviewed}
          onJump={onJump}
        />
        {/* リサイズハンドル。細い縦線。hover で太く強調 (CSS 側) し、ドラッグで navWidth を変更する。
            section ごとに 1 個出すが、操作対象は App ルートの共通 navWidth state なので、
            どの section で掴んでも全 section の幅が同期する。 */}
        <div
          className="nav-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize navigation"
          onPointerDown={onNavResizerPointerDown}
        />
      </div>
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
})
