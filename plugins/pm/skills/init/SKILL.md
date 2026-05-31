---
name: init
description: プロジェクトに PM（プロジェクト継続コンテキスト管理）を初期化する。`.pm/`（チーム共有 / commit）または `.pm-local/`（個人 / gitignore）を生成し、4 ファイル（state / roadmap / decisions / workflow）のスケルトンを書く。team は CLAUDE.md、personal は CLAUDE.local.md にマーカー付きで PM 利用ルールを挿入。**team モードでは PM スキル (ask / sync) と pm-agent をプロジェクト直下の `.claude/skills/pm-ask/` `.claude/skills/pm-sync/` `.claude/agents/pm-agent.md` に転写し、pm プラグイン未インストールのチームメンバーも `/pm-ask` `/pm-sync` で PM を呼べる** (git pull で配布)。personal モードでは PM の存在自体が git に残らない設計。チーム共有と個人 overlay を併用したい場合は team → personal を別個に実行する
argument-hint: <なし | team | personal>
---

## 引数仕様

```
/pm:init                     # interactive: AskUserQuestion で team / personal を選択
/pm:init team                # チーム共有モード: .pm/ (commit)
/pm:init personal            # 個人モード: .pm-local/ (gitignore)
```

両方欲しい場合は `/pm:init team` 実行後、別途 `/pm:init personal` を実行する。
それぞれが独立して動き、Claude Code はセッション開始時に CLAUDE.md と CLAUDE.local.md の両方を読むため、`.pm/` と `.pm-local/` 両方が自動的に参照される。

## モードの違い

| モード | コンテキスト配置先 | ルール挿入先 | スキル/エージェント転写 | 呼び出すコマンド | git 管理 | 用途 |
|---|---|---|---|---|---|---|
| **team** | `.pm/` | `CLAUDE.md` | あり (`.claude/skills/pm-ask/`、`.claude/skills/pm-sync/`、`.claude/agents/pm-agent.md`) | `/pm-ask` `/pm-sync` (pm プラグイン保有者は `/pm:ask` `/pm:sync` も可) | 全部 commit | チーム全員で共有する公式コンテキスト。**pm プラグイン未インストール環境でも `/pm-ask` `/pm-sync` が動く** |
| **personal** | `.pm-local/` | `CLAUDE.local.md` | なし | `/pm:ask` `/pm:sync` (pm プラグイン経由) | 両方 gitignore | 個人スクラッチパッド。**PM の存在自体が git に残らない** |

### PM スキル/エージェントのプロジェクト転写について

team モードでは、以下を pm プラグイン本体からコピーする:

- `.claude/skills/pm-ask/SKILL.md` (ask スキルを `name: pm-ask` にリネーム + 内部の `/pm:` 参照を `/pm-` に書き換え)
- `.claude/skills/pm-sync/SKILL.md` (sync スキルを同様に転写)
- `.claude/agents/pm-agent.md` (そのままコピー)

これにより:

- **pm プラグイン未インストールのチームメンバー** も `/pm-ask` `/pm-sync` を叩くだけで PM を使える
- ファイルは commit されてリポジトリに乗るため、`git pull` だけで全員に配布される
- pm 本体側で SKILL や `pm-agent` を更新した場合は、pm プラグイン保有者が再 `/pm:init` を打って転写ファイルを更新する

## 実行フロー

### Phase 1: 引数判定 + モード確認

1. 引数が `team` / `personal` のいずれかなら採用
2. 引数なし or 無効値 → `AskUserQuestion` で選択（Recommended: `team`）
3. 既に `.pm/` または `.pm-local/` が存在する場合:
   - 既存ファイルを読んで内容を保持
   - 不足ファイルだけ追加生成
   - CLAUDE.md のマーカーは更新する

### Phase 2: ディレクトリ + ファイル生成

選択モードに応じて以下を作成（既存なら上書きしない）:

#### team モード時 — `.pm/` 配下

**`state.md` スケルトン**:

```markdown
# Project State

このファイルは PM が管理する「いま何をやっているか」のスナップショット。
セッション開始時に Claude が自動で読み込む（CLAUDE.md ルール参照）。
作業区切りで `/pm:sync` で更新する。

## 現在のフォーカス

<!-- 1-3 行でいま注力していることを書く -->
{プロジェクト初期段階。/pm:sync で最初の整理をすると良い}

## 進行中のタスク

<!-- TaskCreate と独立した、セッション横断のタスクリスト -->
- [ ] {タスク 1}

## ブロッカー / 待ち

<!-- 外部レビュー待ち、技術検証待ち、判断待ちなど。無ければ "なし" -->
なし

## 最近完了

<!-- 直近 1 週間程度に終わったもの -->
- {まだなし}
```

**`roadmap.md` スケルトン**:

```markdown
# Roadmap

「次にやること」の優先度付きリスト。state.md のフォーカスが終わったら次にここから引いてくる。

## 短期 (今週〜来週)

1. {item 1}
2. {item 2}

## 中期 (今月〜来月)

- {item}

## 長期 / 検討中

- {item}

## 却下 / 保留

<!-- なぜやらないかを併記する -->
- ~~{item}~~ — 理由: {why}
```

**`decisions.md` スケルトン**:

```markdown
# Decision Log

設計・技術選定・運用ルールに関する意思決定の記録。
`/pm:sync` が直近の git 活動 / plan.md / spec.md から自動抽出して提案する。

## YYYY-MM-DD: {title}

- **Context**: {どういう状況で生じた決定か}
- **Decided**: {採用案}
- **Alternatives**: {他に検討した案}
- **Why**: {採用理由}
- **Applies to**: {影響範囲: ファイル / 機能 / プロジェクト全体}
- **Source**: {ユーザー指示 / PR #N / commit SHA / plan.md など}

<!-- 新しいエントリは上に追記する（時系列降順） -->
```

**`workflow.md` スケルトン**:

```markdown
# Workflow & Conventions

このプロジェクトの **進め方** を記録する。
state.md と違って頻繁に変わらない静的な内容（ブランチ運用、レビュープロセス、デプロイ手順、コーディング規約のうち CLAUDE.md に書きにくいプロセス系など）。

## ブランチ運用

- メインブランチ: `main`
- 命名: {例: feat/, fix/, refactor/}
- マージ方針: {例: squash merge / rebase}

## レビュープロセス

- {例: PR には必ずレビューを通す / Critical 指摘は merge 前に解消}

## デプロイ / リリース

- {手順 / 自動化されている範囲}

## コミット規約

- {Conventional Commits / プレフィックスルールなど}

## 開発体験で大事にしていること

- {例: テストは integration 寄りで書く / 早く失敗させる}
```

#### personal モード時 — `.pm-local/` 配下

同じ 4 ファイルを `.pm-local/` に生成。
さらに **`scratch.md`** を追加（personal モード特有）:

```markdown
# Personal Scratch

走り書き・アイデア・未整理のメモ。gitignore されているので自由に書ける。
PM ブリーフィングでは Claude が軽く目を通すだけで、roadmap や decisions と違って構造化されない。
```

### Phase 3: .gitignore 更新

1. `.gitignore` を Read（無ければ新規作成）
2. 既存の含有を確認した上で、不足分だけ末尾に追記

#### personal モード時

```
# PM (personal mode — keep PM private)
.pm-local/
CLAUDE.local.md
```

#### team モード時

`.gitignore` 変更なし（すべて commit されるのが正しい運用）。

### Phase 4: PM スキル/エージェントのプロジェクト転写（team モードのみ）

personal モードではスキップ (PM の存在自体を git に残さない設計のため)。

#### 解決パス

`${CLAUDE_SKILL_DIR}` 環境変数で **このスキル自身のディレクトリ** が取れる。pm プラグインのレイアウト上:

```
pm/
├── skills/
│   ├── init/         ← ${CLAUDE_SKILL_DIR}
│   ├── ask/
│   └── sync/
└── agents/
    └── pm-agent.md
```

なのでプラグインルートは `${CLAUDE_SKILL_DIR}/../..`。

#### 転写コマンド

`Bash` ツールで以下を実行（プロジェクトルートで動かす想定）:

```bash
PLUGIN_ROOT="${CLAUDE_SKILL_DIR}/../.."

mkdir -p .claude/skills/pm-ask .claude/skills/pm-sync .claude/agents

# ask スキル: name フィールドを pm-ask に書き換え、内部の /pm: 参照を /pm- に置換
sed -e 's|^name: ask$|name: pm-ask|' -e 's|/pm:|/pm-|g' \
  "${PLUGIN_ROOT}/skills/ask/SKILL.md" > .claude/skills/pm-ask/SKILL.md

# sync スキル: 同様
sed -e 's|^name: sync$|name: pm-sync|' -e 's|/pm:|/pm-|g' \
  "${PLUGIN_ROOT}/skills/sync/SKILL.md" > .claude/skills/pm-sync/SKILL.md

# pm-agent: そのままコピー (プロジェクトエージェントとして読み込まれる)
cp "${PLUGIN_ROOT}/agents/pm-agent.md" .claude/agents/pm-agent.md
```

既存ファイルがあれば **上書き** (転写版は pm 本体のミラーであり、最新を反映するのが正しい挙動)。

#### 動作確認

転写後、`.claude/skills/pm-ask/SKILL.md` の冒頭が `name: pm-ask` で始まっており、内部の `/pm:ask` 等の表記が `/pm-ask` に置換されていることを確認する。

### Phase 5: ルール挿入先ファイルの更新

挿入先ファイルはモード別に切り替える:

| モード | 挿入先ファイル |
|---|---|
| `team` | `CLAUDE.md`（プロジェクトルート） |
| `personal` | `CLAUDE.local.md`（プロジェクトルート） |

#### 共通処理

1. 対象ファイルを Read（無ければ新規作成）
2. 既存マーカー `<!-- pm:start -->` 〜 `<!-- pm:end -->` の有無を確認
3. マーカーあり → 中身を最新版で置換
4. マーカーなし → ファイル末尾にマーカー付きで挿入

挿入する内容は **モード別**:
- team モード: コマンド参照を `/pm-` 系で書く (Phase 4 で転写したスキルを呼ぶため、pm プラグイン未インストール環境でも動く)
- personal モード: コマンド参照を `/pm:` 系で書く (pm プラグイン経由で呼ぶ)

#### team モード（CLAUDE.md に挿入）

```markdown
<!-- pm:start -->
## PM（プロジェクト継続コンテキスト）

このプロジェクトでは PM が「いま何やっているか」「次やること」「進め方」「過去の意思決定」をセッション横断で管理する。

PM スキル本体はプロジェクト内蔵 (`.claude/skills/pm-ask/`、`.claude/skills/pm-sync/`、`.claude/agents/pm-agent.md`) なので、**pm プラグイン未インストールのメンバーも `/pm-ask` `/pm-sync` で呼べる**。pm プラグイン保有者は `/pm:ask` `/pm:sync` でも同じことができる。

### セッション開始時に必ず以下を読むこと

`.pm/` 配下（および存在すれば `.pm-local/` の overlay）:

- `state.md` — 現在のフォーカス、進行中タスク、ブロッカー
- `roadmap.md` — 次にやる候補
- `decisions.md` — 過去の意思決定ログ（なぜ X を選んだか）
- `workflow.md` — このプロジェクトの進め方・規約

`/pm-ask` を引数なしで叩くと `pm-agent` が上記を読み込み 300 行以内のブリーフィングを返す。曖昧な指示を受けたとき、まずこれを確認してから動くこと。

`/pm-ask <自由質問>` で「先週何やった?」「○○の決定理由は?」のような質問にも回答できる。

### 作業区切りで PM を更新すること

- **作業が一段落したら `/pm-sync`**: 直近の git 活動 / plan.md / spec.md から state / decisions / roadmap への更新案を自動生成し、ユーザー承認後に適用される
- 完了タスク / 新しい決定 / 新しい roadmap 項目はすべて sync が自動判別して拾う (個別コマンドは無い)

### PM を活用するためのルール

- **PM を読まずに「現状」「次やること」を答えない**: 曖昧な質問には `/pm-ask` を通して PM の内容を引いて答える
- **意思決定はコミットメッセージか plan.md に明示する**: そうすれば次の `/pm-sync` で decisions.md に拾える
- **state.md と現実を乖離させない**: 完了した作業がコミットされたら速やかに `/pm-sync` を回す
- **/pm-sync は頻繁に**: 何もなければ「変更なし」と返るだけなので安全

<!-- pm:end -->
```

#### personal モード（CLAUDE.local.md に挿入）

team 版と同じ構造だが、コマンド参照を `/pm:` 系で書く (転写なし、pm プラグイン経由で呼ぶ):

```markdown
<!-- pm:start -->
## PM（プロジェクト継続コンテキスト）

このプロジェクトでは PM が「いま何やっているか」「次やること」「進め方」「過去の意思決定」をセッション横断で管理する。

### セッション開始時に必ず以下を読むこと

`.pm-local/` 配下:

- `state.md` — 現在のフォーカス、進行中タスク、ブロッカー
- `roadmap.md` — 次にやる候補
- `decisions.md` — 過去の意思決定ログ（なぜ X を選んだか）
- `workflow.md` — このプロジェクトの進め方・規約

`/pm:ask` を引数なしで叩くと `pm-agent` が上記を読み込み 300 行以内のブリーフィングを返す。曖昧な指示を受けたとき、まずこれを確認してから動くこと。

### 作業区切りで PM を更新すること

- **作業が一段落したら `/pm:sync`**: 直近の git 活動 / plan.md / spec.md から state / decisions / roadmap への更新案を自動生成し、ユーザー承認後に適用される

### PM を活用するためのルール

- **PM を読まずに「現状」「次やること」を答えない**: 曖昧な質問には `/pm:ask` を通して PM の内容を引いて答える
- **意思決定はコミットメッセージか plan.md に明示する**: そうすれば次の `/pm:sync` で decisions.md に拾える
- **/pm:sync は頻繁に**: 何もなければ「変更なし」と返るだけなので安全

<!-- pm:end -->
```

### Phase 6: 初回ブリーフィング

`Skill` ツールで PM を起動 (引数なし = brief モード):
- team モード: `Skill(skill="pm-ask")` (転写されたプロジェクトスキル)
- personal モード: `Skill(skill="pm:ask")` (pm プラグイン)

## 動作原則

- **PM コンテキストファイルは上書き禁止**: `.pm/state.md` 等の同名ファイルがあれば skip。差分があってもマージしない（手動編集を尊重）
- **転写されたスキル / エージェントは上書き OK**: `.claude/skills/pm-ask/SKILL.md` `.claude/skills/pm-sync/SKILL.md` `.claude/agents/pm-agent.md` は pm 本体のミラーであり、最新を反映するのが正しい挙動（再 init 時に上書き）
- **CLAUDE.md マーカー方式**: `<!-- pm:start -->` 〜 `<!-- pm:end -->` で安全に再 init 可能
- **CLAUDE.md が無いプロジェクトは新規作成**
- **自動コミットしない**: `.pm/` や CLAUDE.md の変更は `git add` までで止める
- **personal モードは必ず .gitignore 確認**: 漏洩防止
- **再 init は安全**: PM コンテキストは壊さず、欠けているスケルトンと CLAUDE.md マーカー、そして転写スキル / エージェントだけ更新
