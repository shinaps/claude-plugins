// Vite dev サーバー用のサンプル payload (panel model)。
// 本番は CLI が renderPanel で segments を組み立てるが、dev では手書きで小さい panel を 2-3 件用意する。
// レイアウト / drag-select / split↔unified トグル / Reviewed の確認用。

import type { ClientPayload, SideBySideRow, RenderedPanel } from '@zeus/review-diff-shared'

function ctx(asIsLn: number, toBeLn: number, raw: string): SideBySideRow {
  return {
    asIs: { type: 'context', line: asIsLn, raw },
    toBe: { type: 'context', line: toBeLn, raw },
  }
}
function del(asIsLn: number, raw: string): SideBySideRow {
  return {
    asIs: { type: 'deletion', line: asIsLn, raw },
    toBe: { type: 'empty', raw: '' },
  }
}
function add(toBeLn: number, raw: string): SideBySideRow {
  return {
    asIs: { type: 'empty', raw: '' },
    toBe: { type: 'addition', line: toBeLn, raw },
  }
}

const panelA: RenderedPanel = {
  panelId: 'sample-a',
  intent: 'intent: replace return value',
  asIs: { file: 'src/foo.ts', ranges: [{ start: 1, end: 5 }] },
  toBe: { file: 'src/foo.ts', ranges: [{ start: 1, end: 6 }] },
  asIsLanguage: 'typescript',
  toBeLanguage: 'typescript',
  segments: [{
    asIsRange: { start: 1, end: 5 },
    toBeRange: { start: 1, end: 6 },
    rows: [
      ctx(1, 1, 'export function foo() {'),
      del(2, '  return 1'),
      add(2, '  return 2'),
      add(3, '  // changed'),
      ctx(3, 4, '}'),
      ctx(4, 5, ''),
      ctx(5, 6, 'export const x = 0'),
    ],
  }],
}

const panelB: RenderedPanel = {
  panelId: 'sample-b',
  intent: 'intent: introduce new helper file',
  toBe: { file: 'src/helper.ts', ranges: [{ start: 1, end: 3 }] },
  toBeLanguage: 'typescript',
  segments: [{
    toBeRange: { start: 1, end: 3 },
    rows: [
      add(1, 'export function helper(x: number) {'),
      add(2, '  return x * 2'),
      add(3, '}'),
    ],
  }],
}

export const sampleData: ClientPayload = {
  schemaVersion: 1,
  summary: {
    schemaVersion: 1,
    mode: 'staged',
    pr: null,
    overallSummary: '## Demo\nThis is a development-time sample payload for the panel UI.',
    groups: [
      {
        title: 'Demo Group',
        description: '',
        panels: [
          { panelId: panelA.panelId, intent: panelA.intent, asIs: panelA.asIs, toBe: panelA.toBe },
          { panelId: panelB.panelId, intent: panelB.intent, asIs: panelB.asIs, toBe: panelB.toBe },
        ],
      },
    ],
  },
  prMeta: null,
  groups: [
    {
      groupId: 'g0',
      title: 'Demo Group',
      description: '',
      panels: [panelA, panelB],
    },
  ],
  allPanels: [panelA.panelId, panelB.panelId],
  expandable: true,
  rawPanels: [],
}
