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
  try {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    process.stderr.write(`Warning: failed to auto-open browser. Open ${url} manually.\n`)
  }
}
