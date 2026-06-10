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
├── restore.json     ← regen-group 後の再起動で前回 state を復元するための中間 JSON
└── trusted-config.json ← PR モードのみ。base ref から抽出した review-diff.config.json (Phase 4.5 参照)
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

### Phase 3: diff 取得 (v5 で PR mode を gh pr checkout 方式に変更)

**staged モード**:

```bash
git diff --cached --no-color > "$WORK_DIR/diff.patch"
```

**pr モード (v5: checkout 方式)**:

v5 では `gh pr diff` + lazy `gh api blob` 経路を廃止し、ローカル worktree に PR head ref を引いてから
`git show <baseSha>:path` でソースを読む方式に切り替えた。エディタリンクの実ファイル指定が効くようにし、
unchanged 行展開が rate limit を消費せず即時実行できるメリットがある。

```bash
# (1) PR メタ取得 (forked 検出 + base SHA 確定用)
gh pr view "$PR" \
  --json number,title,body,author,baseRefName,headRefName,baseRefOid,headRefOid,headRepository,additions,deletions,changedFiles \
  > "$WORK_DIR/pr-meta.json"

# (2) forked repo PR 検出 (Q25 で scope 外)
BASE_OWNER=$(git remote get-url origin 2>/dev/null | sed -nE 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#p')
HEAD_NWO=$(jq -r '.headRepository.nameWithOwner // ""' "$WORK_DIR/pr-meta.json")
HEAD_OWNER=$(echo "$HEAD_NWO" | cut -d/ -f1)
if [ -n "$BASE_OWNER" ] && [ -n "$HEAD_OWNER" ] && [ "$BASE_OWNER" != "$HEAD_OWNER" ]; then
  echo "[review-diff] PR #$PR is from forked repo ($HEAD_NWO). v5.0.0 does not support forked PRs yet." >&2
  exit 1
fi

# (3) dirty precheck (working tree clean 必須、stash は使わない)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[review-diff] working tree is dirty. PR mode requires clean state — commit/stash and re-run." >&2
  exit 1
fi

# (4) 元ブランチ記録 (detached HEAD は弾く、復帰先が無いため)
HEAD_BEFORE_CHECKOUT=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$HEAD_BEFORE_CHECKOUT" = "HEAD" ]; then
  echo "[review-diff] detached HEAD detected; cannot safely restore after checkout." >&2
  exit 1
fi
echo "$HEAD_BEFORE_CHECKOUT" > "$WORK_DIR/head-before-checkout"

# (5) 同名 local branch SHA 確認 (W-1: -f で未 push 作業を上書きする事故を防ぐ)
HEAD_REF_NAME=$(jq -r '.headRefName' "$WORK_DIR/pr-meta.json")
if git show-ref --verify --quiet "refs/heads/${HEAD_REF_NAME}"; then
  LOCAL_SHA=$(git rev-parse "${HEAD_REF_NAME}")
  REMOTE_SHA=$(jq -r '.headRefOid' "$WORK_DIR/pr-meta.json")
  if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
    echo "[review-diff] local branch '${HEAD_REF_NAME}' SHA does not match PR head (local=$LOCAL_SHA, remote=$REMOTE_SHA)." >&2
    echo "[review-diff] aborting to avoid overwriting unpushed work. Please review the local branch first." >&2
    exit 2  # exit 2 = main agent に「ユーザー確認」を促すシグナル
  fi
fi

# (6) PR を checkout (同名ブランチがあれば SHA 一致確認済みなので -f で問題ない)
gh pr checkout "$PR" -f || exit 1

# (7) trap で復帰保証 (異常終了 / Ctrl-C 含む)
trap 'git switch "$HEAD_BEFORE_CHECKOUT" 2>/dev/null || true' EXIT

# (8) diff を生成 (checkout 後の worktree から)。base SHA は pr-meta.json の baseRefOid を使う
#     (HEAD_REF_NAME^ だと複数 commit PR の最終 commit しか取れないため、PR base 全体との diff を取る)
BASE_SHA=$(jq -r '.baseRefOid' "$WORK_DIR/pr-meta.json")
git diff "$BASE_SHA...HEAD" --no-color > "$WORK_DIR/diff.patch"
```

**復帰タイミング**:
- trap EXIT で bash 終了時に元ブランチへ自動復帰
- regen-group / comment-reply で Skill 再起動するときは `$WORK_DIR/head-before-checkout` を保存しているので、再起動側で読み戻して維持できる
- 最終 cleanup (commit 完走 / reject / timeout) で work-dir 削除と同時に `git switch <HEAD_BEFORE_CHECKOUT>` で復帰

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

### Phase 4.5: スクリプトゲート (v5 新設、起動前ゲート)

リポルートに `.claude/zeus/review-diff.config.json` があり `scripts[]` を設定している場合、
review-diff CLI を起動する **直前にスクリプトを実行** し、失敗していたら UI を開かずに修正に戻る。
test / typecheck などの「コミット前に通したい」検査を起動条件として強制する仕組み。

**config の信頼境界 (最重要)**: PR モードでは config を **checkout 後の working tree から読まない**。
working tree は `gh pr checkout -f` で PR 作者の支配下にあり、PR 同梱 config の `scripts[].command` が
UI 表示前に無認証で `sh -c` 実行される RCE になるため。信頼するのは **base ref に tracked な config
(`git show <baseSha>:path` で checkout 前のレビュー済み履歴から抽出したもの) だけ**。working tree の
untracked config も読まない (untracked 判定は PR が tracked symlink ディレクトリを同梱することで
偽装できるため、working tree 由来は一律不信とする)。

#### 4.5.1 config が存在しない場合 (staged モードのみ): AskUserQuestion で誘導

config 作成の誘導は **staged モード限定**。PR モードでは誘導しない — PR レビュー中に config を
作成しても working tree は PR ブランチ上にあり base ref には存在しないため、PR モードの config
読み取り (base ref 限定) の対象にならず、誘導しても意味がない。config 設定は自分の staged
レビュー時に行う。

`.claude/zeus/review-diff.config.json` がリポに無いときは、`AskUserQuestion` で

「スクリプトゲート (test / typecheck 等を起動前に走らせる) を設定しますか?」

を 1 回だけ聞く。選択肢:

- **設定する**: `example.review-diff.config.json` をベースに、ユーザーに具体的な command を AskUserQuestion で 1-3 項目だけ聞いて (例: typecheck / test / lint の中から実行したいもの)、`.claude/zeus/review-diff.config.json` を **Write ツール** で作成 → そのまま今回のレビューから使う
- **今回はスキップ** (= config を作らない): 今回はゲートなしで Phase 5 に進む。次回も同じ確認が出る (= 永続的な opt-out は無い、変更したくなったら手動でファイル削除)
- **永続的にスキップ** (= flag ファイル): `.claude/zeus/review-diff.no-config` を touch して、以後 review-diff 起動時に AskUserQuestion を出さない。flag ファイルを消せば再度誘導される

```bash
# config 誘導は staged モードのみ (PR モード判定は pr-meta.json の存在で行う。
# $MODE のような shell 変数は Bash 呼び出しを跨いで揮発し、空に評価されると危険側に
# 倒れるため、永続アーティファクトをシグナルにする)
if [ ! -f "$WORK_DIR/pr-meta.json" ]; then
  CONFIG_FILE="${REPO_ROOT}/.claude/zeus/review-diff.config.json"
  NO_CONFIG_FLAG="${REPO_ROOT}/.claude/zeus/review-diff.no-config"
  if [ ! -f "$CONFIG_FILE" ] && [ ! -f "$NO_CONFIG_FLAG" ]; then
    # → メインエージェントが AskUserQuestion を投げる (上記 3 択)
    # 「設定する」を選んだ場合は example.review-diff.config.json を読んで、
    # editor.kind / scripts[] を AskUserQuestion で詰めて Write
    # 「今回スキップ」を選んだ場合は何もしない (CONFIG_FILE は無いまま Phase 5 へ)
    # 「永続スキップ」を選んだ場合は flag ファイルを touch
    :
  fi
fi
```

editor 設定 (= toBe addition 行の hover で出るエディタリンク) も同じ config に同居するので、
「スクリプトゲート不要だが editor リンクは使いたい」場合も Phase 4.5 で誘導される
(= 設定する → editor.kind だけ聞いて scripts[] は省略)。

#### 4.5.2 config が存在する場合: スクリプト実行

```bash
# config の解決は信頼境界に従う (Phase 4.5 導入文参照):
#   - PR モード (pr-meta.json が存在): base ref に tracked な config だけを
#     trusted-config.json として抽出する。working tree の config は tracked / untracked を
#     問わず一切読まない。`[ -s ]` の非空チェックは「空 config が JSON.parse で throw して
#     ゲートが exit 2 → レビュー全体がブロックされる」事故を config 不在扱いに倒すため
#   - staged モード: working tree は自分の変更 (信頼境界内) なので従来どおり直接読む
if [ -f "$WORK_DIR/pr-meta.json" ]; then
  BASE_SHA=$(jq -r '.baseRefOid' "$WORK_DIR/pr-meta.json")
  CONFIG_FILE="$WORK_DIR/trusted-config.json"
  if git show "${BASE_SHA}:.claude/zeus/review-diff.config.json" > "$CONFIG_FILE" 2>/dev/null \
     && [ -s "$CONFIG_FILE" ]; then
    :
  else
    rm -f "$CONFIG_FILE"  # base ref に config が無い (or 空) → config 不在として扱う
  fi
else
  CONFIG_FILE="${REPO_ROOT}/.claude/zeus/review-diff.config.json"
fi

if [ -f "$CONFIG_FILE" ]; then
  # 変更ファイル一覧を生成 (staged モードと PR モードで取得方法が違う)
  if [ ! -f "$WORK_DIR/pr-meta.json" ]; then
    git diff --cached --name-only > "$WORK_DIR/changed-files.txt"
  else
    # PR mode: pr-meta.json の baseRefOid を使って PR base 全体との diff を取る
    BASE_SHA=$(jq -r '.baseRefOid' "$WORK_DIR/pr-meta.json")
    git diff "$BASE_SHA...HEAD" --name-only > "$WORK_DIR/changed-files.txt"
  fi
  # スクリプト実行 (CLI 内部で picomatch + spawn 並列、結果を script-results.json に書く)
  node "$CLI" run-scripts \
    --config "$CONFIG_FILE" \
    --changed-files "$WORK_DIR/changed-files.txt" \
    --out "$WORK_DIR/script-results.json" 2>"$WORK_DIR/script-stderr.log"
  GATE_EXIT=$?
  # 成否を問わず stderr ログを表示する。CLI は実行前に「これから実行する command 一覧」を
  # stderr に出すので、成功時もここで何が実行されたかをメインエージェントが監査できる
  cat "$WORK_DIR/script-stderr.log" >&2
  if [ "$GATE_EXIT" -ne 0 ]; then
    echo "[review-diff] Pre-flight script gate failed. UI not opened." >&2
    exit 1
  fi
fi
```

ゲートの設計意図:
- スクリプトが pass しない状態でレビュー画面を開いても、結局その指摘を消費してから本筋のレビューに入る二度手間になる
- 失敗したら **stderr にスクリプト名 / exit code / tail を出して exit 1** (メインエージェントが読んで修正方針を立てる)
- 修正 → re-stage → スキル再起動でループが自然に回る
- 設定 `scripts[]` の各エントリは `{ name, command, matchFiles, timeoutMs? }`。`matchFiles` (glob) が staged diff の変更ファイルにヒットしたものだけ実行

設定例: `plugins/zeus/skills/review-diff/example.review-diff.config.json` を参照。CLI 側は config 無し / editor 未設定 / scripts 未設定の各状態を stderr にメッセージで通知する (= サイレントに機能 off にならない)。

### Phase 5: CLI 起動 (background mode + TaskOutput 待ち)

CLI は **Bash の `run_in_background: true` で起動** し、完了は **TaskOutput で待つ**。
これで Bash 同期 tool の 10 分制約から解放され、ユーザーがじっくりレビューしても問題ない。
タブを閉じれば CLI 側 heartbeat 検知で数秒以内に自発 exit するので zombie process も出ない。

```bash
# v5 で追加された optional 引数:
#   --config <path>          : review-diff.config.json (editor / scripts の設定)
#   --script-results <path>  : Phase 4.5 のスクリプトゲート結果 (Activity タブ Pre-flight チップ用)
#   --base-sha <sha>         : PR モードで base ref の SHA を渡す (なければ HEAD~1)
# config の解決は Phase 4.5.2 と同じ信頼境界に従う。editor preset (editor.command も
# sh -c 実行される) を含むため、PR モードでは base ref 由来の trusted-config.json だけを使う
if [ -f "$WORK_DIR/pr-meta.json" ]; then
  CONFIG_FILE="$WORK_DIR/trusted-config.json"
else
  CONFIG_FILE="${REPO_ROOT}/.claude/zeus/review-diff.config.json"
fi
CONFIG_ARG=""
[ -f "$CONFIG_FILE" ] && CONFIG_ARG="--config $CONFIG_FILE"
SCRIPT_RESULTS_ARG=""
[ -f "$WORK_DIR/script-results.json" ] && SCRIPT_RESULTS_ARG="--script-results $WORK_DIR/script-results.json"

# 通常起動 (初回 or rejectループ)。PR 判定は config 解決と同じく pr-meta.json の存在で行う
if [ -f "$WORK_DIR/pr-meta.json" ]; then
  BASE_SHA=$(jq -r '.baseRefOid // ""' "$WORK_DIR/pr-meta.json")
  BASE_SHA_ARG=""
  [ -n "$BASE_SHA" ] && BASE_SHA_ARG="--base-sha $BASE_SHA"
  node "$CLI" --summary "$WORK_DIR/summary.json" --diff "$WORK_DIR/diff.patch" --pr-meta "$WORK_DIR/pr-meta.json" $BASE_SHA_ARG $CONFIG_ARG $SCRIPT_RESULTS_ARG
else
  node "$CLI" --summary "$WORK_DIR/summary.json" --diff "$WORK_DIR/diff.patch" $CONFIG_ARG $SCRIPT_RESULTS_ARG
fi

# regen-group / comment-reply 後の再起動の場合は --restore-state を追加
# (Phase 6 の regen-group / comment-reply 分岐から自動的にここに戻ってくる)
node "$CLI" --summary "$WORK_DIR/summary.json" --diff "$WORK_DIR/diff.patch" --restore-state "$WORK_DIR/restore.json" $CONFIG_ARG $SCRIPT_RESULTS_ARG
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
- `{ "body": "...", "scope": { "type": "file", "file": "path/to/foo.ts" } }` — ファイル全体へのコメント (panel header の MessageSquare ボタン)
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
# 変数名に GID を使わないこと: zsh では GID がプロセスのグループ ID を表す特殊変数で、
# 代入すると "failed to change group ID: operation not permitted" で即失敗する。
GROUPS_LEN=$(jq '.groups | length' "$WORK_DIR/summary.json")
COMMIT_COUNT=0
LAST_GROUP_ID=""
for i in $(seq 0 $((GROUPS_LEN - 1))); do
  GROUP_ID="g${i}"
  DECISION=$(jq -r --arg id "$GROUP_ID" '.groupDecisions[$id] // "missing"' "$WORK_DIR/result.json")
  if [ "$DECISION" = "request-changes" ]; then
    echo "[review-diff] stopped at $GROUP_ID (request-changes)"
    LAST_GROUP_ID="$GROUP_ID"
    break
  fi
  if [ "$DECISION" != "approved" ]; then
    # missing は許容しない (timeout でも groupDecisions は空、フローには来ない)
    echo "[review-diff] unexpected decision for $GROUP_ID: $DECISION"
    break
  fi
  # 部分 patch 抽出 (--unidiff-zero 互換)
  node "$CLI" extract-group-patch \
    --summary "$WORK_DIR/summary.json" \
    --diff "$WORK_DIR/diff.patch" \
    --group "$GROUP_ID" \
    > "$WORK_DIR/patch.${GROUP_ID}.diff" 2>/dev/null
  # 空 patch (context-only approved group) は commit skip
  if [ ! -s "$WORK_DIR/patch.${GROUP_ID}.diff" ]; then
    echo "[review-diff] skipped empty group $GROUP_ID"
    continue
  fi
  # index を初期化して当該 group のみ stage
  git restore --staged . 2>/dev/null || true
  if ! git apply --cached --unidiff-zero --recount "$WORK_DIR/patch.${GROUP_ID}.diff" 2>/dev/null; then
    echo "[review-diff] FATAL: failed to apply patch for $GROUP_ID — aborting" >&2
    git restore --staged .
    # 全 commit を諦め、ユーザーに状況を提示
    break
  fi
  # commit メッセージは AI が group.title + description + 該当 group の comment + panel.intent から生成
  # (semantic prefix を含む 1〜2 行サマリ)
  git commit -m "$COMMIT_MSG_FOR_${GROUP_ID}"
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

#### decision = 'comment-reply' (v5 新規)

ブラウザの SubmitBar で **Comment** ボタンを押すと `decision: 'comment-reply'` が返る。
Claude が全 open スレッドに自動返信して再起動するルート。close-relaunch + state restore モデル。

手順:

1. `result.json` から `threads` と `comments[]` を取得し、**comments[] の新規コメントを thread 化して threads にマージ** する:
   - thread のキーは scope から決める: group scope → `group:<groupId>`、file scope → `file:<path>`、review scope → `review` (固定)、line scope → `line:<panelId>:<side>:<line>` (範囲コメントは `:<endLine>` を付ける)
   - 既存キーの thread があれば `messages[]` に user message として append、無ければ新規 thread (`resolved: false, outdated: false`) を作る
   - message の形は `{ id: <uuid>, author: 'user', body, ts: <epoch ms> }`
   - **group への質問・相談の正規動線**: decision section の textarea に書いて group の **Comment** ボタンで pending としてスレッドに積む (レビュー継続、GitHub の pending review コメントと同じ) → SubmitBar の **Comment** で一括送信。積んだ分は `threads` に user message として既に入っているので、comments[] の thread 化マージは「textarea に書き残したまま submit したケース」のフォールバック
   - **ファイル全体への指摘** (設計方針・命名・分割など行に紐づかないもの) は panel header の MessageSquare ボタンから同じ pending 方式で file scope thread に積まれる
   - **レビュー全体への指摘** は SubmitBar の textarea が review scope thread (`review` キー) への入力になっており、送信時に user message として threads に積まれて届く。`submitNote` には同じ文字列が後方互換で載る (commit メッセージ生成は従来どおり submitNote を読めばよい) が、**返信は review thread に対して行う** (= submitNote はテキスト返信チャネルではない)
2. **work-dir は維持** (summary.json / diff.patch を再利用)
3. **Claude が「最後の message が user である全 open thread」の最新 user message を読んで応答内容を判定**:
   - 質問 → answer (回答メッセージを agent message として thread に append)
   - 指示 / 修正要求 → suggest (diff サンプル提示) または apply (実ファイルを Edit/Write で書き換え)
   - context+ 相当の要望 → expand (関連 panel を summary.json に追加)
4. **`restore.json` を Write** で書き出す:
   - `threads`: 手順 1 でマージした threads の各 thread.messages に agent message を追記したもの (agentAction で対応種別を記録)
   - `groupDecisions` / `lineCommentDrafts`: result.json からそのままコピー
   - `groupComments`: result.json からコピーするが、**手順 1 で thread 化した group のエントリは除去する** (textarea に残ったまま復元すると、次の Comment 送信で同じ本文がもう一度 thread 化されて二重になるため)
   - `reviewKind: 'comment'` を載せる
5. **apply の場合のみ、`mark-outdated` subcommand で outdated 自動判定**:
   ```bash
   # apply 前後の HEAD SHA と変更ファイル一覧を渡して、interval 交叉で outdated を立てる
   AFTER_SHA=$(git rev-parse HEAD)
   git diff "$BEFORE_SHA..$AFTER_SHA" --name-only > "$WORK_DIR/apply-changed-files.txt"
   node "$CLI" mark-outdated \
     --restore-state "$WORK_DIR/restore.json" \
     --before-sha "$BEFORE_SHA" \
     --after-sha "$AFTER_SHA" \
     --changed-files "$WORK_DIR/apply-changed-files.txt"
   ```
6. **`Skill('zeus:review-diff', args)` で自動再起動**。Phase 5 で `--restore-state "$WORK_DIR/restore.json"` を追加。
   - Activity タブの Conversation セクションに agent 返信が反映される
   - group スレッドは Guide タブの該当 group の decision section (textarea の上) にも会話履歴が表示される
   - outdated になったスレッドは Activity タブで折りたたみ表示される

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
