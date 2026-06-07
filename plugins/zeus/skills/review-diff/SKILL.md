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
└── result.json      ← CLI が stdout に出した結果のコピー (CLI 側で自動生成)
```

**Reject カウンタ (rejectCount) はメインエージェントの会話メモリで管理**し、ファイル永続化しない。
1 セッション内で人間ゲートを担うだけなので disk persistence は不要であり、
work-dir を Phase 6 でまるごと削除できるよう設計を単純化した。

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
- **Reject 連続 3 回でユーザー確認**: rejectCount ≥ 3 になったら `AskUserQuestion` で「続行 / 中止 / 方針見直し」(rejectCount はメインエージェントの会話メモリで管理。ファイル永続化はしない)
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

#### 設計哲学 (最重要)

このツールは **AI (= 君) が人間レビュアーに「自分が何をしたか」を引き渡すためのチャネル** である。
レビュアーの読む量を増やすのではなく、**diff の表示そのものを工夫して意味が立ち上がる** ようにする。

具体的には:
- `overallSummary` は **長文で説明しない**。1〜3 文の総括だけ。
- 各 group の `description` も **1〜2 文の短い枠組み説明** に留める。「何を読めば良いか」を解説しない。
- **AI が伝えるべき情報は、ファイル / 範囲 / 順序 で表現する**:
  - どの group にどのファイルが入るか → 論理的な塊
  - 各 group / file 内の順序 → ストーリー順 (因果 / 抽象→具象)
  - `displayRanges` で見せる範囲 → 「変更だけでなく文脈ごと見せたい論理単位」
- 「ここをレビューしてほしい」「ここはリスク高」のような **人間に向けた注釈テキストは書かない**。
  そういう情報はコード自体で語れていなければならない。AI 自身が「読ませないと伝わらない」と
  感じたら、コードのコメント / コミットメッセージ / 構造で伝わるよう実装し直す。

#### スキーマ

```json
{
  "mode": "staged",
  "pr": null,
  "overallSummary": "1〜3 文の総括 (Markdown 可、長文禁止)",
  "groups": [
    {
      "title": "グループタイトル (例: UI 改修)",
      "description": "1〜2 文の枠組み説明",
      "files": [
        "src/foo.ts",
        { "path": "src/bar.ts", "hunks": [0, 2] },
        { "path": "src/baz.ts", "displayRanges": [{ "start": 40, "end": 95 }] }
      ]
    }
  ]
}
```

`files[]` の 3 形式:
- **string** — ファイル全体を含める
- **`{ path, hunks: number[] }`** — parse-git-diff の chunk index で範囲指定 (low-level, 後方互換)
- **`{ path, displayRanges: DisplayRange[] }`** — **推奨**。after 行範囲で「ここを見せて」と意味的に指示
  - `DisplayRange = { start, end }` で 1-based, inclusive
  - 変更行を含まなくてもよい (= 関数全体を context として見せられる)
  - 既存 hunk と被ったら CLI 側で自動 union
  - 隣接 hunk / displayRange の gap が ≤10 行なら **CLI が自動で繋ぐ** (auto-bridge)。
    小さい gap のために `displayRanges` を書く必要は無い。
- displayRanges と hunks は **排他**: 同じファイルに両方書かない。

#### displayRanges を使う判断軸

「変更行だけ見せて意味が通るか?」を 1 ファイルごとに自問する。

- 通るなら → string か hunks のまま
- 通らないなら → **そのファイルだけ Read** して関数 / 論理単位の境界を取り、displayRanges を作る

判断軸:
- changed lines が ≤ 5 で diff の context (-U3) 内に関数シグネチャが見えない → Read 推奨
- hunk が関数の真ん中で唐突に始まっている → Read 推奨
- 1 ファイルに散在する小さい hunk が同じ class / 同じ概念 → まとめて 1 つの displayRange に
- リネームのみ / フォーマットのみ → Read 不要、現状通り
- **全ファイル Read は禁止**: 大規模 PR でトークンが爆発する

#### 順序の使い方 (AI のもう 1 つの語り口)

UI は summary.json の `groups` 順 / `files` 順 / hunk 順 を **そのまま** 表示する。
順序自体が AI からのナラティブ:
- group は「読むべき順番」で並べる (抽象 → 具象、原因 → 結果、コア → 周辺)
- 同じ group 内では「最初に読むべきファイル」を先頭に
- 同じファイル内では現状 hunk は git diff 順 (変更しない)

pr モードでは `pr` フィールドに `pr-meta.json` の内容をそのまま入れる。

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
  - `{ "file": "path/to/foo.ts", "body": "...", "line": { "side": "left"|"right", "number": 42 } }` — 単一行コメント
  - `{ "file": "path/to/foo.ts", "body": "...", "line": { "side": "left"|"right", "number": 42, "endNumber": 58 } }` — 行範囲コメント (number〜endNumber、両端含む)
  - `endNumber` は range の場合のみ含まれる。単一行は `endNumber` フィールドそのものが省略される (number === endNumber を含めない)
  - `side` は side-by-side diff の左/右に対応。`left` = before、`right` = after / context

### Phase 6: 結果分岐

stdout の JSON をパースして分岐する。CLI 側で `${WORK_DIR}/result.json` にも自動保存されている。

#### approve

- commit メッセージを diff から生成 (semantic prefix + 簡潔な要約)
- **git add / commit / push は必ず別コマンドで実行** (CLAUDE.md ルール)
- push はユーザーから明示要求がない限りしない
- commit (+ push) が完了したら **work-dir をクリーンアップ**:
  ```bash
  rm -rf "$WORK_DIR"
  ```
  result.json / summary.json / diff.patch / pr-meta.json 全て不要になっているため。

#### reject

1. **rejectCount をメインの会話メモリで +1** (state.json は使わない)。初回 reject なら 1、2 回目なら 2…
2. UI で集めた `comments` 配列をユーザーに提示し、どの指摘を反映するか合意を取る
3. `rejectCount >= 3` の場合は **必ず `AskUserQuestion`** で「このまま続行 / 中止 / 方針見直し」を聞く
4. 修正実装を行う (大きい変更なら `/zeus:dev` への橋渡しを提案)
5. 修正完了後、Skill 自動再起動の **直前** に work-dir をクリーンアップ:
   ```bash
   rm -rf "$WORK_DIR"
   ```
   再起動された Skill は新しい WORK_DIR を Phase 2 で作るので、古い work-dir を残す必要はない。
6. `Skill('zeus:review-diff', args)` で自動再起動
   - staged モードなら args は空
   - pr モードなら同じ PR 番号を渡す
   - Skill ツールが使えない環境では `AskUserQuestion` で「もう一度 /zeus:review-diff を手動実行してください」と告げる

#### timeout

`AskUserQuestion` で次のアクションを確認:
- 再 review (もう一度 CLI を起動) → **work-dir はそのまま残す** (次の review で同じ diff を使う可能性があるため)
- 修正したい点を聞いてから再開 → 修正後の判断に従う (再 review なら残す / 終了なら削除)
- 終了 → **work-dir をクリーンアップ**:
  ```bash
  rm -rf "$WORK_DIR"
  ```

## 不明点があれば AskUserQuestion で聞く

`description` / `groups` の切り方、commit メッセージの prefix、reject 時の修正範囲など、
判断に迷ったら遠慮なく `AskUserQuestion` で選択肢提示形式で確認すること。
