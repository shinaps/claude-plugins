import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { EditorKind, EditorPreset, ReviewDiffConfig } from '@show-me/diff-shared'

// diff.config.json の loader + EditorPreset 解決。
//   - editor.kind がプリセットなら EDITOR_PRESETS table から command / urlScheme を引く
//   - user が editor.command / editor.urlScheme を書いていればプリセットを上書き
//   - editor が未指定なら editorPreset = null (= EditorLinkTrigger を描画しない)
//   - kind='custom' のときは command が必須 (バリデーション失敗で投げる)
//
// CLI 起動時に CR-3 を守って server 側のみ editorPreset を保持し、クライアントには
// editorAvailable: boolean だけを伝搬する。

// EditorPreset table (architect 案 B.2.3 / plan C.3 維持)。
// urlScheme は v5 一刀構成では実行時未使用だが、preset table の type 互換のため残す。
const EDITOR_PRESETS: Record<Exclude<EditorKind, 'custom'>, Omit<EditorPreset, 'kind'>> = {
  vscode: { command: 'code --goto {path}:{line}', urlScheme: 'vscode://file/{path}:{line}' },
  cursor: { command: 'cursor --goto {path}:{line}', urlScheme: 'cursor://file/{path}:{line}' },
  idea: { command: 'idea --line {line} {path}', urlScheme: 'idea://open?file={path}&line={line}' },
  zed: { command: 'zed {path}:{line}', urlScheme: null },
  sublime: { command: 'subl {path}:{line}', urlScheme: null },
}

const ScriptConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  matchFiles: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().optional(),
})

const EditorKindSchema = z.enum(['vscode', 'cursor', 'idea', 'zed', 'sublime', 'custom'])

const EditorConfigSchema = z.object({
  kind: EditorKindSchema,
  command: z.string().optional(),
  urlScheme: z.string().optional(),
})

const ReviewDiffConfigSchema = z.object({
  editor: EditorConfigSchema.optional(),
  scripts: z.array(ScriptConfigSchema).optional(),
})

export type LoadedConfig = {
  config: ReviewDiffConfig
  editorPreset: EditorPreset | null
}

// loadReviewDiffConfig:
//   - path が undefined / null / 空文字 → 空 config を返す
//   - ファイル存在しない → 例外 (path が指定されたのに無いのは ユーザーが意図的な誤指定とみなす)
//   - JSON parse / schema validation 失敗 → 例外
//   - kind='custom' で command 未指定 → 例外
export function loadReviewDiffConfig(path?: string | null): LoadedConfig {
  if (!path) return { config: {}, editorPreset: null }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`diff.config.json not found at ${path}: ${(e as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`diff.config.json is not valid JSON: ${(e as Error).message}`)
  }

  const result = ReviewDiffConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`diff.config.json failed schema validation:\n${result.error.message}`)
  }

  const config = result.data as ReviewDiffConfig
  const editorPreset = resolveEditorPreset(config.editor)
  return { config, editorPreset }
}

function resolveEditorPreset(editor: ReviewDiffConfig['editor']): EditorPreset | null {
  if (!editor) return null
  if (editor.kind === 'custom') {
    if (!editor.command) {
      throw new Error(`editor.kind='custom' requires editor.command in diff.config.json`)
    }
    return {
      kind: 'custom',
      command: editor.command,
      urlScheme: editor.urlScheme ?? null,
    }
  }
  const base = EDITOR_PRESETS[editor.kind]
  return {
    kind: editor.kind,
    command: editor.command ?? base.command,
    urlScheme: editor.urlScheme ?? base.urlScheme,
  }
}

// テスト用に preset table を export (本番コードからは触らない)。
export const __EDITOR_PRESETS_FOR_TEST = EDITOR_PRESETS
