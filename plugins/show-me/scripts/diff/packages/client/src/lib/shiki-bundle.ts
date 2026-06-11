// Shiki を主要言語 + github-dark テーマだけに絞ってバンドルする薄いラッパー。
// 全言語を含めると数 MB に膨れるため、ソースコードで日常的に遭遇するものに限定している。
// 未対応言語は plaintext にフォールバック (致命的でないため例外を投げず素通し)。
//
// なぜ client に置くか:
//   サーバから Shiki を撤去し、ハイライトはブラウザ側 (DiffTable) の責務に倒した。
//   server bundle から数 MB の正規表現を剥がし、CLI の Node 起動を軽くする狙い。
//   ファイル拡張子 → Shiki 言語 ID マッピング (langForPath) は server 側 diff-parser に
//   残してある (parse-git-diff 直後 = server の責務)。

import { createHighlighterCoreSync, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import ts from '@shikijs/langs/typescript'
import tsx from '@shikijs/langs/tsx'
import js from '@shikijs/langs/javascript'
import jsx from '@shikijs/langs/jsx'
import json from '@shikijs/langs/json'
import md from '@shikijs/langs/markdown'
import shell from '@shikijs/langs/shellscript'
import py from '@shikijs/langs/python'
import go from '@shikijs/langs/go'
import rust from '@shikijs/langs/rust'
import yaml from '@shikijs/langs/yaml'
import html from '@shikijs/langs/html'
import css from '@shikijs/langs/css'
import dockerfile from '@shikijs/langs/dockerfile'
import githubDark from '@shikijs/themes/github-dark'

function createShiki(): HighlighterCore {
  return createHighlighterCoreSync({
    themes: [githubDark],
    langs: [ts, tsx, js, jsx, json, md, shell, py, go, rust, yaml, html, css, dockerfile],
    engine: createJavaScriptRegexEngine(),
  })
}

// lazy singleton: grammar 登録 (全言語の正規表現コンパイル) をモジュール評価時
// (= 初回 paint 前のバンドル評価) に走らせず、初回 highlightCode 呼び出し
// (= IntersectionObserver で panel が viewport 近接した後) まで遅延して起動を軽くする。
let singleton: HighlighterCore | null = null
export function getShiki(): HighlighterCore {
  if (!singleton) singleton = createShiki()
  return singleton
}
