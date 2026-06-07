// Shiki を 13 言語 + github-dark テーマだけに絞ってバンドルする薄いラッパー。
// 全言語を含めると数 MB に膨れるため、ソースコードで日常的に遭遇するものに限定している。
// 未対応言語は plaintext にフォールバック (致命的でないため例外を投げず素通し)。

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

export function createShiki(): HighlighterCore {
  return createHighlighterCoreSync({
    themes: [githubDark],
    langs: [ts, tsx, js, jsx, json, md, shell, py, go, rust, yaml, html, css, dockerfile],
    engine: createJavaScriptRegexEngine(),
  })
}

// 拡張子 → Shiki の言語 ID マッピング。
// Dockerfile のように拡張子を持たないファイルは basename で別途判定する。
const EXT_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', mdx: 'markdown',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  py: 'python', go: 'go', rs: 'rust',
  yaml: 'yaml', yml: 'yaml',
  html: 'html', htm: 'html', css: 'css',
}

const KNOWN = new Set(Object.values(EXT_MAP).concat(['dockerfile']))

export function langForPath(path: string): string {
  const base = path.split('/').pop() ?? ''
  if (base === 'Dockerfile' || base.endsWith('.dockerfile')) return 'dockerfile'
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  const lang = EXT_MAP[ext]
  return lang && KNOWN.has(lang) ? lang : 'plaintext'
}
