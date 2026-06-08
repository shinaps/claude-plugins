// 上部の Linear 風タブナビ (v4.12.0)。
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

export function TabBar({ active, onChange, meta, pending }: Props) {
  return (
    <div className={`tabbar${pending ? ' is-pending' : ''}`} role="tablist">
      <button
        type="button"
        role="tab"
        className={`tab ${active === 'activity' ? 'active' : ''}`}
        onClick={() => onChange('activity')}
      >
        Activity
      </button>
      <button
        type="button"
        role="tab"
        className={`tab ${active === 'guide' ? 'active' : ''}`}
        onClick={() => onChange('guide')}
      >
        Guide
      </button>
      <button
        type="button"
        role="tab"
        className={`tab ${active === 'diff' ? 'active' : ''}`}
        onClick={() => onChange('diff')}
      >
        Diff
      </button>
      {meta ? <div className="tabbar-meta">{meta}</div> : null}
    </div>
  )
}
