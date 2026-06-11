// 上部の Linear 風タブナビ。
//   - Activity: AI Review Report (overall サマリ + group インデックス)
//   - Guide   : panel ベースの stacked-group レビュー UI (主要ワークフロー)
//   - Diff    : raw unified diff をそのまま表示 (グループ化無し、git diff の生コピー)

import type { ProjectInfo } from '@zeus/review-diff-shared'

type Tab = 'activity' | 'guide' | 'diff'

type Props = {
  active: Tab
  onChange: (tab: Tab) => void
  meta?: string
  // 複数プロジェクトのレビューを並行して開いたとき、常時表示の tabbar 左端で
  // どのリポジトリのレビューかを識別できるようにする (git が引けない環境では null)。
  project?: ProjectInfo | null
  // React 18 concurrent transition 中フラグ。タブを click した瞬間に true になり、
  // 新タブ render が完了したら false に戻る。UI 上はタブ全体に subtle な「進行中」表現を出す。
  pending?: boolean
}

// tabbar BEM を残す理由: `.tabbar.is-pending::after` の progress bar pseudo-element +
// animation が globals.css にあるため。bg は `rgba(10,10,13,0.85)` で background token の alpha 版
// (token に alpha 込みのものを足すか迷ったが、ここ 1 箇所だけなので arbitrary value で OK)。
// text 色 / hover は base に入れず active / inactive で排他にする:
// 同一要素に text-text-dim と text-text を併記すると Tailwind は記述順でなく
// stylesheet 順で解決するため、active 側の色が効かない事故になる。
const TAB_BASE =
  'px-3 py-1.5 text-xs font-medium font-sans bg-transparent border-0 rounded-md cursor-pointer transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:opacity-[0.45]'
const TAB_INACTIVE = 'text-text-dim enabled:hover:text-text-muted enabled:hover:bg-surface'
// アクティブタブは accent で着色する: 輝度差 (text-text + bg-surface-2) だけでは
// どのタブを開いているか一目で判別できないため。
const TAB_ACTIVE = 'text-accent bg-accent-soft'

export function TabBar({ active, onChange, meta, project, pending }: Props) {
  // tabbar 高さを 46px に固定する理由:
  //   panel-block の panel-header は `position: sticky; top: 46px` で tabbar の真下に貼り付く設計。
  //   旧 styles.css では tab の line-height: 1.5 inherit で実測 46px に収まっていたが、Tailwind v4 の
  //   text-xs は line-height 1rem (16px) なので tab button 高が縮み、py-2.5 では tabbar 高が
  //   46px と一致しない (透ける) バグが出る。h-[46px] で明示固定し、border-box で border-bottom 1px
  //   込み 46px → sticky panel-header と隙間ゼロを保証する。
  return (
    <div
      className={`tabbar sticky top-0 z-30 flex items-center gap-1 h-[46px] px-6 bg-[rgba(10,10,13,0.85)] backdrop-blur-[10px] border-b border-border-soft${pending ? ' is-pending' : ''}`}
      role="tablist"
    >
      {project ? (
        <div
          className="flex items-baseline gap-1.5 mr-3 pr-3 border-r border-border-soft min-w-0 max-w-[40%]"
          title={project.branch ? `${project.name} (${project.branch})` : project.name}
        >
          <span className="text-xs font-semibold text-text whitespace-nowrap">{project.name}</span>
          {project.branch ? (
            <span className="text-2xs text-text-dim font-mono truncate">{project.branch}</span>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        role="tab"
        aria-selected={active === 'activity'}
        className={`${TAB_BASE} ${active === 'activity' ? TAB_ACTIVE : TAB_INACTIVE}`}
        onClick={() => onChange('activity')}
      >
        Activity
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'guide'}
        className={`${TAB_BASE} ${active === 'guide' ? TAB_ACTIVE : TAB_INACTIVE}`}
        onClick={() => onChange('guide')}
      >
        Guide
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'diff'}
        className={`${TAB_BASE} ${active === 'diff' ? TAB_ACTIVE : TAB_INACTIVE}`}
        onClick={() => onChange('diff')}
      >
        Diff
      </button>
      {meta ? (
        <div className="ml-auto text-2xs text-text-dim font-mono">{meta}</div>
      ) : null}
    </div>
  )
}
