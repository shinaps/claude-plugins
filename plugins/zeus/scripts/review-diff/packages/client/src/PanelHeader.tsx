// Panel の上部に出るヘッダ。
//   - intent (太字)
//   - asIs.file → toBe.file (片側だけなら片側、cross-file なら矢印で並べる)
//   - split / unified 切替トグル
//   - Reviewed checkbox は責務分離のため PanelBlock 側に置く (A9 統合)
//
// なぜ Reviewed をここに置かないか:
//   PanelHeader は「panel の何を / どこを変えるか」のメタ表示に責務を絞り、
//   ユーザーの完了状態 (Reviewed) は PanelBlock の footer/sidebar が扱う。
//   こうすることでヘッダの密度が下がり、複数 panel が並ぶ画面で「次に読むべき行」を
//   迷わず追える。

import type { RenderedPanel } from '@zeus/review-diff-shared'
import type { PanelMode } from './usePanelToggle'

export type PanelHeaderProps = {
  panel: RenderedPanel
  mode: PanelMode
  onToggle: () => void
}

export function PanelHeader({ panel, mode, onToggle }: PanelHeaderProps) {
  const asIsFile = panel.asIs?.file
  const toBeFile = panel.toBe?.file
  return (
    <div className="panel-header" data-panel-id={panel.panelId}>
      <div className="panel-header-main">
        <div className="panel-intent">{panel.intent}</div>
        <div className="panel-files">
          {asIsFile && toBeFile && asIsFile !== toBeFile ? (
            <>
              <span className="panel-file panel-file-asis">{asIsFile}</span>
              <span className="panel-file-arrow" aria-hidden>→</span>
              <span className="panel-file panel-file-tobe">{toBeFile}</span>
            </>
          ) : (
            <span className="panel-file">{toBeFile ?? asIsFile ?? '(no file)'}</span>
          )}
        </div>
      </div>
      <div className="panel-header-actions">
        <button
          type="button"
          className="panel-mode-toggle"
          onClick={onToggle}
          aria-label={mode === 'split' ? 'Switch to unified view' : 'Switch to split view'}
          title={mode === 'split' ? 'Unified view' : 'Split view'}
        >
          {mode === 'split' ? 'Unified' : 'Split'}
        </button>
      </div>
    </div>
  )
}
