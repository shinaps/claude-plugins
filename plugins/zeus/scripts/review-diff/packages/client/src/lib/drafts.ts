// sessionStorage draft の read/write/remove 規約 (ThreadReplyForm / PanelHeader / CommentForm 系で共用)。
//   - key は `draft:` prefix 必須: App の collectAllDrafts() がこの prefix を走査して
//     regen / comment-reply の close-relaunch 時に restore.json へ回収する契約。
//   - 空文字は remove (空 draft を restore 対象に残さない)
//   - storage 不能 (private mode 等) は黙って no-op (draft 永続化は無くても機能は成立する)
export function readDraft(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? ''
  } catch { return '' }
}

export function writeDraft(key: string, body: string): void {
  try { sessionStorage.setItem(key, body) } catch { /* storage unavailable */ }
}

export function removeDraft(key: string): void {
  try { sessionStorage.removeItem(key) } catch { /* storage unavailable */ }
}
