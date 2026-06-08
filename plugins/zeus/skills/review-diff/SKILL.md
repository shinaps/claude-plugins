---
name: review-diff
description: 直前の staged diff または既存 PR の diff を Linear 風 UI (split mode) でブラウザに開き、panel 単位 Reviewed チェック + コメント + Approve/Reject で人間ゲートする最終承認スキル。Approve なら commit に進み、Reject ならコメント反映 → Skill ツールで自動再起動。context+ ボタンは close-relaunch + state restore モデルで Reviewed / line comments / 未保存 draft を再起動後に復元。/zeus:review (観点別分析) と責務が違い、こちらは「人間が目で見て承認する」動線
argument-hint: <なし | PR番号>
---

## このスキルの位置付け

`/zeus:review` が **観点別の機械レビュー** (security/logic/performance 等を AI に分析させる) なのに対し、
このスキルは **人間が目で見て最終承認する** ためのゲートです。
diff を Linear 風のローカル UI で開き、panel 単位 Reviewed チェック + 自由コメント + Approve/Reject を返してもらいます。

レビュー単位は **panel** です。1 つの「変更の意味的単位 = panel」が:
- `intent` (どんな意図の変更か、1 行)
- `asIs` (変更前: ファイル + 行範囲集合)
- `toBe` (変更後: ファイル + 行範囲集合)

を持つ最小ユニットになっており、git の hunk より粗くも細かくもなれ、cross-file 移動も 1 panel で表現できます。
表示は split mode (左右並列) 固定、context+ ボタンは close-relaunch + state restore モデルで動作します。

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
└── restore.json     ← regen-group 後の再起動で前回 state を復元するための中間 JSON
```

**Reject カウンタ (rejectCount) はメインエージェントの会話メモリで管理**し、ファイル永続化しない。
**regen-group カウンタ (regenCount) も同様に会話メモリで管理**し、5 回到達で AskUserQuestion で確認。

`slug` の決め方:
- staged モード: 変更ファイル名から代表的な 1〜2 個を kebab-case で繋ぐ
- pr モード: `pr-<番号>`

## 使用エージェント

このスキルは **エージェントを起動しない**。
diff から `summary.json` を組み立てる作業はメインエージェント自身が Read + Write で行い、
レビュー UI 部分は同梱 Node CLI (`dist/cli.js`) を Bash 同期実行で立ち上げる。

## 動作原則

- **summary.json は必ず Write ツールで作成する** (Bash heredoc 禁止: `$` 展開や引用符のエスケープ事故を避ける)
- **git add / git commit / git push は必ず別実行で 1 コマンドずつ** (CLAUDE.md ルール)
- **Reject 連続 3 回でユーザー確認**: rejectCount ≥ 3 になったら `AskUserQuestion` で「続行 / 中止 / 方針見直し」
- **regen-group 連続 5 回でユーザー確認**: regenCount ≥ 5 で `AskUserQuestion` (無限再生成防止)
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
authenticated rate limit は 5000 req/hour なので通常のレビューで枯渇する心配は無い。

### Phase 4: サマリ JSON 生成 (Write ツール強制)

1. `diff.patch` を Read で読み込み内容を把握する
2. pr モードなら `pr-meta.json` も Read
3. **`Write` ツールで `summary.json` を作成する** (Bash heredoc は禁止)

#### 設計哲学 (最重要)

このツールは **AI (= 君) が人間レビュアーに「自分が何をしたか」を引き渡すためのチャネル** である。
レビュアーの読む量を増やすのではなく、**panel の境界と並び順で意味が立ち上がる** ようにする。

具体的には:
- `overallSummary` は **長文で説明しない**。1〜3 文の総括だけ。
- 各 group の `description` も **1〜2 文の短い枠組み説明** に留める。「何を読めば良いか」を解説しない。
- **AI が伝えるべき情報は、panel の切り方 / 順序 / intent 文 で表現する**:
  - 1 group = 1 つの「章」、その中の panels = 「節」の感覚
  - `intent` は 1 行で、その panel が「何を意図した変更か」を素直に書く (実装の説明ではなく **意図** を書く)
  - `asIs` / `toBe` の `ranges` で「変更だけでなく文脈ごと見せたい論理単位」を切り取る
- 「ここをレビューしてほしい」「ここはリスク高」のような **人間に向けた注釈テキストは書かない**。
  そういう情報はコード自体で語れていなければならない。

#### スキーマ

```json
{
  "schemaVersion": 1,
  "mode": "staged",
  "pr": null,
  "overallSummary": "1〜3 文の総括 (Markdown 可、長文禁止)",
  "groups": [
    {
      "title": "型刷新",
      "description": "panel スキーマ導入",
      "panels": [
        {
          "panelId": "types-asis-tobe",
          "intent": "DisplayRange を panel ベースに置換",
          "asIs": {
            "file": "packages/shared/src/types.ts",
            "ranges": [{ "start": 70, "end": 110 }]
          },
          "toBe": {
            "file": "packages/shared/src/types.ts",
            "ranges": [{ "start": 70, "end": 130 }]
          }
        }
      ]
    }
  ]
}
```

- `schemaVersion` は **必ず `1`**
- `panels[]` は **最低 1 つ**
- 各 `panel` は `asIs` か `toBe` の **少なくとも一方** が必須 (両方欠落不可)

#### panel の切り方

- **関数 / 論理ブロック境界まで広げる**: 関数の途中で切らない。長すぎる関数 (>200 行) のみ例外的に途中分割
- **同一 file でも intent が違えば別 panel**: 「型定義の更新」と「型を使う側の修正」が同じ file にあっても別 panel
- **cross-file 移動**: `foo()` を `a.ts` → `b.ts` に移動なら `asIs.file=a.ts`, `toBe.file=b.ts` で 1 panel
- **cross-file 異言語** (`.js` → `.ts` 移行など) も OK: CLI が両側別言語で syntax highlight する
- **asIs だけ / toBe だけ を恐れない**: 純粋追加・純粋削除も明示的に 1 panel
- **context-only panel も OK**: 不変だが説明に必要な領域 (= ranges が変更行を含まなくてもよい)

#### ranges は実測必須 (概算禁止)

`asIs.ranges` / `toBe.ranges` を書く前に、**対象ファイルを Read で開いて論理ブロックの開始行と終端行を実測** してから数値を入れる。

- ❌ NG パターン: 「diff の変更行 (±N 行) を概算で広めに切る」「頭の中で行ずれを推測する」
- ✅ OK パターン: Read で「テーブルが何行目から何行目まで」「関数 header が何行目で、closing brace が何行目」を確認した上で range を決める

理由: `intent` がレビュアーに伝わるかどうかは **その range の中で意味が完結しているか** で決まる。テーブルから 1 行削除する panel で、テーブル header しか含まれなかったら、レビュアーは「そのファイルが結局どんなテーブルになったか」を読み取れず reject される。**変更後 (toBe) の range は特に実測必須**: 行ずれで終端が切れやすい。

行数が増減する変更では、asIs と toBe で同じ行番号にはならない。両側それぞれを Read で測ること。

#### 1 変更 = 1 intent (discourage rule)

同じ `asIs` 範囲を複数 panel で参照することは **許容するが推奨しない**。1 つの変更に対し 1 つの intent を割り当てる。
複数 panel で参照したい場合は CLI 側で panelId 重複を検出して自動で `-1`, `-2` の suffix を付ける (失敗にはしない)。

#### panelId の規約

- **省略可**: 書かないと CLI がコンテンツ hash (`asIs` + `toBe` のみを対象、`intent` は除外) で `p-<hex10>` を自動生成
- intent を hash 対象から外しているため、context+ 再生成で intent を書き直しても **panelId は不変**。draft コメントや Reviewed state が維持される
- **安定性を取りたいなら明示**: `"refactor-foo-helper"` のような短い意味のある ID を書く
- 使える文字: `^[A-Za-z0-9 _-]+$` (英数字 + 空白 + アンダースコア + ハイフン)。空白は CLI が `-` に自動正規化
- 同じ ID を 2 つの panel に付けると CLI が自動で `-1`, `-2` の suffix を付ける (warn は出ない)

#### 網羅性厳格 (AC-3)

全 panel の `asIs.ranges` (before 軸) / `toBe.ranges` (after 軸) を union したものが、
`git diff` の **変更行集合** を完全に包含していないと **CLI が non-zero で exit する**。
stderr に漏れたファイル + 行範囲 + (rename 時には) 修正提案が表示される。

```
Coverage validation failed. The following changes are not carried by any panel:
  packages/foo/bar.ts [toBe]: 12-15, 22
  packages/foo/old.ts [asIs]: 10-25
    ↳ This file was renamed from "packages/foo/old.ts" to "packages/foo/new.ts".
      Did you mean to set asIs.file = "packages/foo/old.ts" and toBe.file = "packages/foo/new.ts"?

Fix: extend asIs.ranges / toBe.ranges (or add a panel covering the file) in summary.json.
```

注意点:
- **rename + 内容変更** の panel は `asIs.file = oldPath`, `toBe.file = newPath` で書く (asIs/toBe を逆に書くと rename サジェストが出る)
- **binary / rename-only / mode-only** 変更は「ファイル言及だけ」検証される (行 ranges は不要)
- **EOL-only 変更** (末尾改行のみ) は warn が出るが fail しない (実用上意味がない粒度)

#### 順序の使い方

UI は summary.json の `groups[]` 順 / 各 group 内の `panels[]` 順 を **そのまま** 表示する。
順序自体が AI からのナラティブ:
- group は「読むべき順番」で並べる (抽象 → 具象、原因 → 結果、コア → 周辺)
- 同じ group 内では「最初に読むべき panel」を先頭に

pr モードでは `pr` フィールドに `pr-meta.json` の内容をそのまま入れる。

### Phase 5: CLI 起動

Bash 同期実行 (timeout 600000ms = 10 分):

```bash
# 通常起動 (初回 or rejectループ)
if [ -n "$PR_META" ]; then
  node "$CLI" --summary "$WORK_DIR/summary.json" --diff "$WORK_DIR/diff.patch" --pr-meta "$WORK_DIR/pr-meta.json"
else
  node "$CLI" --summary "$WORK_DIR/summary.json" --diff "$WORK_DIR/diff.patch"
fi

# regen-group 後の再起動の場合は --restore-state を追加
# (Phase 6 の regen-group 分岐から自動的にここに戻ってくる)
node "$CLI" --summary "$WORK_DIR/summary.json" --diff "$WORK_DIR/diff.patch" --restore-state "$WORK_DIR/restore.json"
```

CLI の挙動:
- macOS では `open` が自動で立ち上がりブラウザに UI が出る
- stderr に `[review-diff] URL: http://127.0.0.1:<port>/?token=...` が出るので、ブラウザが開かない環境ではこの URL を案内する
- CLI 内部タイムアウトは 9 分 (Bash の 10 分より 1 分早く自爆して整合性を取る)
- 終了時に stdout に **1 行の JSON** が出る:
  `{"decision":"approve"|"reject"|"timeout"|"regen-group", ...}`

#### Comment / Result shape

`comments[]` の各要素は scope union 構造:
- `{ "body": "...", "scope": { "type": "overall" } }` — 全体コメント
- `{ "body": "...", "scope": { "type": "line", "panelId": "...", "side": "asIs"|"toBe", "file": "path/to/foo.ts", "line": 42 } }` — 単一行コメント
- `{ "body": "...", "scope": { "type": "line", "panelId": "...", "side": "asIs"|"toBe", "file": "path/to/foo.ts", "line": 42, "endLine": 58 } }` — 行範囲コメント

ResultJson 全体:
```json
{
  "decision": "approve" | "reject" | "timeout" | "regen-group",
  "reviewedPanels": ["panel-id-1", "panel-id-2"],
  "comments": [ /* 上記 shape */ ],
  "regenGroup": {            // decision='regen-group' の時のみ
    "groupId": "g2",
    "currentRanges": [ { "panelId": "...", "asIs": {...}, "toBe": {...} } ]
  },
  "lineCommentDrafts": {      // regen-group の時に restore で活きる、それ以外は無視可
    "draft:p1:asis:42": "draft body..."
  }
}
```

注意:
- 記録単位は **`reviewedPanels`** (panelId ベース)
- 行コメントの side は **`asIs` / `toBe`** (camelCase)
- 行コメントの `file` は panel の対応する側 (`asIs.file` または `toBe.file`) を自動で入れる

### Phase 6: 結果分岐

stdout の JSON をパースして `decision` で分岐する。CLI 側で `${WORK_DIR}/result.json` にも自動保存されている。

#### approve

- commit メッセージを diff から生成 (semantic prefix + 簡潔な要約)
- **git add / commit / push は必ず別コマンドで実行** (CLAUDE.md ルール)
- push はユーザーから明示要求がない限りしない
- commit (+ push) が完了したら **work-dir をクリーンアップ**:
  ```bash
  rm -rf "$WORK_DIR"
  ```

#### reject

1. **rejectCount をメインの会話メモリで +1** (state.json は使わない)
2. UI で集めた `comments` 配列をユーザーに提示し、どの指摘を反映するか合意を取る
3. `rejectCount >= 3` の場合は **必ず `AskUserQuestion`** で「このまま続行 / 中止 / 方針見直し」を聞く
4. 修正実装を行う (大きい変更なら `/zeus:dev` への橋渡しを提案)
5. 修正完了後、Skill 自動再起動の **直前** に work-dir をクリーンアップ:
   ```bash
   rm -rf "$WORK_DIR"
   ```
6. `Skill('zeus:review-diff', args)` で自動再起動
   - staged モードなら args は空
   - pr モードなら同じ PR 番号を渡す
   - Skill ツールが使えない環境では `AskUserQuestion` で「もう一度 /zeus:review-diff を手動実行してください」と告げる

#### regen-group

ブラウザの context+ ボタン押下で `decision: 'regen-group'` が返る。これは「現在の group の context が
狭すぎる、もっと広げて見たい」という人間からのリクエスト。close-relaunch + state restore で対応する。

手順:

1. **regenCount をメインの会話メモリで +1**。`regenCount >= 5` なら **AskUserQuestion** で
   「このまま広げ続ける / 中止して再起動なし / 方針見直し」を聞き、停止判断を仰ぐ (無限再生成防止)。
2. `result.json` から `regenGroup.groupId` と `regenGroup.currentRanges` を取得。
3. **work-dir はクリーンアップしない** (summary.json / diff.patch は再利用、restore.json を作る)。
4. **summary.json を Read → 該当 group の panels[] を再生成** して Write:
   - `currentRanges` を参考に、各 panel の `asIs.ranges` / `toBe.ranges` を **±5〜10 行拡張**
   - 必要なら file 全体を覆う追加 panel を当該 group に挿入
   - 他の group / 他 group の panels は触らない (cross-group 影響を作らない)
   - panelId は安定 ID (intent 除外 hash) を保持するため、asIs/toBe の file を変えない限り変わらない
5. **`restore.json` を Write** で書き出す:
   ```json
   {
     "reviewedPanels": ["..."],
     "comments": [...],
     "lineCommentDrafts": {"draft:p1:asis:42": "..."}
   }
   ```
   `result.json` の `reviewedPanels` / `comments` / `lineCommentDrafts` をそのままコピーする。
6. **`Skill('zeus:review-diff', args)` で自動再起動**。args は通常起動と同じ (staged なら空、PR なら番号)。
   - 再起動側の Phase 2 で **既存 WORK_DIR がある場合はそれを再利用** (新規 timestamp dir を作らない)
   - Phase 5 の CLI 起動に `--restore-state "$WORK_DIR/restore.json"` を追加する
7. Skill ツールが使えない環境では `AskUserQuestion` で「context を広げた summary.json で再 review するには
   もう一度 /zeus:review-diff を手動実行してください (restore.json が work-dir に残っているので Reviewed と
   draft は維持されます)」と告げる。

実装メモ:
- regen-group 後の再起動は **同じ WORK_DIR** を使う。新しい timestamp dir を作ると restore.json への参照が切れる。
  Phase 2 の `WORK_DIR` 決定ロジックで「直近の review-diff の work-dir に restore.json があれば再利用」する分岐を入れる。

#### timeout

`AskUserQuestion` で次のアクションを確認:
- 再 review (もう一度 CLI を起動) → **work-dir はそのまま残す**
- 修正したい点を聞いてから再開 → 修正後の判断に従う
- 終了 → **work-dir をクリーンアップ**:
  ```bash
  rm -rf "$WORK_DIR"
  ```

## 不明点があれば AskUserQuestion で聞く

`description` / `groups` の切り方、`panel` の境界、`intent` 文言、commit メッセージの prefix、reject 時の修正範囲、
context+ で広げるべき行数の幅、regen 上限到達時の判断など、判断に迷ったら遠慮なく `AskUserQuestion` で
選択肢提示形式で確認すること。
