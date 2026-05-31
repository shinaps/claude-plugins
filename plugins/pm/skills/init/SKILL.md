---
name: init
description: プロジェクトに PM（プロジェクト継続コンテキスト管理）を初期化する。`.pm/`（チーム共有 / commit）または `.pm-local/`（個人 / gitignore）を生成し、4 ファイル（state / roadmap / decisions / workflow）のスケルトンを書く。team は CLAUDE.md、personal は CLAUDE.local.md にマーカー付きで PM 利用ルールを挿入。personal モードでは PM の存在自体が git に残らない。チーム共有と個人 overlay を併用したい場合は team → personal を別個に実行する
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

| モード | コンテキスト配置先 | ルール挿入先 | git 管理 | 用途 |
|---|---|---|---|---|
| **team** | `.pm/` | `CLAUDE.md` | 両方 commit | チーム全員で共有する公式コンテキスト |
| **personal** | `.pm-local/` | `CLAUDE.local.md` | 両方 gitignore | 個人スクラッチパッド。**PM の存在自体が git に残らない** |

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

### Phase 4: ルール挿入先ファイルの更新

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

挿入する内容（モード共通の構造、パスはモード別）:

```markdown
<!-- pm:start -->
## PM（プロジェクト継続コンテキスト）

このプロジェクトでは PM が「いま何やっているか」「次やること」「進め方」「過去の意思決定」をセッション横断で管理する。

### セッション開始時に必ず以下を読むこと

`.pm/` 配下（および存在すれば `.pm-local/` の overlay）:

- `state.md` — 現在のフォーカス、進行中タスク、ブロッカー
- `roadmap.md` — 次にやる候補
- `decisions.md` — 過去の意思決定ログ（なぜ X を選んだか）
- `workflow.md` — このプロジェクトの進め方・規約

`/pm:ask` を引数なしで叩くと `pm-agent` が上記を読み込み 300 行以内のブリーフィングを返す。曖昧な指示を受けたとき、まずこれを確認してから動くこと。

`/pm:ask <自由質問>` で「先週何やった?」「○○の決定理由は?」のような質問にも回答できる。

### 作業区切りで PM を更新すること

- **作業が一段落したら `/pm:sync`**: 直近の git 活動 / plan.md / spec.md から state / decisions / roadmap への更新案を自動生成し、ユーザー承認後に適用される
- 完了タスク / 新しい決定 / 新しい roadmap 項目はすべて sync が自動判別して拾う (個別コマンドは無い)

### PM を活用するためのルール

- **PM を読まずに「現状」「次やること」を答えない**: 曖昧な質問には `/pm:ask` を通して PM の内容を引いて答える
- **意思決定はコミットメッセージか plan.md に明示する**: そうすれば次の `/pm:sync` で decisions.md に拾える
- **state.md と現実を乖離させない**: 完了した作業がコミットされたら速やかに `/pm:sync` を回す
- **/pm:sync は頻繁に**: 何もなければ「変更なし」と返るだけなので安全

<!-- pm:end -->
```

personal モードのみ、上記のパス参照を `.pm-local/` に書き換える。

### Phase 5: 初回ブリーフィング

`Skill` ツールで `pm:ask` を起動（引数なし = brief モード）。

## 動作原則

- **既存ファイル上書き禁止**: 同名ファイルがあれば skip。差分があってもマージしない（手動編集を尊重）
- **CLAUDE.md マーカー方式**: `<!-- pm:start -->` 〜 `<!-- pm:end -->` で安全に再 init 可能
- **CLAUDE.md が無いプロジェクトは新規作成**
- **自動コミットしない**: `.pm/` や CLAUDE.md の変更は `git add` までで止める
- **personal モードは必ず .gitignore 確認**: 漏洩防止
- **再 init は安全**: 既存ファイルを壊さず、欠けているスケルトンと CLAUDE.md マーカーだけ更新
