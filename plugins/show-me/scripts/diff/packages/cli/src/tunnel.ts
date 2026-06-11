// cloudflared Quick Tunnel のライフサイクル管理。
//
// Quick Tunnel は `cloudflared tunnel --url ...` を起動するとプロセス単位の使い捨て URL
// (https://xxx.trycloudflare.com) を stderr に出力する。URL はアカウント不要・毎回変わる。
// tunnel プロセスは CLI と運命共同体なので detached にしない: CLI が死んだら tunnel も
// 必ず閉じる必要がある (公開 URL が宙に浮いたまま残るのを防ぐ)。
//
// 失敗はすべて null 返却の graceful fallback に倒す。リモートレビューは「開けたら便利」な
// 経路であって、tunnel が立たないことを理由にレビュー自体を止めない (呼び出し側が
// ローカルモードへ縮退する)。

import { spawn, type ChildProcess } from 'node:child_process'

export type Tunnel = {
  url: string
  close: () => void
}

// cloudflared の stderr ログから Quick Tunnel URL を抽出する。
// ログは複数チャンクに分かれて届くため、呼び出し側は累積バッファ全体を毎回渡す。
// api. を除外しているのは、Quick Tunnel の払い出し先である
// `https://api.trycloudflare.com/tunnel` が CF API 障害時のエラーログに現れ、
// announce box より先に届くとそれを公開 URL と誤認して壊れた REMOTE URL を
// 配布してしまうため (fallback にも落ちない最悪の失敗モード)。
export function extractTunnelUrl(text: string): string | null {
  const m = text.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/)
  return m ? m[0] : null
}

export function startTunnel(port: number, timeoutMs = 30_000): Promise<Tunnel | null> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(
        'cloudflared',
        ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
    } catch {
      resolve(null)
      return
    }

    let settled = false
    let stderrBuf = ''

    // 自分で kill したケース (close / timeout fallback / exit hook) と cloudflared が
    // 勝手に死んだケースを exit ハンドラで区別するためのフラグ。これが無いと
    // timeout → settle(null) → kill 直後の exit で「unexpectedly」警告が出てしまい、
    // 「falling back to local mode」と矛盾したログが並ぶ。
    let intentionalKill = false
    const kill = () => {
      intentionalKill = true
      try { child.kill() } catch { /* noop */ }
    }
    // Node は親プロセスの終了時に子を自動 kill しないため、exit / シグナルの両方で
    // tunnel を道連れにする。process.on('exit') はシグナルのデフォルト死では発火しない
    // ので SIGINT / SIGTERM も明示的に受けて kill → 本来の終了コードで exit する。
    const onExit = () => kill()
    const onSignal = (sig: NodeJS.Signals) => {
      kill()
      process.exit(sig === 'SIGINT' ? 130 : 143)
    }
    process.on('exit', onExit)
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)

    const settle = (result: Tunnel | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result === null) {
        kill()
        process.removeListener('exit', onExit)
        process.removeListener('SIGINT', onSignal)
        process.removeListener('SIGTERM', onSignal)
      }
      resolve(result)
    }

    const timer = setTimeout(() => settle(null), timeoutMs)
    timer.unref?.()

    // ENOENT (未インストール) は同期 throw ではなく 'error' イベントで届く
    child.on('error', () => settle(null))

    child.on('exit', (code) => {
      if (!settled) {
        // URL 確定前の死 = tunnel 確立失敗 → fallback
        settle(null)
        return
      }
      if (intentionalKill) return
      // セッション中の死は警告のみ。ローカル URL は生きているので CLI は殺さず縮退する
      process.stderr.write(
        `[show-me:diff] cloudflared exited unexpectedly (code=${code}); remote URL is no longer reachable\n`,
      )
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8')
      const url = extractTunnelUrl(stderrBuf)
      if (url) {
        settle({
          url,
          close: () => {
            kill()
            process.removeListener('exit', onExit)
            process.removeListener('SIGINT', onSignal)
            process.removeListener('SIGTERM', onSignal)
          },
        })
      }
    })
  })
}
