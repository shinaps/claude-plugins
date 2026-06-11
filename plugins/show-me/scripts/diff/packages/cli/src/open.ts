// 公式サポートは macOS のみ。他 OS でも CLI 自体は動くようにし、URL を stderr に出すだけに留める。
// 自動オープンに失敗してプロセスが死ぬのを避けるため、unref で完全に切り離す。

import { spawn } from 'node:child_process'

export function openUrl(url: string): void {
  if (process.platform !== 'darwin') {
    process.stderr.write(
      `Warning: review-diff officially supports macOS only. Open ${url} manually.\n`
    )
    return
  }
  const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
  // spawn の実行失敗 (ENOENT 等) は同期 throw ではなく 'error' イベントで届く。
  // listener が無いと uncaught exception でプロセスごと落ちるため、ここで受けて警告に留める。
  child.on('error', () => {
    process.stderr.write(`Warning: failed to auto-open browser. Open ${url} manually.\n`)
  })
  child.unref()
}
