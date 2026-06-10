// summary.json (panel schema) の検証 + panelId 補完 + 重複 suffix 付与。
//
// 設計判断:
//   - 過去バージョンの SKILL.md 手順で生成された legacy 形式 (groups[].files: GroupFileRef[]) は
//     今も入力されうるため明示的に reject し、現行形式 (SKILL.md Phase 4) へ誘導する
//     移行メッセージを stderr に出す。zod に任せると「該当 field がない」という機械的エラーに
//     しかならず誘導文を出せないため、zod 前に手書きの detectLegacy で先回り判定する。
//   - panelId の自動生成は intent を含めない sha1({asIs, toBe}).slice(0,10)。
//     context+ / context- 再生成で intent 文を書き直しても、asIs/toBe が同じなら ID 不変
//     → ブラウザの draft (sessionStorage) と reviewed state が維持される (FR-9 / AC-9 系の要請)。
//   - 同 sanitized ID が複数 panel に付与された場合は fail せず -1, -2 ... の suffix を付ける。
//     これは「同じ asIs/toBe 範囲を 2 つの panel が別 intent で参照する」運用 (推奨はしないが許容) と、
//     AI が偶然衝突 ID を書いてしまうケースを丸ごと吸収するため。
//   - panelId 正規表現は ASCII 英数字 + 空白 + _ + - を許可、空白は - に sanitize。
//     lineCommentKey で \x1f を区切り文字に使うので、key 内に \x1f が混入する余地を作らない。

import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Panel, SummaryJson } from '@zeus/review-diff-shared'

const DisplayRangeSchema = z
  .object({
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  })
  .refine(r => r.end >= r.start, { message: 'end must be >= start' })

const PanelSideSchema = z.object({
  file: z.string().min(1),
  ranges: z.array(DisplayRangeSchema).min(1),
})

// 空文字は CLI が hash で自動生成する余地として許容する。
const PanelIdSchema = z.string().regex(/^[A-Za-z0-9 _-]*$/, {
  message: 'panelId must match /^[A-Za-z0-9 _-]*$/ (letters, digits, space, underscore, hyphen, or empty for auto-generation)',
})

// panel.intent: 1 panel 内変更の見出し。UI ヘッダ 2 行内に収めるための長さ制限。
// 詳細は group.description / overallSummary に書き分けるよう運用で誘導する。
const PANEL_INTENT_MAX = 100

const PanelSchema = z
  .object({
    panelId: PanelIdSchema,
    intent: z.string().min(1).max(PANEL_INTENT_MAX, {
      message: `intent must be at most ${PANEL_INTENT_MAX} characters (keep it short; put detail in group.description / overallSummary)`,
    }),
    asIs: PanelSideSchema.optional(),
    toBe: PanelSideSchema.optional(),
  })
  .refine(p => p.asIs != null || p.toBe != null, {
    message: 'panel must have at least one of asIs / toBe',
  })

const GroupSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  panels: z.array(PanelSchema).min(1),
})

const SummarySchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(['staged', 'pr']),
  pr: z.unknown().nullable(),
  overallSummary: z.string(),
  groups: z.array(GroupSchema),
})

export type LegacyDetection = { legacy: boolean; reasons: string[] }

// 旧 schema 検出: groups[].files (GroupFileRef[]) が存在すれば旧 schema と確定する。
// schemaVersion 不在も追加サインだが、zod fail で十分検出できるため legacy 判定の主因にはしない。
export function detectLegacy(raw: unknown): LegacyDetection {
  if (typeof raw !== 'object' || raw === null) return { legacy: false, reasons: [] }
  const r = raw as Record<string, unknown>
  const reasons: string[] = []
  const groupsRaw = Array.isArray(r.groups) ? (r.groups as unknown[]) : []
  for (const g of groupsRaw) {
    if (typeof g !== 'object' || g === null) continue
    const gr = g as Record<string, unknown>
    if (Array.isArray(gr.files) && gr.files.length > 0) {
      const title = typeof gr.title === 'string' ? gr.title : '<untitled>'
      reasons.push(`group "${title}" has legacy "files" field`)
    }
  }
  return { legacy: reasons.length > 0, reasons }
}

export type ValidatedSummary = { summary: SummaryJson }

export function validateSummarySchema(raw: unknown): ValidatedSummary {
  const legacy = detectLegacy(raw)
  if (legacy.legacy) {
    const detail = legacy.reasons.map(r => `  - ${r}`).join('\n')
    throw new SchemaError(
      'summary.json is in legacy format and is no longer supported by /zeus:review-diff.\n' +
      `Detected legacy fields:\n${detail}\n\n` +
      'Migration: replace "groups[].files: GroupFileRef[]" with "groups[].panels: Panel[]" ' +
      '(see plugins/zeus/skills/review-diff/SKILL.md Phase 4 for the new schema).\n',
    )
  }
  const parsed = SummarySchema.safeParse(raw)
  if (!parsed.success) throw new SchemaError(formatZodError(parsed.error))

  // panelId 補完 + sanitize + 重複 suffix。
  // seen は sanitized ID → 出現回数。0 回目は suffix 無し、以降は -1, -2 ...
  const seen = new Map<string, number>()
  const groups = parsed.data.groups.map(g => ({
    ...g,
    panels: g.panels.map(p => {
      const trimmed = (p.panelId ?? '').trim()
      const sanitized = trimmed === ''
        ? computePanelId(p as Panel)
        : trimmed.replace(/\s+/g, '-')
      const count = seen.get(sanitized) ?? 0
      seen.set(sanitized, count + 1)
      const panelId = count === 0 ? sanitized : `${sanitized}-${count}`
      return { ...p, panelId }
    }),
  }))
  return { summary: { ...parsed.data, groups } as SummaryJson }
}

// intent を含めずに asIs/toBe だけを hash 対象にする。
// → context+/- で intent 文だけが書き換わっても ID が変わらず、
//    UI 側の draft / reviewed state が panel に対して維持される。
function computePanelId(p: Pick<Panel, 'asIs' | 'toBe'>): string {
  const key = JSON.stringify({ asIs: p.asIs ?? null, toBe: p.toBe ?? null })
  return 'p-' + createHash('sha1').update(key).digest('hex').slice(0, 10)
}

function formatZodError(err: z.ZodError): string {
  return 'summary.json schema validation failed:\n' +
    err.issues.map(i => `  - ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n')
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaError'
  }
}
