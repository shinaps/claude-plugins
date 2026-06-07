// Vite dev サーバー用のサンプル payload。
// なぜ手書きハードコード:
//   本番は server-side/diff-parser.ts + Shiki が rows を組み立てるが、dev では
//   Node 依存 (shiki bundle) をブラウザに持ち込みたくないため、ハイライト済み HTML を
//   想定したダミー span を直接書く。レイアウト確認には十分。
//
// シナリオ: monorepo の Todo アプリに「Group に due date を追加」する変更。
//   packages/db (schema migration) → packages/api (endpoint) → packages/ui (component)
//   → infra/docs の 4 グループにまたがる中規模 PR を模す。
//   added / deleted / modified / renamed / binary の全 status を最低 1 件ずつ含める。

import type { ClientPayload, Hunk, ParsedFile, SideBySideRow } from '../../server-side/types.js'

// ---------- row helpers ----------

function ctxRow(leftLn: number, rightLn: number, html: string): SideBySideRow {
  return {
    left: { type: 'context', line: leftLn, html },
    right: { type: 'context', line: rightLn, html },
  }
}

function addRow(rightLn: number, html: string): SideBySideRow {
  return {
    left: { type: 'empty', html: '' },
    right: { type: 'addition', line: rightLn, html },
  }
}

function delRow(leftLn: number, html: string): SideBySideRow {
  return {
    left: { type: 'deletion', line: leftLn, html },
    right: { type: 'empty', html: '' },
  }
}

// 単一 hunk としてまとめるヘルパ。
// oldStart/newStart は rows の最初の行番号から逆算する (簡略化のため、両側に行番号が
// 必ず存在する rows のみを想定。added/deleted ファイルでは片側だけ立てる)。
function singleHunk(rows: SideBySideRow[], opts?: Partial<Pick<Hunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'>>): Hunk {
  return {
    index: 0,
    oldStart: opts?.oldStart ?? 1,
    oldLines: opts?.oldLines ?? rows.length,
    newStart: opts?.newStart ?? 1,
    newLines: opts?.newLines ?? rows.length,
    rows,
  }
}

// Shiki 風の最低限の色付き span。完璧な再現ではなく Linear UI の雰囲気確認用。
const KW = (s: string) => `<span style="color:#79b8ff">${s}</span>`
const STR = (s: string) => `<span style="color:#9ecbff">${s}</span>`
const FN = (s: string) => `<span style="color:#b392f0">${s}</span>`
const CMT = (s: string) => `<span style="color:#6a737d">${s}</span>`
const NUM = (s: string) => `<span style="color:#79b8ff">${s}</span>`
const TXT = (s: string) => `<span style="color:#e1e4e8">${s}</span>`

// ---------- file 1: SQL migration (added, group 1) ----------

const migrationSqlRows: SideBySideRow[] = [
  addRow(1, `${CMT('-- 0042_add_due_dates.sql')}`),
  addRow(2, `${CMT('-- Add due_type / due_date to todo_groups, backfill existing rows.')}`),
  addRow(3, ``),
  addRow(4, `${KW('ALTER TABLE')} ${TXT('todo_groups')}`),
  addRow(5, `  ${KW('ADD COLUMN')} ${TXT('due_type')} ${KW('TEXT')} ${KW('NOT NULL')} ${KW('DEFAULT')} ${STR("'none'")},`),
  addRow(6, `  ${KW('ADD COLUMN')} ${TXT('due_date')} ${KW('TIMESTAMPTZ')};`),
  addRow(7, ``),
  addRow(8, `${KW('UPDATE')} ${TXT('todo_groups')} ${KW('SET')} ${TXT('due_type')} = ${STR("'none'")} ${KW('WHERE')} ${TXT('due_type')} ${KW('IS NULL')};`),
  addRow(9, ``),
  addRow(10, `${KW('ALTER TABLE')} ${TXT('todo_groups')}`),
  addRow(11, `  ${KW('ADD CONSTRAINT')} ${TXT('todo_groups_due_type_check')}`),
  addRow(12, `  ${KW('CHECK')} (${TXT('due_type')} ${KW('IN')} (${STR("'none'")}, ${STR("'asap'")}, ${STR("'date'")}));`),
  addRow(13, ``),
  addRow(14, `${KW('ALTER TABLE')} ${TXT('todo_groups')}`),
  addRow(15, `  ${KW('ADD CONSTRAINT')} ${TXT('todo_groups_due_date_when_date')}`),
  addRow(16, `  ${KW('CHECK')} (`),
  addRow(17, `    (${TXT('due_type')} = ${STR("'date'")} ${KW('AND')} ${TXT('due_date')} ${KW('IS NOT NULL')})`),
  addRow(18, `    ${KW('OR')} (${TXT('due_type')} <> ${STR("'date'")} ${KW('AND')} ${TXT('due_date')} ${KW('IS NULL')})`),
  addRow(19, `  );`),
  addRow(20, ``),
  addRow(21, `${KW('CREATE INDEX')} ${TXT('idx_todo_groups_due_date')}`),
  addRow(22, `  ${KW('ON')} ${TXT('todo_groups')} (${TXT('due_date')})`),
  addRow(23, `  ${KW('WHERE')} ${TXT('due_date')} ${KW('IS NOT NULL')};`),
  addRow(24, ``),
  addRow(25, `${CMT('-- Drop the legacy single-column constraint that conflated type + date.')}`),
  addRow(26, `${KW('ALTER TABLE')} ${TXT('todo_groups')}`),
  addRow(27, `  ${KW('DROP CONSTRAINT IF EXISTS')} ${TXT('todo_groups_legacy_due_check')};`),
  addRow(28, ``),
]

const migrationSql: ParsedFile = {
  path: 'packages/db/migrations/0042_add_due_dates.sql',
  status: 'added',
  language: 'sql',
  additions: 28,
  deletions: 0,
  totalLines: migrationSqlRows.length,
  hunks: [singleHunk(migrationSqlRows, { oldStart: 0, oldLines: 0, newStart: 1, newLines: 28 })],
}

// ---------- file 2: drizzle schema (modified, group 1) ----------

const todosSchemaRows: SideBySideRow[] = [
  ctxRow(1, 1, `${KW('import')} { ${TXT('pgTable, text, timestamp, uuid')} } ${KW('from')} ${STR("'drizzle-orm/pg-core'")}`),
  ctxRow(2, 2, ``),
  ctxRow(3, 3, `${KW('export const')} ${FN('todoGroups')} = ${FN('pgTable')}(${STR("'todo_groups'")}, {`),
  ctxRow(4, 4, `  ${TXT('id:')} ${FN('uuid')}(${STR("'id'")}).${FN('primaryKey')}().${FN('defaultRandom')}(),`),
  ctxRow(5, 5, `  ${TXT('title:')} ${FN('text')}(${STR("'title'")}).${FN('notNull')}(),`),
  delRow(6, `  ${TXT('dueAt:')} ${FN('timestamp')}(${STR("'due_at'")}, { ${TXT('withTimezone:')} ${KW('true')} }),`),
  delRow(7, `  ${CMT('// legacy: due_at was used for both ASAP markers and absolute dates.')}`),
  delRow(8, `  ${CMT('// New rows must use due_type + due_date instead.')}`),
  addRow(6, `  ${TXT('dueType:')} ${FN('text')}(${STR("'due_type'")}, { ${TXT('enum:')} [${STR("'none'")}, ${STR("'asap'")}, ${STR("'date'")}] })`),
  addRow(7, `    .${FN('notNull')}()`),
  addRow(8, `    .${FN('default')}(${STR("'none'")}),`),
  addRow(9, `  ${TXT('dueDate:')} ${FN('timestamp')}(${STR("'due_date'")}, { ${TXT('withTimezone:')} ${KW('true')} }),`),
  ctxRow(9, 10, `  ${TXT('createdAt:')} ${FN('timestamp')}(${STR("'created_at'")}).${FN('defaultNow')}().${FN('notNull')}(),`),
  ctxRow(10, 11, `})`),
  ctxRow(11, 12, ``),
  ctxRow(12, 13, `${KW('export type')} ${TXT('TodoGroup')} = ${KW('typeof')} ${TXT('todoGroups.$inferSelect')}`),
  addRow(14, `${KW('export type')} ${TXT('TodoGroupDueType')} = ${TXT('TodoGroup')}[${STR("'dueType'")}]`),
  addRow(15, ``),
  addRow(16, `${KW('export const')} ${FN('DUE_TYPES')} = [${STR("'none'")}, ${STR("'asap'")}, ${STR("'date'")}] ${KW('as const')}`),
  ctxRow(13, 17, ``),
  ctxRow(14, 18, `${KW('export const')} ${FN('todoItems')} = ${FN('pgTable')}(${STR("'todo_items'")}, {`),
  ctxRow(15, 19, `  ${CMT('// unchanged below')}`),
  ctxRow(16, 20, `})`),
]

const todosSchema: ParsedFile = {
  path: 'packages/db/src/schema/todos.ts',
  status: 'modified',
  language: 'typescript',
  additions: 9,
  deletions: 3,
  totalLines: todosSchemaRows.length,
  hunks: [singleHunk(todosSchemaRows, { oldStart: 1, oldLines: 16, newStart: 1, newLines: 20 })],
}

// ---------- file 3: snapshot JSON (binary, group 1) ----------

const snapshotJson: ParsedFile = {
  path: 'packages/db/migrations/meta/0042_snapshot.json',
  status: 'binary',
  language: 'json',
  additions: 0,
  deletions: 0,
  totalLines: 0,
  hunks: [],
}

// ---------- file 4: API route (modified, hunks split across 2 groups) ----------
// 目的別ファイル分割のデモ:
//   hunk[0]: GroupPatch スキーマ刷新 (API エンドポイント変更 group 行き)
//   hunk[1]: PATCH handler の dueDate null 化処理 (UI 関連の振る舞いだが、API ファイルにある)
// hunks 間に 73 行の unchanged ギャップを意図的に空け、staged モードでないため
// 「⇕ 73 unchanged lines (Expand unavailable in PR mode)」バナーが出る確認に使う。

const apiTodosHunk0Rows: SideBySideRow[] = [
  ctxRow(1, 1, `${KW('import')} { ${TXT('Hono')} } ${KW('from')} ${STR("'hono'")}`),
  ctxRow(2, 2, `${KW('import')} { ${TXT('z')} } ${KW('from')} ${STR("'zod'")}`),
  delRow(3, `${KW('import')} { ${TXT('todoGroups')} } ${KW('from')} ${STR("'@app/db/schema'")}`),
  addRow(3, `${KW('import')} { ${TXT('todoGroups, DUE_TYPES')} } ${KW('from')} ${STR("'@app/db/schema'")}`),
  addRow(4, `${KW('import')} { ${TXT('TodoGroup')} } ${KW('from')} ${STR("'@app/shared/types/todo'")}`),
  ctxRow(4, 5, ``),
  ctxRow(5, 6, `${KW('export const')} ${FN('todosRouter')} = ${KW('new')} ${FN('Hono')}()`),
  ctxRow(6, 7, ``),
  delRow(7, `${KW('const')} ${FN('GroupPatch')} = ${TXT('z.object')}({`),
  delRow(8, `  ${TXT('title:')} ${TXT('z.string().min(1).optional()')},`),
  delRow(9, `  ${TXT('dueAt:')} ${TXT('z.string().datetime().nullable().optional()')},`),
  delRow(10, `})`),
  addRow(8, `${KW('const')} ${FN('GroupPatch')} = ${TXT('z.object')}({`),
  addRow(9, `  ${TXT('title:')} ${TXT('z.string().min(1).optional()')},`),
  addRow(10, `  ${TXT('dueType:')} ${TXT('z.enum(DUE_TYPES).optional()')},`),
  addRow(11, `  ${TXT('dueDate:')} ${TXT('z.string().datetime().nullable().optional()')},`),
  addRow(12, `}).${FN('refine')}(`),
  addRow(13, `  ${TXT('(v)')} => ${TXT('v.dueType !== ')}${STR("'date'")} ${TXT('|| v.dueDate != null')},`),
  addRow(14, `  ${TXT('{ message:')} ${STR("'dueDate required when dueType=date'")} ${TXT('}')}`),
  addRow(15, `)`),
]

// hunk[1] は hunk[0] の末尾 (newEnd=15) から 73 行飛ばした位置に置く。
// → hunk[1].newStart = 15 + 73 + 1 = 89, hunk[1].oldStart = 10 + 73 + 1 = 84
const apiTodosHunk1Rows: SideBySideRow[] = [
  ctxRow(84, 89, ``),
  ctxRow(85, 90, `${TXT('todosRouter')}.${FN('patch')}(${STR("'/groups/:id'")}, ${KW('async')} ${TXT('(c) =>')} {`),
  ctxRow(86, 91, `  ${KW('const')} ${TXT('body = GroupPatch.parse(await c.req.json())')}`),
  ctxRow(87, 92, `  ${CMT('// db update omitted for brevity')}`),
  addRow(93, `  ${CMT('// When dueType switches away from "date", null out dueDate to satisfy the CHECK constraint.')}`),
  addRow(94, `  ${KW('if')} ${TXT('(body.dueType && body.dueType !== ')}${STR("'date'")}${TXT(') body.dueDate = null')}`),
  ctxRow(88, 95, `  ${KW('return')} ${TXT('c.json({ ok: ')}${KW('true')}${TXT(' })')}`),
  ctxRow(89, 96, `})`),
]

const apiTodos: ParsedFile = {
  path: 'packages/api/src/routes/todos.ts',
  status: 'modified',
  language: 'typescript',
  additions: 18,
  deletions: 6,
  totalLines: apiTodosHunk0Rows.length + apiTodosHunk1Rows.length,
  hunks: [
    {
      index: 0,
      oldStart: 1,
      oldLines: 10,
      newStart: 1,
      newLines: 15,
      rows: apiTodosHunk0Rows,
    },
    {
      index: 1,
      oldStart: 84,
      oldLines: 6,
      newStart: 89,
      newLines: 8,
      rows: apiTodosHunk1Rows,
    },
  ],
}

// ---------- file 5: API test (modified, group 2) ----------

const apiTodosTestRows: SideBySideRow[] = [
  ctxRow(1, 1, `${KW('import')} { ${TXT('describe, it, expect')} } ${KW('from')} ${STR("'vitest'")}`),
  ctxRow(2, 2, `${KW('import')} { ${TXT('app')} } ${KW('from')} ${STR("'../app.js'")}`),
  ctxRow(3, 3, ``),
  ctxRow(4, 4, `${FN('describe')}(${STR("'PATCH /groups/:id'")}, () => {`),
  delRow(5, `  ${FN('it')}(${STR("'updates dueAt'")}, ${KW('async')} () => {`),
  delRow(6, `    ${KW('const')} ${TXT('res = await app.request(')}${STR("'/groups/g1'")}${TXT(', {')}`),
  delRow(7, `      ${TXT('method:')} ${STR("'PATCH'")},`),
  delRow(8, `      ${TXT('body: JSON.stringify({ dueAt:')} ${STR("'2026-07-01T00:00:00Z'")} ${TXT('})')},`),
  addRow(5, `  ${FN('it')}(${STR("'accepts dueType=date with dueDate'")}, ${KW('async')} () => {`),
  addRow(6, `    ${KW('const')} ${TXT('res = await app.request(')}${STR("'/groups/g1'")}${TXT(', {')}`),
  addRow(7, `      ${TXT('method:')} ${STR("'PATCH'")},`),
  addRow(8, `      ${TXT('body: JSON.stringify({')}`),
  addRow(9, `        ${TXT('dueType:')} ${STR("'date'")},`),
  addRow(10, `        ${TXT('dueDate:')} ${STR("'2026-07-01T00:00:00Z'")},`),
  addRow(11, `      ${TXT('})')},`),
  ctxRow(9, 12, `    })`),
  ctxRow(10, 13, `    ${FN('expect')}(${TXT('res.status')}).${FN('toBe')}(${NUM('200')})`),
  ctxRow(11, 14, `  })`),
  addRow(15, ``),
  addRow(16, `  ${FN('it')}(${STR("'rejects dueType=date without dueDate'")}, ${KW('async')} () => {`),
  addRow(17, `    ${KW('const')} ${TXT('res = await app.request(')}${STR("'/groups/g1'")}${TXT(', {')}`),
  addRow(18, `      ${TXT('method:')} ${STR("'PATCH'")},`),
  addRow(19, `      ${TXT('body: JSON.stringify({ dueType:')} ${STR("'date'")} ${TXT('})')},`),
  addRow(20, `    })`),
  addRow(21, `    ${FN('expect')}(${TXT('res.status')}).${FN('toBe')}(${NUM('400')})`),
  addRow(22, `  })`),
  ctxRow(12, 23, `})`),
]

const apiTodosTest: ParsedFile = {
  path: 'packages/api/src/routes/todos.test.ts',
  status: 'modified',
  language: 'typescript',
  additions: 14,
  deletions: 4,
  totalLines: apiTodosTestRows.length,
  hunks: [singleHunk(apiTodosTestRows, { oldStart: 1, oldLines: 12, newStart: 1, newLines: 23 })],
}

// ---------- file 6: renamed type (group 2) ----------

const renamedTypeRows: SideBySideRow[] = [
  ctxRow(1, 1, `${KW('export type')} ${TXT('TodoGroup')} = {`),
  ctxRow(2, 2, `  ${TXT('id:')} ${KW('string')}`),
  ctxRow(3, 3, `  ${TXT('title:')} ${KW('string')}`),
  delRow(4, `  ${TXT('dueAt:')} ${KW('string')} | ${KW('null')}`),
  addRow(4, `  ${TXT('dueType:')} ${STR("'none'")} | ${STR("'asap'")} | ${STR("'date'")}`),
  addRow(5, `  ${TXT('dueDate:')} ${KW('string')} | ${KW('null')}`),
  ctxRow(5, 6, `  ${TXT('createdAt:')} ${KW('string')}`),
  ctxRow(6, 7, `}`),
  ctxRow(7, 8, ``),
  addRow(9, `${KW('export type')} ${TXT('TodoGroupDueType')} = ${TXT('TodoGroup')}[${STR("'dueType'")}]`),
  addRow(10, ``),
  ctxRow(8, 11, `${KW('export type')} ${TXT('TodoItem')} = { ${TXT('id:')} ${KW('string')}; ${TXT('text:')} ${KW('string')}; ${TXT('done:')} ${KW('boolean')} }`),
  ctxRow(9, 12, ``),
]

const renamedType: ParsedFile = {
  path: 'packages/shared/src/types/todo.ts',
  oldPath: 'packages/api/src/types/todo.ts',
  status: 'renamed',
  language: 'typescript',
  additions: 4,
  deletions: 1,
  totalLines: renamedTypeRows.length,
  hunks: [singleHunk(renamedTypeRows, { oldStart: 1, oldLines: 9, newStart: 1, newLines: 12 })],
}

// ---------- file 7: TodoItem.tsx (modified, group 3) ----------

const todoItemTsxRows: SideBySideRow[] = [
  ctxRow(1, 1, `${KW('import')} { ${TXT('useState')} } ${KW('from')} ${STR("'react'")}`),
  delRow(2, `${KW('import')} { ${TXT('LegacyDatePicker')} } ${KW('from')} ${STR("'./LegacyDatePicker.js'")}`),
  addRow(2, `${KW('import')} { ${TXT('DueDatePicker')} } ${KW('from')} ${STR("'./DueDatePicker.js'")}`),
  addRow(3, `${KW('import')} ${KW('type')} { ${TXT('TodoGroup, TodoGroupDueType')} } ${KW('from')} ${STR("'@app/shared/types/todo'")}`),
  ctxRow(3, 4, ``),
  ctxRow(4, 5, `${KW('type')} ${TXT('Props')} = {`),
  delRow(5, `  ${TXT('group: { id:')} ${KW('string')}${TXT('; title:')} ${KW('string')}${TXT('; dueAt:')} ${KW('string')} | ${KW('null')} ${TXT('}')}`),
  addRow(6, `  ${TXT('group:')} ${TXT('TodoGroup')}`),
  addRow(7, `  ${TXT('onChange:')} (${TXT('patch:')} ${TXT('Partial<TodoGroup>')}) => ${KW('void')}`),
  ctxRow(6, 8, `}`),
  ctxRow(7, 9, ``),
  delRow(8, `${KW('export function')} ${FN('TodoItem')}({ ${TXT('group')} }: ${TXT('Props')}) {`),
  delRow(9, `  ${KW('const')} ${TXT('[date, setDate] = useState(group.dueAt)')}`),
  delRow(10, `  ${KW('const')} ${FN('onPick')} = (${TXT('d:')} ${KW('string')} | ${KW('null')}) => ${TXT('setDate(d)')}`),
  addRow(10, `${KW('export function')} ${FN('TodoItem')}({ ${TXT('group, onChange')} }: ${TXT('Props')}) {`),
  addRow(11, `  ${KW('const')} ${TXT('[dueType, setDueType] = useState<TodoGroupDueType>(group.dueType)')}`),
  addRow(12, `  ${KW('const')} ${TXT('[dueDate, setDueDate] = useState(group.dueDate)')}`),
  addRow(13, ``),
  addRow(14, `  ${CMT('// Single change handler so the parent only sees one update per interaction;')}`),
  addRow(15, `  ${CMT('// avoids the flicker we had when dueType and dueDate updated in separate renders.')}`),
  addRow(16, `  ${KW('const')} ${FN('commit')} = (${TXT('next: { dueType: TodoGroupDueType; dueDate: string | null }')}) => {`),
  addRow(17, `    ${FN('setDueType')}(${TXT('next.dueType')})`),
  addRow(18, `    ${FN('setDueDate')}(${TXT('next.dueDate')})`),
  addRow(19, `    ${FN('onChange')}(${TXT('next')})`),
  addRow(20, `  }`),
  ctxRow(11, 21, ``),
  ctxRow(12, 22, `  ${KW('return')} (`),
  ctxRow(13, 23, `    <${TXT('div')} ${TXT('className=')}${STR('"todo-item"')}>`),
  ctxRow(14, 24, `      <${TXT('span')}>{${TXT('group.title')}}</${TXT('span')}>`),
  delRow(15, `      <${TXT('LegacyDatePicker')} ${TXT('value=')}{${TXT('date')}} ${TXT('onChange=')}{${TXT('onPick')}} />`),
  addRow(25, `      <${TXT('DueDatePicker')}`),
  addRow(26, `        ${TXT('dueType=')}{${TXT('dueType')}}`),
  addRow(27, `        ${TXT('dueDate=')}{${TXT('dueDate')}}`),
  addRow(28, `        ${TXT('onChange=')}{${TXT('commit')}}`),
  addRow(29, `      />`),
  ctxRow(16, 30, `    </${TXT('div')}>`),
  ctxRow(17, 31, `  )`),
  ctxRow(18, 32, `}`),
]

const todoItemTsx: ParsedFile = {
  path: 'packages/ui/src/components/TodoItem.tsx',
  status: 'modified',
  language: 'tsx',
  additions: 22,
  deletions: 11,
  totalLines: todoItemTsxRows.length,
  hunks: [singleHunk(todoItemTsxRows, { oldStart: 1, oldLines: 18, newStart: 1, newLines: 32 })],
}

// ---------- file 8: DueDatePicker.tsx (added, group 3, large) ----------

const dueDatePickerRows: SideBySideRow[] = []
{
  const lines: string[] = [
    `${KW('import')} { ${TXT('useId, useState')} } ${KW('from')} ${STR("'react'")}`,
    `${KW('import')} ${KW('type')} { ${TXT('TodoGroupDueType')} } ${KW('from')} ${STR("'@app/shared/types/todo'")}`,
    ``,
    `${KW('type')} ${TXT('Props')} = {`,
    `  ${TXT('dueType:')} ${TXT('TodoGroupDueType')}`,
    `  ${TXT('dueDate:')} ${KW('string')} | ${KW('null')}`,
    `  ${TXT('onChange:')} (${TXT('next: { dueType: TodoGroupDueType; dueDate: string | null }')}) => ${KW('void')}`,
    `}`,
    ``,
    `${CMT('// Tri-state picker: none / asap / date.')}`,
    `${CMT('// Why tri-state instead of nullable date:')}`,
    `${CMT('//   product wants "ASAP" (urgent but undated) distinguishable from "no due date set".')}`,
    `${CMT('//   Encoding both as null forced ambiguous UI states; making the type explicit avoids that.')}`,
    `${KW('export function')} ${FN('DueDatePicker')}({ ${TXT('dueType, dueDate, onChange')} }: ${TXT('Props')}) {`,
    `  ${KW('const')} ${TXT('groupName = useId()')}`,
    `  ${KW('const')} ${TXT('[localDate, setLocalDate] = useState(dueDate ?? ')}${STR("''")}${TXT(')')}`,
    ``,
    `  ${KW('const')} ${FN('pick')} = (${TXT('next:')} ${TXT('TodoGroupDueType')}) => {`,
    `    ${KW('if')} (${TXT('next === ')}${STR("'date'")}) {`,
    `      ${KW('const')} ${TXT('iso = localDate || new Date().toISOString()')}`,
    `      ${FN('setLocalDate')}(${TXT('iso')})`,
    `      ${FN('onChange')}({ ${TXT('dueType: ')}${STR("'date'")}${TXT(', dueDate: iso')} })`,
    `      ${KW('return')}`,
    `    }`,
    `    ${FN('onChange')}({ ${TXT('dueType: next, dueDate:')} ${KW('null')} })`,
    `  }`,
    ``,
    `  ${KW('const')} ${FN('onDateInput')} = (${TXT('e:')} ${TXT('React.ChangeEvent<HTMLInputElement>')}) => {`,
    `    ${KW('const')} ${TXT('iso = new Date(e.target.value).toISOString()')}`,
    `    ${FN('setLocalDate')}(${TXT('iso')})`,
    `    ${FN('onChange')}({ ${TXT('dueType: ')}${STR("'date'")}${TXT(', dueDate: iso')} })`,
    `  }`,
    ``,
    `  ${KW('return')} (`,
    `    <${TXT('fieldset')} ${TXT('className=')}${STR('"due-date-picker"')}>`,
    `      <${TXT('legend')}>${TXT('Due date')}</${TXT('legend')}>`,
    `      {(${TXT("['none', 'asap', 'date'] as const")}).${FN('map')}((${TXT('opt')}) => (`,
    `        <${TXT('label')} ${TXT('key=')}{${TXT('opt')}}>`,
    `          <${TXT('input')}`,
    `            ${TXT('type=')}${STR('"radio"')}`,
    `            ${TXT('name=')}{${TXT('groupName')}}`,
    `            ${TXT('checked=')}{${TXT('dueType === opt')}}`,
    `            ${TXT('onChange=')}{() => ${FN('pick')}(${TXT('opt')})}`,
    `          />`,
    `          {${TXT('opt')}}`,
    `        </${TXT('label')}>`,
    `      ))}`,
    `      {${TXT('dueType === ')}${STR("'date'")} && (`,
    `        <${TXT('input')}`,
    `          ${TXT('type=')}${STR('"datetime-local"')}`,
    `          ${TXT('value=')}{${TXT('localDate.slice(0, 16)')}}`,
    `          ${TXT('onChange=')}{${TXT('onDateInput')}}`,
    `        />`,
    `      )}`,
    `    </${TXT('fieldset')}>`,
    `  )`,
    `}`,
    ``,
  ]
  for (let i = 0; i < lines.length; i++) {
    dueDatePickerRows.push(addRow(i + 1, lines[i]))
  }
}

const dueDatePicker: ParsedFile = {
  path: 'packages/ui/src/components/DueDatePicker.tsx',
  status: 'added',
  language: 'tsx',
  additions: dueDatePickerRows.length,
  deletions: 0,
  totalLines: dueDatePickerRows.length,
  hunks: [singleHunk(dueDatePickerRows, { oldStart: 0, oldLines: 0, newStart: 1, newLines: dueDatePickerRows.length })],
}

// ---------- file 9: LegacyDatePicker.tsx (deleted, group 3) ----------

const legacyPickerRows: SideBySideRow[] = []
{
  const lines: string[] = [
    `${KW('import')} { ${TXT('useState')} } ${KW('from')} ${STR("'react'")}`,
    ``,
    `${KW('type')} ${TXT('Props')} = {`,
    `  ${TXT('value:')} ${KW('string')} | ${KW('null')}`,
    `  ${TXT('onChange:')} (${TXT('next:')} ${KW('string')} | ${KW('null')}) => ${KW('void')}`,
    `}`,
    ``,
    `${KW('export function')} ${FN('LegacyDatePicker')}({ ${TXT('value, onChange')} }: ${TXT('Props')}) {`,
    `  ${KW('const')} ${TXT('[local, setLocal] = useState(value ?? ')}${STR("''")}${TXT(')')}`,
    `  ${KW('return')} (`,
    `    <${TXT('input')}`,
    `      ${TXT('type=')}${STR('"date"')}`,
    `      ${TXT('value=')}{${TXT('local')}}`,
    `      ${TXT('onChange=')}{(${TXT('e')}) => {`,
    `        ${FN('setLocal')}(${TXT('e.target.value')})`,
    `        ${FN('onChange')}(${TXT('e.target.value || ')}${KW('null')}${TXT(')')})`,
    `      }}`,
    `    />`,
    `  )`,
    `}`,
    ``,
  ]
  for (let i = 0; i < lines.length; i++) {
    legacyPickerRows.push(delRow(i + 1, lines[i]))
  }
}

const legacyPicker: ParsedFile = {
  path: 'packages/ui/src/components/LegacyDatePicker.tsx',
  status: 'deleted',
  language: 'tsx',
  additions: 0,
  deletions: legacyPickerRows.length,
  totalLines: legacyPickerRows.length,
  hunks: [singleHunk(legacyPickerRows, { oldStart: 1, oldLines: legacyPickerRows.length, newStart: 0, newLines: 0 })],
}

// ---------- file 10: docker-compose.yml (modified, group 4) ----------

const dockerComposeRows: SideBySideRow[] = [
  ctxRow(1, 1, `${TXT('services:')}`),
  ctxRow(2, 2, `  ${TXT('db:')}`),
  delRow(3, `    ${TXT('image: postgres:15')}`),
  addRow(3, `    ${TXT('image: postgres:16')}`),
  ctxRow(4, 4, `    ${TXT('environment:')}`),
  ctxRow(5, 5, `      ${TXT('POSTGRES_PASSWORD: dev')}`),
  ctxRow(6, 6, `    ${TXT('ports:')} [${STR('"5432:5432"')}]`),
  addRow(7, `    ${TXT('volumes:')}`),
  addRow(8, `      ${TXT('- pgdata:/var/lib/postgresql/data')}`),
  ctxRow(7, 9, `  ${TXT('api:')}`),
  delRow(8, `    ${TXT('build: ../packages/api')}`),
  addRow(10, `    ${TXT('build:')}`),
  addRow(11, `      ${TXT('context: ..')}`),
  addRow(12, `      ${TXT('dockerfile: packages/api/Dockerfile')}`),
  ctxRow(9, 13, `    ${TXT('depends_on:')} [${STR('db')}]`),
  ctxRow(10, 14, ``),
  addRow(15, `${TXT('volumes:')}`),
  addRow(16, `  ${TXT('pgdata:')}`),
]

const dockerCompose: ParsedFile = {
  path: 'infra/docker-compose.yml',
  status: 'modified',
  language: 'yaml',
  additions: 6,
  deletions: 2,
  totalLines: dockerComposeRows.length,
  hunks: [singleHunk(dockerComposeRows, { oldStart: 1, oldLines: 10, newStart: 1, newLines: 16 })],
}

// ---------- file 11: Dockerfile (modified, group 4) ----------

const dockerfileRows: SideBySideRow[] = [
  delRow(1, `${KW('FROM')} ${TXT('node:20-alpine')}`),
  addRow(1, `${KW('FROM')} ${TXT('node:22-alpine')}`),
  ctxRow(2, 2, `${KW('WORKDIR')} ${TXT('/app')}`),
  delRow(3, `${KW('COPY')} ${TXT('package*.json ./')}`),
  addRow(3, `${KW('COPY')} ${TXT('pnpm-lock.yaml package.json ./')}`),
  addRow(4, `${KW('RUN')} ${TXT('corepack enable && pnpm install --frozen-lockfile')}`),
  ctxRow(4, 5, `${KW('COPY')} ${TXT('. .')}`),
  ctxRow(5, 6, `${KW('RUN')} ${TXT('pnpm build')}`),
  ctxRow(6, 7, `${KW('CMD')} [${STR('"node"')}, ${STR('"dist/server.js"')}]`),
]

const dockerfile: ParsedFile = {
  path: 'Dockerfile',
  status: 'modified',
  language: 'dockerfile',
  additions: 3,
  deletions: 2,
  totalLines: dockerfileRows.length,
  hunks: [singleHunk(dockerfileRows, { oldStart: 1, oldLines: 6, newStart: 1, newLines: 7 })],
}

// ---------- file 12: README.md (modified, group 4) ----------

const readmeRows: SideBySideRow[] = [
  ctxRow(1, 1, `${TXT('# Todo App')}`),
  ctxRow(2, 2, ``),
  ctxRow(3, 3, `${TXT('A small monorepo for managing todo groups.')}`),
  ctxRow(4, 4, ``),
  ctxRow(5, 5, `${TXT('## Features')}`),
  ctxRow(6, 6, ``),
  ctxRow(7, 7, `${TXT('- Group todos by topic')}`),
  delRow(8, `${TXT('- Optional single due date per group')}`),
  addRow(8, `${TXT('- Tri-state due date per group: none / ASAP / specific date')}`),
  addRow(9, `${TXT('- Constraint-backed schema (Postgres CHECK) so invalid states are rejected at the DB layer')}`),
  ctxRow(9, 10, ``),
  ctxRow(10, 11, `${TXT('## Getting started')}`),
  ctxRow(11, 12, ``),
  delRow(12, `${TXT('    npm install && npm run dev')}`),
  addRow(13, `${TXT('    pnpm install')}`),
  addRow(14, `${TXT('    pnpm --filter @app/db migrate')}`),
  addRow(15, `${TXT('    pnpm dev')}`),
  ctxRow(13, 16, ``),
  ctxRow(14, 17, `${TXT('## Packages')}`),
  addRow(18, ``),
  addRow(19, `${TXT('- `@app/db`     — drizzle schema + migrations')}`),
  addRow(20, `${TXT('- `@app/api`    — Hono routes')}`),
  addRow(21, `${TXT('- `@app/ui`     — React components')}`),
  addRow(22, `${TXT('- `@app/shared` — types shared across packages')}`),
]

const readme: ParsedFile = {
  path: 'README.md',
  status: 'modified',
  language: 'markdown',
  additions: 11,
  deletions: 2,
  totalLines: readmeRows.length,
  hunks: [singleHunk(readmeRows, { oldStart: 1, oldLines: 14, newStart: 1, newLines: 22 })],
}

// ---------- file 13: pnpm-lock.yaml (binary, group 4) ----------

const pnpmLock: ParsedFile = {
  path: 'pnpm-lock.yaml',
  status: 'binary',
  language: 'yaml',
  additions: 897,
  deletions: 0,
  totalLines: 0,
  hunks: [],
}

// ---------- assemble ----------

const allFiles: ParsedFile[] = [
  migrationSql,
  todosSchema,
  snapshotJson,
  apiTodos,
  apiTodosTest,
  renamedType,
  todoItemTsx,
  dueDatePicker,
  legacyPicker,
  dockerCompose,
  dockerfile,
  readme,
  pnpmLock,
]

const overallSummary = `## Todo Group に期日を追加する

Group に期日を持たせるため、\`todo_groups\` テーブルに \`due_type\` と \`due_date\` カラムを追加する。マイグレーションでは既存行を \`due_type='none'\` でバックフィルし、期日種別と期日値のバリデーションを分離するため CHECK 制約を作り直している。

API と UI も追従:

- API: 既存の \`/api/todos/groups/:id\` エンドポイントで due フィールドを返す。\`dueType='date'\` のときに \`dueDate\` が無いケースを弾く Zod refinement を追加
- UI: 旧 \`LegacyDatePicker\` を廃止し、3 値 (\`none\` / \`asap\` / \`date\`) の \`DueDatePicker\` に差し替え
- テスト: \`asap\` / \`date\` / \`none\` の 3 状態を全てカバー

共有 \`TodoGroup\` 型は \`@app/api\` から新設の \`@app/shared\` パッケージに移動。UI が API 内部実装を直接参照する依存を解消した。

> [!NOTE]
> 旧 \`todo_groups_legacy_due_check\` 制約を drop している。API をリリースした後で適用すること。古い API コードが \`due_at\` を直接書き込むと新しい CHECK で失敗する。
`

export const sampleData: ClientPayload = {
  prMeta: null,
  allFiles: allFiles.map((f) => f.path),
  // expandable: false にして「Expand unavailable in PR mode」バナー表示の確認に使う。
  // (実機の staged モードでは CLI 側が true を渡してくる)
  expandable: false,
  summary: {
    mode: 'staged',
    pr: null,
    overallSummary,
    groups: [
      {
        title: 'DB スキーマ migration',
        description:
          '`todo_groups` に `due_type` + `due_date` カラムを追加し、既存行をバックフィル。期日種別と期日値を分離する CHECK 制約に組み直して、旧来の複合 CHECK を置き換える。',
        files: [migrationSql.path, todosSchema.path, snapshotJson.path],
      },
      {
        title: 'API エンドポイント変更',
        description:
          '`/groups/:id` の PATCH 入力スキーマを 3 値ステート対応に刷新。Zod refinement で `dueType=date` のときに `dueDate` 必須を強制し、共有 `TodoGroup` 型を `@app/shared` パッケージに移動。',
        // apiTodos は hunks[0] (GroupPatch スキーマ刷新) だけをここに振り分ける。
        // hunks[1] (PATCH handler の dueDate null 化) は次の UI 関連 group へ。
        files: [
          { path: apiTodos.path, hunks: [0] },
          apiTodosTest.path,
          renamedType.path,
        ],
      },
      {
        title: 'UI コンポーネント刷新',
        description:
          '旧 `LegacyDatePicker` を廃止し、3 値 (none / asap / date) の `DueDatePicker` に差し替え。`TodoItem` から両フィールドを一括 commit する形にしてレンダリングのちらつきを抑える。API 側の PATCH handler でも UI 起点の dueDate null 化を入れている。',
        files: [
          todoItemTsx.path,
          dueDatePicker.path,
          legacyPicker.path,
          // 同じ apiTodos の hunks[1] だけをこちらに振り分けて「目的別ファイル分割」を実演。
          { path: apiTodos.path, hunks: [1] },
        ],
      },
      {
        title: 'インフラ & ドキュメント',
        description:
          'Postgres 16 にアップグレード、Docker image を pnpm ベースに切り替え、`@app/shared` パッケージの説明と getting-started を README に反映。',
        files: [dockerCompose.path, dockerfile.path, readme.path, pnpmLock.path],
      },
    ],
  },
  files: allFiles,
}
