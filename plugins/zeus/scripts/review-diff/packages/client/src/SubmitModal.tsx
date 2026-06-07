// Approve / Reject 確認モーダル。
// 設計判断:
//   - 以前は画面最上部の overall コメント textarea で全体コメントを書いてから、画面右下の
//     ActionBar まで戻って Approve/Reject を押す必要があった。長い diff だとスクロール往復が痛い。
//   - そこで Approve/Reject クリック時にモーダルを開き、その中で overall コメントを書ける形に統合。
//   - Decision の意思表明 (Approve/Reject) をモーダルのアクセント色で強調する: Approve→success、
//     Reject→danger。誤クリックの取り消しは Cancel / ESC / backdrop クリックで可能。
//   - textarea にフォーカス中の backdrop クリックは閉じない: 書きかけのテキストを失わないため。
//     これは「textarea が focus を持っている場合のみ無視」というルールで実現する。
//
// パフォーマンス上の WHY (state colocation):
//   以前は overall コメントの値を App ルート state に持っていたが、textarea keystroke 毎の
//   setState で App → 全 GroupSection / FileBlock / DiffTable (数千行) が再 render され、
//   1 打鍵 100ms+ の入力遅延を引き起こしていた。textarea の値はこのモーダル内で完結する状態
//   (Confirm のときだけ親に渡せばよい) なので、SubmitModal 内部に colocate した。
//   これで keystroke の再 render はモーダル subtree だけに閉じる。

import { useEffect, useRef, useState } from 'react'

type Props = {
  decision: 'approve' | 'reject'
  // モーダルを開いた瞬間の textarea 初期値。モーダルが閉じている間はこの値は保持されない (= 毎回空)。
  // 「書きかけのまま閉じて再度開く」UX は今のところ要件外。必要になったら App 側で保持してここに渡す。
  initialValue?: string
  onCancel: () => void
  onConfirm: (body: string) => void
}

export function SubmitModal({ decision, initialValue = '', onCancel, onConfirm }: Props) {
  // textarea の値はモーダル内部 state に閉じる。Confirm 時のみ onConfirm(body) で親に渡す。
  const [body, setBody] = useState(initialValue)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 開いた瞬間にフォーカスを textarea に。Linear / Github 風の即書きスタート UX。
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // ESC でキャンセル (window レベルで拾う: モーダル内 textarea にフォーカスがあっても効くように)。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    // backdrop 自体 (= ダイアログ外) のクリックだけで閉じる。ダイアログ内部の click は伝播しないため
    // currentTarget === target で十分。さらに textarea にフォーカスがある場合は、書きかけ保護のため
    // 無視する (誤って backdrop に流れたクリックでテキストを失わない)。
    if (e.currentTarget !== e.target) return
    if (document.activeElement === textareaRef.current) return
    onCancel()
  }

  const isApprove = decision === 'approve'
  const title = isApprove ? '変更を承認しますか?' : '変更を却下しますか?'
  const confirmLabel = isApprove ? 'Approve' : 'Reject'
  const confirmClass = isApprove ? 'modal-btn-approve' : 'modal-btn-reject'

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div
        className={`modal-dialog ${isApprove ? 'modal-approve' : 'modal-reject'}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <h2>{title}</h2>
        </header>
        <div className="modal-body">
          <textarea
            ref={textareaRef}
            className="modal-textarea"
            placeholder="全体への補足コメント (任意)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter で submit。長文を書いたあとマウスに持ち替えずに送れる。
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                onConfirm(body)
              }
            }}
          />
        </div>
        <footer className="modal-footer">
          <button type="button" className="modal-btn modal-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`modal-btn ${confirmClass}`} onClick={() => onConfirm(body)}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
