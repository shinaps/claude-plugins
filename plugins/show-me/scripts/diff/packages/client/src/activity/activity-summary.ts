// Activity タブの「group ごとの file 一覧」を計算する純関数群。
// React component から切り離して TS only にすることで、テスト容易性 + 再計算が
// useMemo で済む形に。groupFiles は O(panels) で線形。
//
// 設計判断:
//   - file 単位の集計を二重カウントしない
//     (同じ file が複数 panel に出るケースは現状無いが defensive に dedupe する)
//   - file change kind は (asIs/toBe の有無 + 同名/別名) の 4 値で discriminated union 的に分類

import type { RenderedPanel } from '@show-me/diff-shared'
import { basename } from '../lib/path'

export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed'

export type GroupFileInfo = {
  // 表示用: basename。rename は "oldBase → newBase"。
  display: string
  // tooltip 用 full path。rename は "oldPath → newPath"。
  fullPath: string
  kind: FileChangeKind
}

function inferKind(panel: RenderedPanel): FileChangeKind {
  const a = panel.asIs?.file
  const b = panel.toBe?.file
  if (!a && b) return 'added'
  if (a && !b) return 'deleted'
  if (a && b && a !== b) return 'renamed'
  return 'modified'
}

// group の panels から「ユニークな file 集合」を kind 付きで取り出す。
// 表示順は panel の出現順 (= AI が決めた読み順)。
export function groupFiles(panels: ReadonlyArray<RenderedPanel>): GroupFileInfo[] {
  const seen = new Map<string, GroupFileInfo>()
  for (const p of panels) {
    const a = p.asIs?.file
    const b = p.toBe?.file
    const key = b ?? a ?? ''
    if (!key || seen.has(key)) continue
    const kind = inferKind(p)
    let display: string
    let fullPath: string
    if (kind === 'renamed' && a && b) {
      display = `${basename(a)} → ${basename(b)}`
      fullPath = `${a} → ${b}`
    } else if (b) {
      display = basename(b)
      fullPath = b
    } else if (a) {
      display = basename(a)
      fullPath = a
    } else {
      continue
    }
    seen.set(key, { display, fullPath, kind })
  }
  return Array.from(seen.values())
}
