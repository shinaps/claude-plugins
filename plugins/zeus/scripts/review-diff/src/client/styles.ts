// review-diff UI のスタイル定義。
// なぜ独立ファイル:
//   本番ビルドは template.ts から import してインライン <style> として配信する一方、
//   Vite dev サーバーでは dev-entry.tsx から動的に <style> 注入してホットリロード時にも
//   同じ見た目を再現したい。CSS を 1 箇所に集約しておかないと dev / 本番で乖離する。
//
// レイアウト方針 (Linear Guide タブ風):
//   - body は単一の縦スクロールコンテナ。全グループのファイル diff が連続して並ぶ
//   - 各 GroupSection は CSS Grid (左 nav 320px + 右 content) で構成され、左 nav は
//     セクション内で sticky。スクロールが「次のグループ」に入ると左 nav が次セクションに
//     差し替わるため、IntersectionObserver でアクティブグループを追跡する必要は無い。
//   - 上部 TabBar と右下 ActionBar は position: fixed / sticky で常時表示。

export const CSS_STRING = `
:root {
  --background: #0a0a0d;
  --surface: #16161a;
  --surface-2: #1c1c22;
  --surface-3: #232329;
  --border: #2a2d3a;
  --border-soft: #1f2230;
  --text: #ffffff;
  --text-muted: #a0a4b0;
  --text-dim: #5a5d6a;
  --accent: #7170ff;
  --accent-soft: rgba(113, 112, 255, 0.14);
  --success: #4ade80;
  --danger: #f87171;
  --warn: #fbbf24;
  --add-bg: rgba(74, 222, 128, 0.10);
  --add-strong: rgba(74, 222, 128, 0.22);
  --add-fg: #86efac;
  --del-bg: rgba(248, 113, 113, 0.10);
  --del-strong: rgba(248, 113, 113, 0.22);
  --del-fg: #fca5a5;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--background);
  color: var(--text);
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
body { min-height: 100vh; }
#root { min-height: 100vh; display: flex; flex-direction: column; }

/* ---------- Top TabBar ---------- */
.tabbar {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 24px;
  background: rgba(10, 10, 13, 0.85);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border-soft);
}
.tab {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-dim);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease;
}
.tab:hover:not(:disabled) { color: var(--text-muted); background: var(--surface); }
.tab.active { color: var(--text); background: var(--surface-2); }
.tab:disabled { cursor: not-allowed; opacity: 0.45; }
.tabbar-meta { margin-left: auto; font-size: 11px; color: var(--text-dim); font-family: ui-monospace, monospace; }

/* ---------- Page Header (overall summary) ---------- */
.page-header {
  max-width: 1480px;
  margin: 0 auto;
  padding: 32px 24px 8px;
  width: 100%;
}
.page-header h1 { margin: 0 0 8px; font-size: 26px; font-weight: 600; letter-spacing: -0.01em; }
.page-header .meta { color: var(--text-muted); font-size: 12px; margin-bottom: 20px; font-family: ui-monospace, monospace; }
.page-header .markdown {
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.65;
  max-width: 760px;
}
.page-header .markdown h1, .page-header .markdown h2, .page-header .markdown h3 { color: var(--text); margin-top: 16px; margin-bottom: 8px; }
.page-header .markdown h2 { font-size: 18px; }
.page-header .markdown h3 { font-size: 15px; }
.page-header .markdown a { color: var(--accent); text-decoration: none; }
.page-header .markdown a:hover { text-decoration: underline; }
.page-header .markdown code { background: var(--surface-2); padding: 1px 6px; border-radius: 4px; font-size: 12px; font-family: ui-monospace, monospace; }
.page-header .markdown pre { background: var(--surface); padding: 12px 14px; border-radius: 8px; overflow-x: auto; border: 1px solid var(--border-soft); }
.page-header .markdown blockquote { border-left: 3px solid var(--accent); padding: 4px 12px; margin: 12px 0; color: var(--text-muted); background: var(--accent-soft); border-radius: 4px; }
.page-header .markdown ul, .page-header .markdown ol { padding-left: 22px; }
.page-header .markdown li { margin: 4px 0; }

/* ---------- Group Sections ---------- */
.groups-container {
  max-width: 1480px;
  margin: 0 auto;
  width: 100%;
  padding: 0 24px 200px;
  flex: 1;
}
.group-section {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 32px;
  padding: 56px 0;
  border-top: 1px solid var(--border-soft);
  position: relative;
}
.group-section:first-of-type { border-top: none; padding-top: 32px; }

/* Left nav: sticky inside the section so it floats with content */
.group-nav {
  position: sticky;
  top: 64px;
  align-self: start;
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  padding-right: 8px;
}
.group-nav::-webkit-scrollbar { width: 4px; }
.group-nav::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.group-number {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: 0.08em;
  margin-bottom: 12px;
}
.group-number .total { color: var(--text-dim); }
.group-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 14px;
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.group-desc {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 20px;
}
.group-desc code { background: var(--surface-2); padding: 1px 5px; border-radius: 3px; font-size: 12px; font-family: ui-monospace, monospace; color: var(--text); }
.group-desc a { color: var(--accent); text-decoration: none; }
.group-desc p { margin: 0 0 8px; }
.group-desc p:last-child { margin-bottom: 0; }

.group-file-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 16px;
  border-top: 1px solid var(--border-soft);
}
.group-file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
  width: 100%;
  font-size: 12px;
  transition: background 120ms ease, color 120ms ease;
}
.group-file-item:hover { background: var(--surface); color: var(--text); }
.group-file-item .file-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--text-dim);
  opacity: 0.8;
}
.group-file-item .file-name {
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}
.group-file-item .file-dir {
  color: var(--text-dim);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.group-file-item .stat-add { color: var(--add-fg); font-family: ui-monospace, monospace; font-size: 11px; }
.group-file-item .stat-del { color: var(--del-fg); font-family: ui-monospace, monospace; font-size: 11px; margin-left: 4px; }
.group-file-item.reviewed .file-name { color: var(--text-dim); text-decoration: line-through; }

/* ---------- File Block (right column) ---------- */
.group-files-column { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.file-block {
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  overflow: hidden;
  scroll-margin-top: 72px;
}
.file-block-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-soft);
  font-size: 12px;
}
.file-block-header .file-icon { color: var(--text-dim); width: 14px; height: 14px; flex-shrink: 0; }
.file-block-header .file-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-block-header .file-path .dir { color: var(--text-dim); }
.file-block-header .file-path .rename { color: var(--text-dim); }
.file-block-header .badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--surface-3);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 500;
}
.file-block-header .badge-added { color: var(--add-fg); background: var(--add-bg); }
.file-block-header .badge-deleted { color: var(--del-fg); background: var(--del-bg); }
.file-block-header .badge-renamed { color: var(--accent); background: var(--accent-soft); }
.file-block-header .badge-binary { color: var(--warn); background: rgba(251, 191, 36, 0.12); }
.file-block-header .stats { font-family: ui-monospace, monospace; font-size: 11px; }
.file-block-header .stats .add { color: var(--add-fg); }
.file-block-header .stats .del { color: var(--del-fg); margin-left: 6px; }
.file-block-header .reviewed-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  font-size: 11px;
  font-weight: 500;
  background: transparent;
  transition: color 120ms, background 120ms;
}
.file-block-header .reviewed-toggle:hover { color: var(--text); background: var(--surface-3); }
.file-block-header .reviewed-toggle input { appearance: none; width: 12px; height: 12px; border: 1.5px solid var(--text-dim); border-radius: 3px; margin: 0; position: relative; cursor: pointer; }
.file-block-header .reviewed-toggle input:checked { background: var(--success); border-color: var(--success); }
.file-block-header .reviewed-toggle input:checked::after {
  content: '';
  position: absolute;
  inset: 0;
  background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path fill='none' stroke='%230a0a0d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='M3 6.5L5 8.5L9 4'/></svg>") center / 10px no-repeat;
}
.file-block-header .reviewed-toggle.is-reviewed { color: var(--success); }
.file-block-header .menu-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
  width: 26px;
  height: 24px;
  border-radius: 6px;
  cursor: pointer;
  line-height: 1;
  font-size: 14px;
}
.file-block-header .menu-btn:hover { background: var(--surface-3); color: var(--text); }

.file-block .warning {
  padding: 8px 14px;
  background: rgba(251, 191, 36, 0.08);
  color: var(--warn);
  font-size: 11px;
  border-bottom: 1px solid var(--border-soft);
}
.file-block .binary-notice {
  padding: 28px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  font-family: ui-monospace, monospace;
}

/* ---------- Diff table ---------- */
.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  table-layout: fixed;
  background: var(--surface);
}
.diff-table td { padding: 0 10px; vertical-align: top; line-height: 1.55; }
.diff-table td.ln {
  width: 52px;
  text-align: right;
  color: var(--text-dim);
  user-select: none;
  background: var(--surface);
  border-right: 1px solid var(--border-soft);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  position: relative;
  padding-right: 10px;
}
.diff-table td.code {
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: break-word;
  color: var(--text);
}
.diff-table td.code pre {
  margin: 0;
  background: transparent !important;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  white-space: pre-wrap;
  word-break: break-all;
}
.diff-table td.code-addition { background: var(--add-bg); }
.diff-table td.code-deletion { background: var(--del-bg); }
.diff-table td.code-empty { background: rgba(255,255,255,0.015); }
.diff-table td.ln.ln-addition { background: var(--add-bg); color: var(--add-fg); }
.diff-table td.ln.ln-deletion { background: var(--del-bg); color: var(--del-fg); }

/* ---------- Line comment trigger (Linear / GitHub PR 風) ---------- */
/* gutter セル内に絶対配置で「+」ボタンを置き、行 hover 時のみ薄く可視化する。
   ボタン自身の hover で完全不透明 + accent 背景 にして、明確にクリック可能と分かるようにする。
   pointer-events: none ではダメ (クリックさせたい) なので opacity でフェード制御する。 */
.diff-table td.ln { position: relative; }
.line-comment-trigger {
  position: absolute;
  right: -10px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  z-index: 2;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  transition: opacity 100ms ease, transform 100ms ease;
}
.diff-table tr.code-row:hover .line-comment-trigger { opacity: 0.85; }
.line-comment-trigger:hover { opacity: 1; transform: translateY(-50%) scale(1.08); }
.line-comment-trigger:focus-visible { opacity: 1; outline: 2px solid var(--accent-soft); outline-offset: 1px; }

/* ---------- Inline comment row (吹き出し + フォーム) ---------- */
.diff-table tr.comment-row > td {
  /* code 部分の padding を打ち消して、内側のスレッド領域が全幅で並ぶようにする */
  padding: 0;
  background: var(--surface-2);
  border-top: 1px solid var(--border-soft);
  border-bottom: 1px solid var(--border-soft);
}
.comment-thread {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 18px 10px 56px;
  /* gutter (52px) と少し揃えるためのオフセット。完全一致ではなく、視覚的に右寄せに見える程度 */
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.5;
}
.comment-bubble {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-left: 2px solid var(--accent);
  border-radius: 8px;
  padding: 12px 16px;
  color: var(--text);
  font-size: 13px;
}
.comment-bubble .comment-body {
  white-space: pre-wrap;
  word-break: break-word;
}
.comment-bubble .comment-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 100ms ease;
}
.comment-bubble:hover .comment-actions,
.comment-bubble:focus-within .comment-actions { opacity: 1; }
.comment-action-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 5px;
  cursor: pointer;
  font-family: inherit;
  transition: background 100ms ease, color 100ms ease;
}
.comment-action-btn:hover { background: var(--surface-3); color: var(--text); }
.comment-action-danger:hover { color: var(--danger); border-color: rgba(248, 113, 113, 0.4); }

.comment-bubble.is-editing { padding: 10px 12px; }

.comment-form {
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-left: 2px solid var(--accent);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.comment-textarea {
  width: 100%;
  min-height: 70px;
  background: var(--background);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
  transition: border-color 100ms ease;
}
.comment-textarea:focus { border-color: var(--accent); }
.comment-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.comment-btn {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background 100ms ease, border-color 100ms ease;
}
.comment-btn-cancel { background: transparent; color: var(--text-muted); }
.comment-btn-cancel:hover { background: var(--surface-3); color: var(--text); }
.comment-btn-save {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.comment-btn-save:hover { filter: brightness(1.08); }

.unchanged-banner {
  padding: 8px 14px;
  background: var(--surface-2);
  color: var(--text-dim);
  font-size: 11px;
  text-align: center;
  border-top: 1px solid var(--border-soft);
  border-bottom: 1px solid var(--border-soft);
  cursor: default;
  font-family: ui-monospace, monospace;
}

/* ---------- comment area ---------- */
.comment-block {
  padding: 12px 14px;
  border-top: 1px solid var(--border-soft);
  background: var(--surface);
}
.file-comment, .global-comment {
  width: 100%;
  min-height: 60px;
  background: var(--background);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 12px;
  resize: vertical;
  outline: none;
  transition: border-color 120ms ease;
}
.file-comment:focus, .global-comment:focus { border-color: var(--accent); }

/* ---------- floating action bar ---------- */
.action-bar {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.3);
}
.action-bar .progress {
  font-size: 11px;
  color: var(--text-muted);
  margin-right: 4px;
  font-family: ui-monospace, monospace;
}
.action-bar .btn {
  padding: 7px 12px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text);
  border-radius: 7px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: background 120ms, border-color 120ms;
}
.action-bar .btn:hover { background: var(--surface-3); }
.action-bar .btn-approve { background: rgba(74, 222, 128, 0.15); border-color: rgba(74, 222, 128, 0.4); color: var(--add-fg); }
.action-bar .btn-approve:hover { background: rgba(74, 222, 128, 0.22); }
.action-bar .btn-reject { background: rgba(248, 113, 113, 0.12); border-color: rgba(248, 113, 113, 0.35); color: var(--del-fg); }
.action-bar .btn-reject:hover { background: rgba(248, 113, 113, 0.2); }

.global-comment-block {
  max-width: 760px;
  margin: 32px auto 16px;
  padding: 0 24px;
}
.global-comment-block label { display: block; font-size: 11px; color: var(--text-dim); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.06em; }

.done { padding: 80px 24px; text-align: center; font-size: 18px; color: var(--text); width: 100%; }
.toast {
  position: fixed;
  bottom: 80px;
  right: 24px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 12px;
  z-index: 50;
}

@media (max-width: 1000px) {
  .group-section { grid-template-columns: 1fr; gap: 24px; }
  .group-nav { position: static; max-height: none; }
}

[hidden] { display: none !important; }
`
