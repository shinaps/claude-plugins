// 上部の Linear 風タブナビ。
// 現状は Guide だけ実装、Activity / Diff は placeholder (disabled)。
// 将来のロードマップに合わせて配線できるよう、tab id を string union で持つ。

type Tab = 'activity' | 'guide' | 'diff'

type Props = {
  active: Tab
  onChange: (tab: Tab) => void
  meta?: string
}

export function TabBar({ active, onChange, meta }: Props) {
  return (
    <div className="tabbar" role="tablist">
      <button
        type="button"
        role="tab"
        className={`tab ${active === 'activity' ? 'active' : ''}`}
        disabled
        title="Coming soon"
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
        disabled
        title="Coming soon"
      >
        Diff
      </button>
      {meta ? <div className="tabbar-meta">{meta}</div> : null}
    </div>
  )
}
