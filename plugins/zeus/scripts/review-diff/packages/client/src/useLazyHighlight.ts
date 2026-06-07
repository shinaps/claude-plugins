// IntersectionObserver で「viewport 付近に入ったか」を判定する hook。
//
// なぜ存在するか:
//   6000+ 行規模の diff 全体を初回マウントで Shiki ハイライトすると、
//   - DOM 65K ノード級 (highlight 済み <span> 列が大量に生える) で reconciliation が詰まる
//   - 結果として Cancel ボタンや TabBar のクリック反応が 40ms+ 遅延する
//   という UX 問題が出ていた。各 file ブロックに ref を持たせ、画面付近に来た file だけを
//   ハイライト対象に昇格させることで、初回マウント時の DOM 量と Shiki 実行コストを大幅に下げる。
//
// 設計上の決め:
//   - 一度可視になったら以後は true 固定 (re-observe しない)。
//     スクロールで一度ハイライトしたファイルを raw に戻すと、戻ってきたときに再 highlight が
//     走って体感的にチラつき、検索やコメント描画も巻き戻る。一方向 (raw → highlighted) のみ。
//   - rootMargin は 500px 0px (上下 500px 先読み)。検索 / anchor jump で画面外の file に飛ぶ
//     ケースでも、ジャンプ着地と同時に highlight 反映が間に合う程度のマージン。
//   - root は document (= null) で viewport を使う。スクロールコンテナを別途指定するケースが
//     出てきたら引数で受け取る形に拡張する。

import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

export function useLazyHighlight(
  ref: RefObject<HTMLElement | null>,
  rootMargin = '500px 0px',
): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // IntersectionObserver 非対応環境 (SSR / 古い jsdom 等) はその場で highlight 有効に倒す。
    // SSR で動かす予定は無いが、テスト環境 (happy-dom) でも安全側に倒した方が既存テストが
    // 既存挙動 (= 常に highlight) と一致する。
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true)
            io.disconnect()
            break
          }
        }
      },
      { root: null, rootMargin },
    )
    io.observe(el)
    return () => {
      io.disconnect()
    }
  }, [ref, rootMargin])

  return visible
}
