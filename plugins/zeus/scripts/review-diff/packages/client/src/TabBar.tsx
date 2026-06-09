// 上部の Linear 風タブナビ。
//   - Activity: AI Review Report (overall サマリ + group インデックス)
//   - Guide   : panel ベースの stacked-group レビュー UI (主要ワークフロー)
//   - Diff    : raw unified diff をそのまま表示 (グループ化無し、git diff の生コピー)

type Tab = 'activity' | 'guide' | 'diff'

type Props = {
  active: Tab
  onChange: (tab: Tab) => void
  meta?: string
  // React 18 concurrent transition 中フラグ。タブを click した瞬間に true になり、
  // 新タブ render が完了したら false に戻る。UI 上はタブ全体に subtle な「進行中」表現を出す。
  pending?: boolean
}

// tabbar BEM を残す理由: `.tabbar.is-pending::after` の progress bar pseudo-element +
// animation が globals.css にあるため。bg は `rgba(10,10,13,0.85)` で background token の alpha 版
// (token に alpha 込みのものを足すか迷ったが、ここ 1 箇所だけなので arbitrary value で OK)。
const TAB_BASE =
  'px-3 py-1.5 text-xs font-medium font-sans text-text-dim bg-transparent border-0 rounded-md cursor-pointer transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:opacity-[0.45] enabled:hover:text-text-muted enabled:hover:bg-surface'
const TAB_ACTIVE = 'text-text bg-surface-2'

export function TabBar({ active, onChange, meta, pending }: Props) {
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
      <button
        type="button"
        role="tab"
        className={active === 'activity' ? `${TAB_BASE} ${TAB_ACTIVE}` : TAB_BASE}
        onClick={() => onChange('activity')}
      >
        Activity
      </button>
      <button
        type="button"
        role="tab"
        className={active === 'guide' ? `${TAB_BASE} ${TAB_ACTIVE}` : TAB_BASE}
        onClick={() => onChange('guide')}
      >
        Guide
      </button>
      <button
        type="button"
        role="tab"
        className={active === 'diff' ? `${TAB_BASE} ${TAB_ACTIVE}` : TAB_BASE}
        onClick={() => onChange('diff')}
      >
        Diff
      </button>
      {meta ? (
        <div className="ml-auto text-[11px] text-text-dim font-mono">{meta}</div>
      ) : null}
    </div>
  )
}
