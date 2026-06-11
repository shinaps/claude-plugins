// extractTunnelUrl (純関数) のテスト。startTunnel 本体は cloudflared 実体に依存するため
// 単体テストでは抽出ロジックだけを固定し、プロセス管理は手動 dogfooding で検証する。

import { test, expect } from 'vitest'
import { extractTunnelUrl } from '../src/tunnel'

// cloudflared が実際に出すログ形式 (box 描画つき announce)
const REAL_LOG = `2026-06-12T00:00:00Z INF Thank you for trying Cloudflare Tunnel.
2026-06-12T00:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-06-12T00:00:02Z INF +--------------------------------------------------------------------------------------------+
2026-06-12T00:00:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-06-12T00:00:02Z INF |  https://eat-some-random-words-here.trycloudflare.com                                      |
2026-06-12T00:00:02Z INF +--------------------------------------------------------------------------------------------+
`

test('extracts quick tunnel URL from real cloudflared log format', () => {
  expect(extractTunnelUrl(REAL_LOG)).toBe('https://eat-some-random-words-here.trycloudflare.com')
})

test('returns null when no tunnel URL is present', () => {
  expect(extractTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull()
  expect(extractTunnelUrl('')).toBeNull()
})

test('finds URL even when it arrives split across chunks (caller accumulates)', () => {
  // 呼び出し側は累積バッファを渡す契約: チャンク 1 つ目では null、結合後にマッチする
  const chunk1 = 'INF |  https://split-across-chunk'
  const chunk2 = 's.trycloudflare.com  |'
  expect(extractTunnelUrl(chunk1)).toBeNull()
  expect(extractTunnelUrl(chunk1 + chunk2)).toBe('https://split-across-chunks.trycloudflare.com')
})

test('does not match non-trycloudflare hosts', () => {
  expect(extractTunnelUrl('https://evil.example.com')).toBeNull()
})

test('does not match the quick tunnel provisioning API host in failure logs', () => {
  // CF API 障害時に cloudflared が出すエラーログ。announce box より先に届いても
  // 払い出し API のホストを公開 URL と誤認してはならない
  const failureLog =
    'ERR Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host'
  expect(extractTunnelUrl(failureLog)).toBeNull()
  // 失敗ログの後に本物の announce が届けば本物の方を拾う
  expect(extractTunnelUrl(failureLog + '\nINF |  https://real-tunnel-url.trycloudflare.com  |'))
    .toBe('https://real-tunnel-url.trycloudflare.com')
})
