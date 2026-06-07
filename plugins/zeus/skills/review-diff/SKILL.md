---
name: review-diff
description: 直前の staged diff または既存 PR の diff を Linear 風 UI でブラウザに開き、ファイル単位 Reviewed チェック + コメント + Approve/Reject で人間ゲートする最終承認スキル。Approve なら commit に進み、Reject ならコメント反映 → 修正後に Skill ツールで自動再起動。/zeus:review (観点別分析) と責務が違い、こちらは「人間が目で見て承認する」動線
argument-hint: <なし | PR番号>
---

## このスキルの位置付け

`/zeus:review` が **観点別の機械レビュー** (security/logic/performance 等を AI に分析させる) なのに対し、
このスキルは **人間が目で見て最終承認する** ためのゲートです。
diff を Linear 風のローカル UI で開き、ファイル単位 Reviewed チェック + 自由コメント + Approve/Reject を返してもらいます。

## 引数仕様と動作モード

| 呼び出し | モード | 動作 |
|---|---|---|
| `/zeus:review-diff` | staged | `git diff --cached` をレビュー対象にする |
| `/zeus:review-diff 123` | pr | `gh pr diff 123` をレビュー対象にする (PR 番号は整数のみ) |
| `/zeus:review-diff <他>` | error | エラー終了 |

引数判定:
- 引数なし → staged モード
- `^[0-9]+$` にマッチする → pr モード
- それ以外 → エラー終了 (`AskUserQuestion` で意図を確認しても良い)

## ディレクトリ規約

```
.claude/zeus/review-diffs/{YYYYMMDD-HHMMSS}-{slug}/
├── summary.json     ← Write ツールで作成 (heredoc 禁止)
├── diff.patch       ← staged または gh pr diff の出力
├── pr-meta.json     ← PR モードのみ
├── result.json      ← CLI が stdout に出した結果のコピー (CLI 側で自動生成)
└── state.json       ← Reject カウンタ等 ({ "rejectCount": N, "parentDir": "..." })
```

`slug` の決め方:
- staged モード: 変更ファイル名から代表的な 1〜2 個を kebab-case で繋ぐ
- pr モード: `pr-<番号>`

## 使用エージェント

このスキルは **エージェントを起動しない**。
diff から `summary.json` を組み立てる作業はメインエージェント自身が Read + Write で行い、
レビュー UI 部分は同梱 Node CLI (`dist/cli.js`) を Bash 同期実行で立ち上げる。

## 動作原則

- **summary.json は必ず Write ツールで作成する** (Bash heredoc 禁止: `$` 展開や引用符のエスケープ事故を避けるため)
- **git add / git commit / git push は必ず別実行で 1 コマンドずつ** (CLAUDE.md ルール)
- **Reject 連続 3 回でユーザー確認**: rejectCount ≥ 3 になったら `AskUserQuestion` で「続行 / 中止 / 方針見直し」
- **CLI タイムアウトは 9 分** (Bash ツール 10 分制約のため)
- **不明な点は AskUserQuestion で確認** (回数制限なし)

## 実行フロー

### Phase 1: 環境チェック + 引数判定

Bash で以下を確認 (失敗したらエラー終了して理由を表示):

```bash
# Node 20+ 必須 (CLI が node20 ターゲット)
node -v | grep -E '^v(2[0-9]|[3-9][0-9])\.' || { echo "Node 20+ required"; exit 1; }
# git リポジトリ内か
git rev-parse --is-inside-work-tree >/dev/null || { echo "not inside a git repo"; exit 1; }
```

PR モード (`<整数>`) の場合は加えて:

```bash
gh --version >/dev/null || { echo "gh CLI required for PR mode"; exit 1; }
```

staged モードでは空 diff チェック:

```bash
if git diff --cached --quiet; then
  echo "no staged changes"
  exit 1
fi
```

### Phase 2: 作業ディレクトリ + CLI パス解決

```bash
TS=$(date +%Y%m%d-%H%M%S)
# slug は staged なら変更ファイルから代表的な 1〜2 個、pr なら "pr-<N>"
SLUG=...
WORK_DIR=".claude/zeus/review-diffs/${TS}-${SLUG}"
mkdir -p "$WORK_DIR"

# Dogfooding 優先: 現在の git リポが claude-plugins 開発リポ自身なら、
# marketplace.json の存在で識別して、その場で built した dist/cli.js を優先使用。
# これによりローカル変更 (pnpm build 直後) を即反映できる。
# 通常のユーザーは marketplace キャッシュ配下の dist/cli.js を使う。
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
REPO_CLI="${REPO_ROOT}/plugins/zeus/scripts/review-diff/dist/cli.js"
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.claude-plugin/marketplace.json" ] && [ -f "$REPO_CLI" ]; then
  CLI="$REPO_CLI"
else
  # ${CLAUDE_PLUGIN_ROOT} は空のことがあるため、キャッシュ配下で zeus プラグインを ls で探す。
  # owner 名 (cache/<owner>/) は glob で抽象化: marketplace fork や別 owner の配布にも対応するため
  # ハードコードしない。同名 zeus が複数 owner にある場合は最終更新を ls -td で採用。
  ZEUS_DIR=$(ls -td ~/.claude/plugins/cache/*/zeus/*/ 2>/dev/null | head -1)
  CLI="${ZEUS_DIR}scripts/review-diff/dist/cli.js"
fi
[ -f "$CLI" ] || { echo "review-diff CLI not found at $CLI"; exit 1; }
```

### Phase 3: diff 取得

**staged モード**:

```bash
git diff --cached --no-color > "$WORK_DIR/diff.patch"
```

**pr モード**:

```bash
gh pr diff "$PR" --color=never --patch > "$WORK_DIR/diff.patch"
gh pr view "$PR" \
  --json number,title,body,author,baseRefName,headRefName,baseRefOid,headRefOid,headRepository,additions,deletions,changedFiles \
  > "$WORK_DIR/pr-meta.json"
```

`baseRefOid` / `headRefOid` / `headRepository` は **PR モードでの unchanged 行 lazy 展開** に必要。
CLI は `gh api` 経由で base/head SHA の blob を取得して `/source` エンドポイントから返す。
これらフィールドが無い場合は従来通り「Expand unavailable」表示にフォールバックする。

**注意 (GitHub rate limit)**: 1 ファイルあたり 2 回 (`base` + `head`) の `gh api` 呼び出しが走る。
authenticated rate limit は 5000 req/hour なので通常のレビューで枯渇する心配は無いが、
巨大 PR (数百ファイル) を短時間に何本もレビューする場合は気にする。

### Phase 4: サマリ JSON 生成 (Write ツール強制)

1. `diff.patch` を Read で読み込み内容を把握する
2. pr モードなら `pr-meta.json` も Read
3. **`Write` ツールで `summary.json` を作成する** (Bash heredoc は禁止)

`summary.json` のスキーマ:

```json
{
  "mode": "staged",
  "pr": null,
  "overallSummary": "Markdown で書く全体サマリ",
  "groups": [
    {
      "title": "グループタイトル (例: UI 改修)",
      "description": "何をしているグループか 1〜2 文",
      "files": [
        "src/foo.ts",
        { "path": "src/bar.ts", "hunks": [0, 2] }
      ]
    }
  ]
}
```

- `files[]` は **string** で「ファイル全体を含める」、**`{ path, hunks: number[] }`** で
  「該当 hunk index (0-based、parse-git-diff の chunks 順) だけを含める」を指定できる。
- **1 ファイルの変更が複数の目的にまたがる場合は hunks 指定で分割せよ。** 例: `src/api.ts` の
  hunk[0] が「スキーマ刷新」、hunk[1] が「UI 連動の handler 修正」ならそれぞれを別 group に
  振り分けると、レビュアーが各 group のコンテキストで該当 hunk だけを読める。
- pr モードでは `pr` フィールドに `pr-meta.json` の内容をそのまま入れる。
- ファイルを意味的にグルーピングして UI のサイドバーから飛びやすくするのがこの工程の主目的。

### Phase 5: CLI 起動

Bash 同期実行 (timeout 600000ms = 10 分):

```bash
if [ -n "$PR_META" ]; then
  node "$CLI" --summary "$WORK_DIR/summary.json" --diff "$WORK_DIR/diff.patch" --pr-meta "$WORK_DIR/pr-meta.json"
else
  node "$CLI" --summary "$WORK_DIR/summary.json" --diff "$WORK_DIR/diff.patch"
fi
```

- macOS では `open` が自動で立ち上がりブラウザに UI が出る
- CLI stderr に `[review-diff] URL: http://127.0.0.1:<port>/?token=...` が出るので、
  ブラウザが開かない環境ではこの URL を案内する
- CLI 内部タイムアウトは 9 分 (Bash の 10 分より 1 分早く自爆して整合性を取る)
- 終了時に stdout に **1 行の JSON** が出る:
  `{"decision":"approve"|"reject"|"timeout","reviewedFiles":[...],"comments":[...]}`
- `comments[]` の各要素は以下のいずれか:
  - `{ "file": null, "body": "..." }`                              — 全体コメント
  - `{ "file": "path/to/foo.ts", "body": "..." }`                  — ファイル単位コメント
  - `{ "file": "path/to/foo.ts", "body": "...", "line": { "side": "left"|"right", "number": 42 } }` — 行コメント
  - `side` は side-by-side diff の左/右に対応。`left` = before、`right` = after / context

### Phase 6: 結果分岐

stdout の JSON をパースして分岐する。CLI 側で `${WORK_DIR}/result.json` にも自動保存されている。

#### approve

- commit メッセージを diff から生成 (semantic prefix + 簡潔な要約)
- **git add / commit / push は必ず別コマンドで実行** (CLAUDE.md ルール)
- push はユーザーから明示要求がない限りしない

#### reject

1. `state.json` を読んで `rejectCount` を +1 (初回は新規作成)。schema は `{"rejectCount": N, "parentDir": "..."}`
2. UI で集めた `comments` 配列をユーザーに提示し、どの指摘を反映するか合意を取る
3. `rejectCount >= 3` の場合は **必ず `AskUserQuestion`** で「このまま続行 / 中止 / 方針見直し」を聞く
4. 修正実装を行う (大きい変更なら `/zeus:dev` への橋渡しを提案)
5. 修正完了後、`Skill('zeus:review-diff', args)` で自動再起動
   - staged モードなら args は空
   - pr モードなら同じ PR 番号を渡す
   - Skill ツールが使えない環境では `AskUserQuestion` で「もう一度 /zeus:review-diff を手動実行してください」と告げる

#### timeout

`AskUserQuestion` で次のアクションを確認:
- 再 review (もう一度 CLI を起動)
- 修正したい点を聞いてから再開
- 終了

## 不明点があれば AskUserQuestion で聞く

`description` / `groups` の切り方、commit メッセージの prefix、reject 時の修正範囲など、
判断に迷ったら遠慮なく `AskUserQuestion` で選択肢提示形式で確認すること。
