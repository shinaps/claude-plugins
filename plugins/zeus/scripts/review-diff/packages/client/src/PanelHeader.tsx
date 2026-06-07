// Panel の上部に出るヘッダ。
//   - intent (太字)
//   - asIs.file → toBe.file (片側だけなら片側、cross-file なら矢印で並べる)
//
// なぜ Reviewed をここに置かないか:
//   PanelHeader は「panel の何を / どこを変えるか」のメタ表示に責務を絞り、
//   ユーザーの完了状態 (Reviewed) は PanelBlock の footer/sidebar が扱う。
//   こうすることでヘッダの密度が下がり、複数 panel が並ぶ画面で「次に読むべき行」を
//   迷わず追える。
//
// v4.8.0 で unified mode を廃止したため split/unified toggle ボタンを削除した。
// 将来 zoom-in view 等を追加するなら同じ panel-header-actions スロットを再利用できる。

import type { RenderedPanel } from '@zeus/review-diff-shared'

export type PanelHeaderProps = {
  panel: RenderedPanel
}

export function PanelHeader({ panel }: PanelHeaderProps) {
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
    </div>
  )
}
