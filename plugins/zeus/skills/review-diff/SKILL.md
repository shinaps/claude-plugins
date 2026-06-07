---
name: review-diff
description: 直前の staged diff または既存 PR の diff を Linear 風 UI でブラウザに開き、panel 単位 Reviewed チェック + コメント + Approve/Reject で人間ゲートする最終承認スキル。v4.7.0 から panel ベース schema + Claude Code Channels による group 単位の in-place 再生成 (research preview) に対応。Approve なら commit に進み、Reject ならコメント反映 → 修正後に Skill ツールで自動再起動。/zeus:review (観点別分析) と責務が違い、こちらは「人間が目で見て承認する」動線
argument-hint: <なし | PR番号>
---

## このスキルの位置付け

`/zeus:review` が **観点別の機械レビュー** (security/logic/performance 等を AI に分析させる) なのに対し、
このスキルは **人間が目で見て最終承認する** ためのゲートです。
diff を Linear 風のローカル UI で開き、panel 単位 Reviewed チェック + 自由コメント + Approve/Reject を返してもらいます。

**v4.7.0 で `panel` ベースに作り変えました**。1 つの「変更の意味的単位 = panel」が:
- `intent` (どんな意図の変更か、1 行)
- `asIs` (変更前: ファイル + 行範囲集合)
- `toBe` (変更後: ファイル + 行範囲集合)

を持つ最小ユニットになっています。git の hunk より粗くも細かくもなれ、cross-file 移動も 1 panel で表現できます。

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

#### Claude Code Channels (v4.7.0 新機能、research preview) 利用判定

v4.7.0 から **Claude Code Channels** を使った "group 単位の in-place 再生成" がオプションとして利用可能です。
ブラウザの context+/- ボタンで「この group の context をもっと広げて / 狭めて」とリクエストを送ると、
Claude Code 親エージェントに通知が届いて panels を再生成し、ブラウザの同じ位置に上書き反映されます。

利用条件 (どれか欠ければ degrade fallback):
1. **Claude Code v2.1.80+** (`claude --version` で確認)
2. 起動時に **`--dangerously-load-development-channels server:review-diff`** フラグを指定
3. Team / Enterprise 環境では組織管理者によるオプトインが必要 (research preview の制約)

利用条件チェック (node のワンライナで semver 比較する。bash の string compare はバグりやすい):

```bash
CC_VERSION=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
CHANNELS_OK=$(node -e "const v='$CC_VERSION'.split('.').map(Number); process.stdout.write(v.length===3 && (v[0]>2 || v[0]===2 && (v[1]>1 || v[1]===1 && v[2]>=80)) ? '1' : '')")
```

`CHANNELS_OK=1` なら Phase 5 で `--channels-enabled` を立てて CLI を起動する。
そうでなければ Channels なしで CLI を起動し、UI 上の context+/- ボタンは **disabled + tooltip 表示** で degrade される (機能は無効化されるが UI は問題なく動作する)。

##### Channels preflight (W-5: Process A 接続検証)

`CHANNELS_OK=1` でも、Process A (`channel-server.js`) の MCP server が起動されていない環境では
`--channels-enabled` を立てても feedback がどこにも届かず、UI 上 30 秒の timeout を待つことに
なります。Phase 5 起動前にユーザー側で `/mcp` 結果を確認するよう案内するのが安全です:

```bash
# Phase 1 終盤、Channels を使う旨をユーザーに通知する文言例:
echo "[review-diff] Channels (research preview) を使う場合、Claude Code 起動時に"
echo "  claude --dangerously-load-development-channels plugin:zeus@shinaps/claude-plugins"
echo "  (または server:review-diff) フラグが必要です。"
echo "  起動済みかどうかは Claude Code 内 /mcp で 'review-diff: connected' を確認してください。"
```

未起動でも Phase 5 は実行可能 (`--channels-enabled` は付くが UI は disconnected fallback)。
ユーザーが Channels を確実に使いたい場合は preflight 案内に従って Claude Code を起動し直してから
`/zeus:review-diff` を再実行する。

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
#
# 注: channel-server.js (Process A 用) のパスはここでは解決しない。Phase 5 の起動は
# `.mcp.json` (plugin 同梱版か手動作成版) で完結し、SKILL.md が個別 path を渡す必要はない。
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

### Phase 4: サマリ JSON 生成 (Write ツール強制) — v4.7.0 panel スキーマ

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

- `schemaVersion` は **必ず `1`** (CLI が legacy v4.6 schema を detect すると stderr に migration メッセージを出して exit 1 する)
- `panels[]` は **最低 1 つ**
- 各 `panel` は `asIs` か `toBe` の **少なくとも一方** が必須 (両方欠落不可)

#### panel の切り方

- **関数 / 論理ブロック境界まで広げる**: 関数の途中で切らない。長すぎる関数 (>200 行) のみ例外的に途中分割
- **同一 file でも intent が違えば別 panel**: 「型定義の更新」と「型を使う側の修正」が同じ file にあっても別 panel
- **cross-file 移動**: `foo()` を `a.ts` → `b.ts` に移動なら `asIs.file=a.ts`, `toBe.file=b.ts` で 1 panel
- **cross-file 異言語** (`.js` → `.ts` 移行など) も OK: CLI が両側別言語で syntax highlight する
- **asIs だけ / toBe だけ を恐れない**: 純粋追加・純粋削除も明示的に 1 panel
- **context-only panel も OK**: 不変だが説明に必要な領域 (= ranges が変更行を含まなくてもよい)

#### 1 変更 = 1 intent (discourage rule)

同じ `asIs` 範囲を複数 panel で参照することは **許容するが推奨しない**。1 つの変更に対し 1 つの intent を割り当てる。
複数 panel で参照したい場合は CLI 側で panelId 重複を検出して自動で `-1`, `-2` の suffix を付ける (失敗にはしない)。

#### panelId の規約

- **省略可**: 書かないと CLI がコンテンツ hash (`asIs` + `toBe` のみを対象、`intent` は除外) で `p-<hex10>` を自動生成
- intent を hash 対象から外しているため、context+/- 再生成で intent を書き直しても **panelId は不変**。draft コメントや Reviewed state が維持される
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
# CHANNELS_OK は Phase 1 で判定済みのフラグ ('1' or 空)
EXTRA_FLAGS=""
if [ -n "$CHANNELS_OK" ]; then
  EXTRA_FLAGS="--channels-enabled"
fi

if [ -n "$PR_META" ]; then
  node "$CLI" --summary "$WORK_DIR/summary.json" --diff "$WORK_DIR/diff.patch" --pr-meta "$WORK_DIR/pr-meta.json" $EXTRA_FLAGS
else
  node "$CLI" --summary "$WORK_DIR/summary.json" --diff "$WORK_DIR/diff.patch" $EXTRA_FLAGS
fi
```

CLI の挙動:
- macOS では `open` が自動で立ち上がりブラウザに UI が出る
- stderr に `[review-diff] URL: http://127.0.0.1:<port>/?token=...` が出るので、ブラウザが開かない環境ではこの URL を案内する
- CLI 内部タイムアウトは 9 分 (Bash の 10 分より 1 分早く自爆して整合性を取る)
- 終了時に stdout に **1 行の JSON** が出る:
  `{"decision":"approve"|"reject"|"timeout","reviewedPanels":[...],"comments":[...]}`

#### Channels (--channels-enabled 時) の追加動作

`--channels-enabled` で起動した時のみ、CLI は:
1. 32 byte の `browserToken` / `channelToken` を生成して in-memory に保持
2. `~/.claude/zeus/review-diffs/active/<sessionId>.json` に session 情報を atomic write (`{ sessionId, pid, hubUrl, browserToken, channelToken, createdAt }`)
3. プロセス終了時 (exit / SIGINT / SIGTERM) に上記ファイルを unlink (SIGKILL では消えないが、Process A 側の `process.kill(pid, 0)` 生存確認で stale が回収される)

ブラウザ側 (UI):
- context+/- ボタンが活性化される (上記条件が揃わなければ disabled + tooltip)
- ボタン押下で `/feedback` POST → SSE 経由で Claude Code 親エージェントに通知
- Claude 側で再生成された panels が `/channel/inbox` 経由で SSE プッシュされ、当該 group の panels が in-place 差し替わる

#### Channels MCP server (Process A) の起動

`server:<name>:<path>` 形式の 3 セグメント引数は Claude Code v2.1.80 系で `entries must be tagged: plugin:... or server:...` エラーで reject されるため、MCP server のパスは **`.mcp.json` 経由で解決させる** 必要があります。利用形態に応じて 2 ルートあります。

**ルート A: plugin install ユーザー (推奨)**

zeus プラグインは `.mcp.json` を同梱しているため、以下フラグだけで Process A が立ち上がります:

```bash
claude --dangerously-load-development-channels plugin:zeus@shinaps/claude-plugins
```

同梱されている `.mcp.json` (`plugins/zeus/.mcp.json`) は `${CLAUDE_PLUGIN_ROOT}` を使って channel-server.js を参照するため、ユーザー環境のパスを気にせず動きます。

**ルート B: このリポを直接 clone した dogfooding 開発者**

ユーザー設定 (`~/.claude.json`) またはプロジェクト root の `.mcp.json` を **手動作成** してから:

```json
{
  "mcpServers": {
    "review-diff": {
      "command": "node",
      "args": ["<absolute path>/plugins/zeus/scripts/review-diff/dist/channel-server.js"]
    }
  }
}
```

以下フラグで起動:

```bash
claude --dangerously-load-development-channels server:review-diff
```

注: リポ root の `.mcp.json` は個人 MCP 設定との衝突を避けるため git untracked 扱いにしています (commit されているのは `plugins/zeus/.mcp.json` のみ)。

**両ルート共通の確認**

起動後 Claude Code 内で `/mcp` を打ち `review-diff: connected` を確認してから `/zeus:review-diff` を実行してください。`--channels-enabled` 付きで CLI を起動したのに Process A が未起動だった場合、ブラウザは Channels 経路を open 状態で error として検知し、ボタンを disabled + "Channel disconnected" tooltip にフォールバックします (機能停止のみ、UI は動作)。

#### research preview の制約

Claude Code Channels は **research preview** の機能であり、以下の制約があります:

1. Claude Code **v2.1.80 以降** が必須
2. 起動時に `--dangerously-load-development-channels` フラグが必要 (恒久 enable には別途設定が必要になる予定)
3. Team / Enterprise plan では **組織管理者の opt-in** が必要 (個人 plan では制約なし)
4. プロトコル仕様は予告なく変わる可能性があり、本スキルが将来追従できない可能性がある

これらを許容できない場合は `--channels-enabled` なしで起動して旧来の動作 (Reject → 修正 → 再起動) で運用してください。

#### Comment / Result shape (v4.7.0)

`comments[]` の各要素は scope union 構造:
- `{ "body": "...", "scope": { "type": "overall" } }` — 全体コメント
- `{ "body": "...", "scope": { "type": "line", "panelId": "...", "side": "asIs"|"toBe", "file": "path/to/foo.ts", "line": 42 } }` — 単一行コメント
- `{ "body": "...", "scope": { "type": "line", "panelId": "...", "side": "asIs"|"toBe", "file": "path/to/foo.ts", "line": 42, "endLine": 58 } }` — 行範囲コメント

ResultJson 全体:
```json
{
  "decision": "approve" | "reject" | "timeout",
  "reviewedPanels": ["panel-id-1", "panel-id-2"],
  "comments": [ /* 上記 shape */ ]
}
```

注意:
- `reviewedFiles` (旧) ではなく **`reviewedPanels`** (新)。記録単位が file → panelId に変わった
- 行コメントの side は **`asIs` / `toBe`** (camelCase)。旧 `left` / `right` ではない
- 行コメントの `file` は panel の対応する側 (`asIs.file` または `toBe.file`) を自動で入れる

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

#### timeout

`AskUserQuestion` で次のアクションを確認:
- 再 review (もう一度 CLI を起動) → **work-dir はそのまま残す**
- 修正したい点を聞いてから再開 → 修正後の判断に従う
- 終了 → **work-dir をクリーンアップ**:
  ```bash
  rm -rf "$WORK_DIR"
  ```

## Channels in-place 再生成の範囲 (v4.7.x AC)

v4.7.x の Channels in-place 再生成は **同一 group の panels[] 入れ替えのみ** をサポートします。
以下の操作は **v4.7.x では out-of-scope** で、将来 v4.8.0+ で対応予定:

- 新規 group の追加 / 既存 group の削除 / group の並び替え
- group の `title` / `description` の変更
- cross-group での panel 移動

Claude が `reply` ツールに渡す `panels[]` は、`groupId` で特定された既存 group の panels を
そのまま差し替える形でしか反映されません。

## 不明点があれば AskUserQuestion で聞く

`description` / `groups` の切り方、`panel` の境界、`intent` 文言、commit メッセージの prefix、reject 時の修正範囲など、
判断に迷ったら遠慮なく `AskUserQuestion` で選択肢提示形式で確認すること。
