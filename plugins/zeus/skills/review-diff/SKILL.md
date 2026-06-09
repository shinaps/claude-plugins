---
name: review-diff
description: 直前の staged diff または既存 PR の diff を Linear 風 stacked PR UI (split mode) でブラウザに開き、group 単位の Approve / Request Changes + コメントで人間ゲートする最終承認スキル。Submit すると linear stack で先頭から approved group を 1 commit ずつ作り、最初の request-changes で打ち切って残りは un-commit のまま Claude に戻す。context+ ボタンは close-relaunch + state restore モデルで全 group の decision / コメント / 未保存 draft を再起動後に復元。/zeus:review (観点別分析) と責務が違い、こちらは「人間が目で見て承認する」動線
argument-hint: <なし | PR番号>
---

## このスキルの位置付け

`/zeus:review` が **観点別の機械レビュー** (security/logic/performance 等を AI に分析させる) なのに対し、
このスキルは **人間が目で見て最終承認する** ためのゲートです。
diff を Linear 風 stacked PR UI でブラウザに開き、**group 単位** の Approve / Request Changes と自由コメントを返してもらいます。Submit すると linear stack で先頭から approved group を 1 commit ずつ作り、最初の request-changes 以降は un-commit のまま Claude に戻して修正ループに入ります。

レビューの主単位は **group** です。group は 1 つの「読書セクション = 意味的にまとまった変更の塊」で、複数の panel を含みます。panel は表示単位で、`intent` + `asIs` + `toBe` (ファイル + 行範囲集合) を持ちます。

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
**validator fail による summary 再生成カウンタ (summaryRegenCount) も会話メモリで管理**し、3 回到達で AskUserQuestion で確認。

`slug` の決め方:
- staged モード: 変更ファイル名から代表的な 1〜2 個を kebab-case で繋ぐ
- pr モード: `pr-<番号>`

## 使用エージェント

このスキルは **エージェントを起動しない**。
diff から `summary.json` を組み立てる作業はメインエージェント自身が Read + Write で行い、
レビュー UI 部分は同梱 Node CLI (`dist/cli.js`) を Bash の `run_in_background: true` で起動し、`TaskOutput` で完了を待ち合わせる。

## 動作原則

- **summary.json は必ず Write ツールで作成する** (Bash heredoc 禁止: `$` 展開や引用符のエスケープ事故を避ける)
- **git add / git commit / git push は必ず別実行で 1 コマンドずつ** (CLAUDE.md ルール)
- **Reject 連続 3 回でユーザー確認**: rejectCount ≥ 3 になったら `AskUserQuestion` で「続行 / 中止 / 方針見直し」
- **regen-group 連続 5 回でユーザー確認**: regenCount ≥ 5 で `AskUserQuestion` (無限再生成防止)
- **summary 再生成 (validator fail) 連続 3 回でユーザー確認**: summaryRegenCount ≥ 3 で `AskUserQuestion`
- **CLI に絶対値タイムアウトは無い**: タブが閉じられたら client → server の heartbeat が止まり、CLI が 15 秒以内に自発 exit する設計。Bash は `run_in_background` で起動して TaskOutput で待つので Bash tool の 10 分制約も無関係
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

#### group の並び順は「読書順 = レビュー順」 (重要)

groups[] は **「人間が読む順番」** で並べる。intent ベースの topic 分類 (型刷新 / 実装 / テスト 等) ではなく、
**読みやすさ** を優先して並べる:
- **抽象 → 具象** (型定義 → 型を使う側 → UI レイヤ)
- **原因 → 結果** (validator 追加 → CLI 側で呼び出し → エラーハンドリング)
- **コア → 周辺** (ビジネスロジック → そのテスト → ドキュメント更新)

panel 内も同様、「最初に読むべき panel」を group の先頭に置く。
レビュアーが上から順に読むだけで設計意図がメンタルモデルに組み上がるよう、順序自体を語りに使う。

#### 同一変更行排他原則 (重要)

stacked PR 風で **group 単位 commit** するため、同じ git 変更行を複数 group が touch すると
commit-per-group が破綻する。CLI が `validatePanelExclusivity` で検出して fail させる。

ルール:
- **同一 (file, side, line) の変更行 (deletion/addition) は 1 group の 1 panel だけが range に含める**
- **不変な context 行は複数 group で重複 OK** (どの group も「文脈として見せたい」のは自然)

違反した場合の stderr 例:
```
Panel exclusivity validation failed. The same changed line is claimed by multiple groups:
  packages/foo.ts [toBe] line 42:
    group g0 "型刷新" panel p3
    group g1 "API 実装" panel p7
```
→ 該当行を「どちらの group のテーマに属するか」判断して、片方の panel ranges から外す。

#### asIs / toBe ranges の対称性 (重要)

panel.asIs.ranges と panel.toBe.ranges に含まれる **不変行 (= 変更されなかった行)** は、
git diff の hunk から逆算した行マッピングで「両側に対応行が含まれている」状態にしなければならない。
そうでないと、jsdiff の LCS が「不変行を変更行扱い」して UI 上のハイライトが嘘になる。

CLI が `validateRangeSymmetry` で検出して fail させる。

例 (NG):
- 真の変更は 90-95 → 90-115 (10 行追加で末尾シフト)
- asIs.ranges = [70-110] (不変行 96-110 を含む)
- toBe.ranges = [70-110] (toBe で対応する不変行は 116-130 のはずだが、含まれていない)
→ jsdiff LCS が末尾 5 行を deletion 扱いして赤で表示される
→ `validateRangeSymmetry` が「toBe.ranges を [70-130] まで拡張せよ」と stderr に出して exit 1

修正方法:
1. asIs.ranges を Read で実測 (関数 header から closing brace まで等)
2. **その同じ論理ブロックが toBe で何行〜何行になっているか** を、変更後ファイルを Read で再度実測
3. 変更行 (deletion/addition) は panel ごとに分け、context 行は両側ペアになるよう調整

#### groups[] の配列順は絶対に変えない (重要)

regen-group 後の再生成で `groups[]` の配列順を変えると `g${i}` キーが意味を失い、
restore.json の `groupDecisions` / `groupComments` 復元が破綻する。
**panels[] の追加・range 拡張は OK、group の挿入・削除・入れ替えは禁止**。

#### group は最低 1 panel

`panels: []` の group は禁止。context-only でも最低 1 panel を入れる。
(理由: ゼロ panel の group は UI 上 decision UI が disable され、自動 approved 扱いになるが、
レビュアーは何を判断したのか曖昧になる。意図的な context-only group は最低 1 つの「読書 anchor」
panel を持たせる)

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
- 使える文字: `^[A-Za-z0-9 _-]*$` (英数字 + 空白 + アンダースコア + ハイフン、または空文字)。空白は CLI が `-` に自動正規化。空文字は前述の自動 hash 生成にフォールバックする
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

pr モードの `pr` フィールドは現状 CLI からは参照されない (CLI は `--pr-meta` フラグから直接読む archival 用途)。`null` でも `pr-meta.json` の内容をそのまま入れても挙動は変わらないが、後で `summary.json` だけ見て文脈を復元できるよう、PR モードでは入れておくことを推奨。

### Phase 5: CLI 起動 (background mode + TaskOutput 待ち)

CLI は **Bash の `run_in_background: true` で起動** し、完了は **TaskOutput で待つ**。
これで Bash 同期 tool の 10 分制約から解放され、ユーザーがじっくりレビューしても問題ない。
タブを閉じれば CLI 側 heartbeat 検知で数秒以内に自発 exit するので zombie process も出ない。

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

**起動手順 (メインがやること)**:

1. 上記コマンドのいずれかを **`Bash(run_in_background: true)`** で起動 → task ID を取得
2. 起動後 1〜2 秒待って `.output` を Read し、stderr の `[review-diff] URL: ...` を確認
   - URL を出すまでは macOS の `open` で自動的にブラウザが立ち上がるので、通常は URL 取得すら不要
   - ブラウザが起動しない環境 (リモートなど) では URL をユーザーに案内する
3. **`TaskOutput(task_id, block: true)`** で完了通知を待つ
   - block: true は CLI が exit (= ユーザーが Submit / regen-group / タブ close 検知 timeout) するまで待ち続ける
   - 待ち時間に上限なし。Claude 側で並行して別の作業もできる
4. 完了したら `.output` ファイル末尾を Read し、最後の `{"decision":...}` 行を JSON.parse

CLI の挙動:
- macOS では `open` が自動で立ち上がりブラウザに UI が出る
- stderr に `[review-diff] URL: http://127.0.0.1:<port>/?token=...` が出るので、ブラウザが開かない環境ではこの URL を案内する
- ブラウザは 5 秒ごとに `/heartbeat` を打つ。CLI 側は最終 ping から 15 秒以上空くと「タブ閉じられた」と判断して **decision='timeout'** で exit する (= 旧 9 分絶対値タイムアウトは撤廃)
- 終了時に stdout に **1 行の JSON** が出る:
  `{"decision":"submit"|"timeout"|"regen-group", ...}` (合否は groupDecisions の分布から判定)

UI には 2 つの主要タブがある (評価軸は **Guide タブの group decision** のみ):
- **Guide タブ**: AI が summary.json で指定した group / panel をそのままナラティブ順で表示。Approve / Request Changes と group コメント / 行コメントを付ける本番の評価面
- **Diff タブ**: GitHub 風に「1 ファイル = 1 panel (file 全体表示)」で全変更ファイルを順に俯瞰するための補助面。grouping を介さない素の差分確認用で、行コメントは付けられるが decision には影響しない (CLI 内部で `rawPanels` として別系統で構築される)

#### Comment / Result shape

`comments[]` の各要素は scope union 構造:
- `{ "body": "...", "scope": { "type": "group", "groupId": "g0" } }` — group コメント
- `{ "body": "...", "scope": { "type": "line", "panelId": "...", "side": "asIs"|"toBe", "file": "path/to/foo.ts", "line": 42 } }` — 単一行コメント
- `{ "body": "...", "scope": { "type": "line", "panelId": "...", "side": "asIs"|"toBe", "file": "path/to/foo.ts", "line": 42, "endLine": 58 } }` — 行範囲コメント

(旧 `scope: { type: 'overall' }` は廃止)

ResultJson 全体:
```json
{
  "decision": "submit" | "timeout" | "regen-group",
  "groupDecisions": {
    "g0": "approved",
    "g1": "approved",
    "g2": "request-changes"
  },
  "comments": [
    { "body": "型定義 OK", "scope": { "type": "group", "groupId": "g0" } },
    { "body": "ここ null check 漏れ", "scope": { "type": "line", "panelId": "p3", "side": "toBe", "file": "src/foo.ts", "line": 42 } }
  ],
  "regenGroup": {            // decision='regen-group' の時のみ
    "groupId": "g2",
    "currentRanges": [ { "panelId": "...", "asIs": {...}, "toBe": {...} } ],
    "note": "foo() の caller も見たい"   // 任意。ユーザーが inline textarea で書いた自由文
  },
  "submitNote": "commit メッセージにはこの観点を含めて",  // decision='submit' 時に SubmitBar textarea で書いた全体コメント (任意)
  "lineCommentDrafts": {      // regen-group の時に restore で活きる、それ以外は無視可
    "draft:p1:asis:42": "draft body..."
  }
}
```

注意:
- 評価単位は **`groupDecisions`** (groupId → 'approved' | 'request-changes')
- groupId は `g${i}` 形式 (`i` は summary.json の `groups[]` index)
- 全体の合否は `groupDecisions` の分布から SKILL.md が判定 (全 approved / 全 RC / mixed)
- `decision='timeout'` の時は `groupDecisions` が空オブジェクト
- 行コメントの side は **`asIs` / `toBe`** (camelCase)
- 行コメントの `file` は panel の対応する側 (`asIs.file` または `toBe.file`) を自動で入れる

### Phase 6: 結果分岐

stdout の JSON をパースして `decision` で分岐する。CLI 側で `${WORK_DIR}/result.json` にも自動保存されている。

#### decision = 'submit' → linear-stack commit (新規)

`groupDecisions` の分布から、まず全体合否を判定する:

```bash
TOTAL=$(jq '.groupDecisions | length' "$WORK_DIR/result.json")
APPROVED=$(jq '[.groupDecisions[] | select(. == "approved")] | length' "$WORK_DIR/result.json")
RC=$(jq '[.groupDecisions[] | select(. == "request-changes")] | length' "$WORK_DIR/result.json")
```

| 分布 | パス |
|---|---|
| APPROVED == TOTAL | **全 approved** → linear-stack で全 group commit |
| RC == TOTAL | **全 RC** → commit を作らず reject ルート (rejectCount++, Skill 再起動) |
| 0 < APPROVED < TOTAL | **mixed** → 先頭から approved を commit、最初の RC で break、残りは un-commit のまま Claude に戻す |

##### linear-stack commit ループ (bash)

```bash
# 先頭から走査。最初の RC で break。
GROUPS_LEN=$(jq '.groups | length' "$WORK_DIR/summary.json")
COMMIT_COUNT=0
LAST_GID=""
for i in $(seq 0 $((GROUPS_LEN - 1))); do
  GID="g${i}"
  DECISION=$(jq -r --arg id "$GID" '.groupDecisions[$id] // "missing"' "$WORK_DIR/result.json")
  if [ "$DECISION" = "request-changes" ]; then
    echo "[review-diff] stopped at $GID (request-changes)"
    LAST_GID="$GID"
    break
  fi
  if [ "$DECISION" != "approved" ]; then
    # missing は許容しない (timeout でも groupDecisions は空、フローには来ない)
    echo "[review-diff] unexpected decision for $GID: $DECISION"
    break
  fi
  # 部分 patch 抽出 (--unidiff-zero 互換)
  node "$CLI" extract-group-patch \
    --summary "$WORK_DIR/summary.json" \
    --diff "$WORK_DIR/diff.patch" \
    --group "$GID" \
    > "$WORK_DIR/patch.${GID}.diff" 2>/dev/null
  # 空 patch (context-only approved group) は commit skip
  if [ ! -s "$WORK_DIR/patch.${GID}.diff" ]; then
    echo "[review-diff] skipped empty group $GID"
    continue
  fi
  # index を初期化して当該 group のみ stage
  git restore --staged . 2>/dev/null || true
  if ! git apply --cached --unidiff-zero --recount "$WORK_DIR/patch.${GID}.diff" 2>/dev/null; then
    echo "[review-diff] FATAL: failed to apply patch for $GID — aborting" >&2
    git restore --staged .
    # 全 commit を諦め、ユーザーに状況を提示
    break
  fi
  # commit メッセージは AI が group.title + description + 該当 group の comment + panel.intent から生成
  # (semantic prefix を含む 1〜2 行サマリ)
  git commit -m "$COMMIT_MSG_FOR_${GID}"
  COMMIT_COUNT=$((COMMIT_COUNT + 1))
done
echo "[review-diff] created $COMMIT_COUNT commits"
git log --oneline -n "$COMMIT_COUNT"
```

ポイント:
- `extract-group-patch` は `dist/cli.js` の subcommand。`--unidiff-zero` 互換の patch を出す
- `git apply --cached --unidiff-zero --recount` で line count のずれを git 側に吸収させる
- 各 commit メッセージは **AI が** `group.title` + group description + 該当 group の `comments` (scope='group') + 各 panel.intent + **`result.json.submitNote` (任意の全体コメント)** から生成 (semantic prefix 含む)
- mixed パスでは「N commits を作って g${k} onwards は request-changes のため un-commit」をユーザーに明示
- 全 commit 完了後 (= 全 approved or mixed パスで break まで) は **work-dir をクリーンアップ** (`rm -rf "$WORK_DIR"`)
- mixed パスで RC group が残った場合は、その後 reject ルートに合流して修正実装 → Skill 再起動

##### 全 RC パス (= reject ルート)

全 group が 'request-changes' の場合:

1. **rejectCount をメインの会話メモリで +1**
2. UI で集めた `comments` 配列をユーザーに提示し、どの指摘を反映するか合意を取る
3. `rejectCount >= 3` の場合は **必ず `AskUserQuestion`** で「このまま続行 / 中止 / 方針見直し」を聞く
4. 修正実装を行う (大きい変更なら `/zeus:dev` への橋渡しを提案)
5. 修正完了後、Skill 自動再起動の **直前** に work-dir をクリーンアップ:
   ```bash
   rm -rf "$WORK_DIR"
   ```
6. `Skill('zeus:review-diff', args)` で自動再起動

##### mixed パスの「残った RC 以降」処理

mixed パスで approved を全部 commit した後、最初の RC group 以降が un-stage で残る:

1. ユーザーに「g${k} 以降は request-changes のため un-commit、コメントは以下: ...」を提示
2. RC group の `comments` を要約して修正方針を提案
3. ユーザー合意後に修正実装 → 残った変更を `git add` → `Skill('zeus:review-diff', args)` で再起動
4. 再起動側では、もう commit された変更は HEAD に取り込まれているので、`git diff --cached` は残った RC 部分 + 新しい修正だけが対象になる

#### decision = 'regen-group'

ブラウザの context+ ボタン押下で `decision: 'regen-group'` が返る。close-relaunch + state restore で対応する。

手順:

1. **regenCount をメインの会話メモリで +1**。`regenCount >= 5` なら **AskUserQuestion** で
   「このまま広げ続ける / 中止 / 方針見直し」を聞く (無限再生成防止)。
2. `result.json` から `regenGroup.groupId` / `regenGroup.currentRanges` / `regenGroup.note` (任意) を取得。
3. **work-dir はクリーンアップしない** (summary.json / diff.patch は再利用、restore.json を作る)。
4. **summary.json を Read → 該当 group の panels[] を再生成** して Write:
   - `currentRanges` を参考に、各 panel の `asIs.ranges` / `toBe.ranges` を **±5〜10 行拡張**
   - **`note` (自由文) が来ていれば、それを最優先指針として panel 構成を決める**:
     - 例: 「foo() の caller も見たい」→ caller を含む別 file の関数領域を panel として追加
     - 例: 「呼び出しチェーン全部」→ AI がコードを追跡して関連 panel を group に挿入
     - 例: 「テストも見せて」→ 対応する test file を新規 panel として追加
     - note が無ければ機械的な ±5〜10 行拡張のみ
   - 必要なら file 全体を覆う追加 panel を当該 group に挿入
   - **`groups[]` の配列順は絶対に変えない** (group の挿入・削除・入れ替え禁止)
   - 他 group の panels は触らない (cross-group 影響を作らない)
   - panelId は安定 ID (intent 除外 hash) を保持するため、asIs/toBe の file を変えない限り変わらない
5. **`restore.json` を Write** で書き出す:
   ```json
   {
     "groupDecisions": { "g0": "approved", "g1": "approved" },  // 該当 group (g2) の decision はクリア
     "groupComments": { "g0": "型 OK", "g1": "API も OK" },     // 該当 group の comment はクリア
     "comments": [ /* line scope のみ抽出して載せる */ ],
     "lineCommentDrafts": { "draft:p1:asis:42": "..." }
   }
   ```
   - `groupDecisions`: `result.json.groupDecisions` から **regenGroup.groupId に該当する key を削除** したもの (Q-3: 該当 group の decision のみクリア)
   - `groupComments`: `result.json.comments` から `scope.type==='group'` を集約、ただし **regenGroup.groupId に該当するものは除外**
   - `comments`: `result.json.comments` から `scope.type==='line'` のみ抽出
   - `lineCommentDrafts`: そのままコピー
6. **`Skill('zeus:review-diff', args)` で自動再起動**。args は通常起動と同じ (staged なら空、PR なら番号)。
   - 再起動側の Phase 2 で **既存 WORK_DIR がある場合はそれを再利用** (新規 timestamp dir を作らない)
   - Phase 5 の CLI 起動に `--restore-state "$WORK_DIR/restore.json"` を追加する
7. Skill ツールが使えない環境では `AskUserQuestion` で「context を広げた summary.json で再 review するには
   もう一度 /zeus:review-diff を手動実行してください (restore.json が work-dir に残っているので decision と
   コメントは維持されます)」と告げる。

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

#### validator fail (CLI exit 1)

`validateCoverage` / `validateRangeSymmetry` / `validatePanelExclusivity` のいずれかが fail すると CLI が
stderr に違反内容を出して exit 1 する。SKILL.md 側の処理:

1. **summaryRegenCount をメインの会話メモリで +1**
2. `summaryRegenCount >= 3` で **AskUserQuestion** で「summary.json を再生成して続行 / panel 設計を手動見直し / 中止」を聞く
3. stderr の違反内容を Read で把握 → summary.json を Write で再生成 (修正提案に従って ranges を調整、または exclusivity 違反の解消)
4. **work-dir は維持** (summary.json だけ更新、restore.json があれば残す)
5. `Skill('zeus:review-diff', args)` で自動再起動

## 不明点があれば AskUserQuestion で聞く

`description` / `groups` の切り方、`panel` の境界、`intent` 文言、commit メッセージの prefix、reject 時の修正範囲、
context+ で広げるべき行数の幅、regen 上限到達時の判断など、判断に迷ったら遠慮なく `AskUserQuestion` で
選択肢提示形式で確認すること。
