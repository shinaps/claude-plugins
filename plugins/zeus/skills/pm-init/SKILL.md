---
name: pm-init
description: プロジェクトに Zeus PM（プロジェクト継続コンテキスト管理）を初期化する。`.zeus/pm/`（チーム共有 / commit）または `.zeus/pm-local/`（個人 / gitignore）を生成し、4 ファイル（state / roadmap / decisions / workflow）のスケルトンを書く。team / both は CLAUDE.md、personal は CLAUDE.local.md にマーカー付きで PM 利用ルールを挿入。personal モードでは PM の存在自体が git に残らない
argument-hint: <なし | team | personal | both>
---

# Zeus PM Init スキル（PM 初期化担当）

プロジェクトに **Zeus PM** を初期化するワンタイムセットアップスキル。
PM は「いま何やってるか」「次やること」「進め方」をセッション横断で保持する仕組み。`/zeus:pm` から日常的に参照・更新する。

## 引数仕様

```
/zeus:pm-init                     # interactive: AskUserQuestion で team / personal / both を選択
/zeus:pm-init team                # チーム共有モード: .zeus/pm/ (commit)
/zeus:pm-init personal            # 個人モード: .zeus/pm-local/ (gitignore)
/zeus:pm-init both                # 両方: .zeus/pm/ + .zeus/pm-local/、personal が overlay
```

## モードの違い

| モード | コンテキスト配置先 | ルール挿入先 | git 管理 | 用途 |
|---|---|---|---|---|
| **team** | `.zeus/pm/` | `CLAUDE.md` | 両方 commit | チーム全員で共有する公式コンテキスト |
| **personal** | `.zeus/pm-local/` | `CLAUDE.local.md` | 両方 gitignore | 個人スクラッチパッド。**PM の存在自体が git に残らない** |
| **both** | 両方 | `CLAUDE.md`（team ルール）+ personal overlay は overlay ファイルで挙動 | mixed | チーム共有 + 個人 overlay 併用。personal が同名ファイルで上書き |

**personal モードの設計意図**:
`CLAUDE.local.md` は Claude Code が公式にサポートする「local override」用ファイルで、デフォルトで `.gitignore` に入れる前提（公式ドキュメント推奨）。
このファイルに PM ルールを書くことで、ルール自体もコンテキスト本体も両方 git に載らない完全 local 構成になる。
個人プロジェクトでもチームリポジトリで「自分だけ PM を使う」ケースでも、他人に存在を漏らさず PM を回せる。

## 実行フロー

### Phase 1: 引数判定 + モード確認

1. 引数が `team` / `personal` / `both` のいずれかなら採用
2. 引数なし or 無効値 → `AskUserQuestion` で選択（Recommended: `team`）
3. **既に `.zeus/pm/` または `.zeus/pm-local/` が存在する場合**: 上書きせず以下を確認:
   - 既存ファイルを読んで内容を保持
   - 不足ファイルだけ追加生成
   - CLAUDE.md のマーカーは更新する

### Phase 2: ディレクトリ + ファイル生成

選択モードに応じて以下を作成（既存なら上書きしない）:

#### team モード時 — `.zeus/pm/` 配下

**`state.md` スケルトン**:

```markdown
# Project State

このファイルは Zeus PM が管理する「いま何をやっているか」のスナップショット。
セッション開始時に Claude が自動で読み込む（CLAUDE.md ルール参照）。
作業区切りで `/zeus:pm sync` または `/zeus:pm done <task>` で更新する。

## 現在のフォーカス

<!-- 1-3 行でいま注力していることを書く -->
{プロジェクト初期段階。/zeus:pm sync で最初の整理をすると良い}

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
`/zeus:pm decision <text>` で追記。`/zeus:pm sync` でも plan.md / spec.md から自動抽出される。

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

- {例: PR には必ず /zeus:pr-review を回す（pr-watch で自動）}
- {例: Critical 指摘は merge 前に解消、Warning は別 PR で OK}

## デプロイ / リリース

- {手順 / 自動化されている範囲}

## コミット規約

- {Conventional Commits / プレフィックスルールなど}

## 開発体験で大事にしていること

- {例: テストは integration 寄りで書く / 早く失敗させる}
```

#### personal モード時 — `.zeus/pm-local/` 配下

同じ 4 ファイルを `.zeus/pm-local/` に生成。
さらに **`scratch.md`** を追加（personal モード特有）:

```markdown
# Personal Scratch

走り書き・アイデア・未整理のメモ。gitignore されているので自由に書ける。
PM ブリーフィングでは Claude が軽く目を通すだけで、roadmap や decisions と違って構造化されない。
```

#### both モード時

- `.zeus/pm/` に上記 team の 4 ファイル
- `.zeus/pm-local/` に **state.md（空の overlay）と scratch.md** だけ作る（他は team を共有するので冗長作成しない）
- personal の state.md は overlay 用途を明示するヘッダー付き:

```markdown
# Personal State Overlay

`.zeus/pm/state.md`（チーム共有）に対する個人的な追記・覆い被せ。
ブリーフィング時、team の同名ファイルより **こちらが優先** される。

## 個人的なフォーカス

<!-- まだチームに伝えていないが自分の中で進めている作業など -->

## 個人的なブロッカー

<!-- まだ相談していない懸念 -->
```

### Phase 3: .gitignore 更新

モード別に必要なエントリを追加する。

1. `.gitignore` を Read（無ければ新規作成）
2. 既存の含有を確認した上で、不足分だけ末尾に追記

#### personal モード時

```
# Zeus PM (personal mode — keep PM private)
.zeus/pm-local/
CLAUDE.local.md
```

`CLAUDE.local.md` は Claude Code 公式が gitignore 推奨する local override ファイル。
**personal モードでは PM ルール本体もこのファイルに書かれる**ため、PM の存在自体が git に残らない。

#### both モード時

```
# Zeus PM (personal overlay)
.zeus/pm-local/
```

both モードでは team ルールが `CLAUDE.md`（commit）に入るため、`CLAUDE.local.md` は gitignore しなくてよい（個人が自由に上書きルールを足す余地として残す）。
ただし personal の **コンテキスト本体** (`.zeus/pm-local/`) は gitignore する。

#### team モード時

`.gitignore` 変更なし（すべて commit されるのが正しい運用）。

`.zeus/review-memory.md` は **どのモードでも gitignore しない**（PR レビュー側のルールで、PM とは別系統）。

### Phase 4: ルール挿入先ファイルの更新（最重要）

これにより **毎セッション開始時に Claude が自動で PM を読み込む** ようになる。
挿入先ファイルはモード別に切り替える:

| モード | 挿入先ファイル | 理由 |
|---|---|---|
| `team` | `CLAUDE.md`（プロジェクトルート） | チーム全員に PM ルールを適用したい |
| `personal` | `CLAUDE.local.md`（プロジェクトルート） | **ルール自体も他人に見せず完全 local 完結**。Claude Code 公式の local override 機構に乗る |
| `both` | `CLAUDE.md` | team ルールは全員に効かせる。personal overlay はコンテキストファイル側で挙動するためルール変更不要 |

#### 共通処理

1. 対象ファイルを Read（無ければ新規作成）
2. 既存マーカー `<!-- zeus-pm:start -->` 〜 `<!-- zeus-pm:end -->` の有無を確認
3. **マーカーあり**: 中身を最新版で置換
4. **マーカーなし**: ファイル末尾にマーカー付きで挿入

#### Claude Code の CLAUDE.local.md 仕様

- プロジェクトルートの `CLAUDE.local.md` は **`CLAUDE.md` の後に追加で読み込まれる**（append、override ではない）
- 公式ドキュメント (https://code.claude.com/docs/en/memory.md) が `.gitignore` への追加を推奨
- personal モードでは Phase 3 で自動的に `.gitignore` に追加されるので、ユーザーは追加作業不要

挿入する内容:

```markdown
<!-- zeus-pm:start -->
## Zeus PM（プロジェクト継続コンテキスト）

このプロジェクトでは Zeus PM が「いま何やっているか」「次やること」「進め方」「過去の意思決定」をセッション横断で管理する。

### セッション開始時に必ず以下を読むこと

`.zeus/pm/` 配下（および存在すれば `.zeus/pm-local/` の overlay）:

- `state.md` — 現在のフォーカス、進行中タスク、ブロッカー
- `roadmap.md` — 次にやる候補
- `decisions.md` — 過去の意思決定ログ（なぜ X を選んだか）
- `workflow.md` — このプロジェクトの進め方・規約

`/zeus:pm` を引数なしで叩くと `zeus-pm` エージェントが上記を読み込み 300 行以内のブリーフィングを返す。曖昧な指示を受けたとき、まずこれを確認してから動くこと。

### 作業区切りで PM を更新すること

以下のタイミングで PM を更新する責務がある（ユーザーが明示的に頼まなくても、コンテキストから判断して提案する）:

- **タスク完了時**: `/zeus:pm done <task>` で state.md の進行中タスクを完了マーク + 最近完了に移す
- **意思決定時**: 設計判断・技術選定・運用ルールが決まったら `/zeus:pm decision <text>` で decisions.md に追記
- **新タスク追加時**: ロードマップに乗せるべき項目が出たら `/zeus:pm next <text>` で roadmap.md に追加
- **作業内容に大きな変化**: コミット数件で完了するレベルの作業が動いたら `/zeus:pm sync` で git log から差分を抽出して state.md を更新

### コンテキスト管理

- `.zeus/pm/` はチーム共有（git 管理）
- `.zeus/pm-local/` は個人用（gitignore 済み）。同名ファイルがあれば personal が team を上書きする

### PM を活用するためのルール

- **PM を読まずに「現状」「次やること」を答えない**: 曖昧な質問には PM の内容を引いて答える
- **意思決定を口頭で済ませない**: 「○○にする」が決まった瞬間に decisions.md に書く（後で追跡できなくなる）
- **state.md と現実を乖離させない**: 完了したタスクは速やかに完了マークし、新しい作業は即座に追加
- **/zeus:pm sync は頻繁に**: 「いつ更新すればいいか分からない」と思ったら sync を回す。何もなければ「変更なし」と返るだけなので安全

<!-- zeus-pm:end -->
```

### Phase 5: 初回ブリーフィングの提示

セットアップ完了後、その場で `/zeus:pm` を起動して初回ブリーフィングを表示:

1. `Skill` ツールで `zeus:pm` を起動（引数なし = brief モード）
2. ユーザーに「初期セットアップ完了。次は state.md と roadmap.md を埋めて `/zeus:pm sync` を回すと体験が完成する」と案内

### Phase 6: 結果報告

```
## /zeus:pm-init 完了

- モード: {team / personal / both}
- コンテキスト生成先: {.zeus/pm/ / .zeus/pm-local/ / 両方}
- 生成ファイル: {ファイル一覧}
- ルール挿入先: {CLAUDE.md / CLAUDE.local.md} ({新規作成 / マーカー追記 / マーカー更新})
- .gitignore: {更新あり (追記行: ...) / 変更なし}

### 次にやること

1. `.zeus/pm/state.md` を開いて「現在のフォーカス」と「進行中のタスク」を埋める
2. `.zeus/pm/roadmap.md` に思いつく次タスクを 3-5 個書く
3. `.zeus/pm/workflow.md` のスケルトンをこのプロジェクト固有のルールに書き換える
4. `/zeus:pm sync` を回して git log から自動補完
5. 以降は `/zeus:pm` でブリーフィング、`/zeus:pm decision` `/zeus:pm done` で更新

### コミットについて

team モードのファイルは git で管理される。
初回作成分はユーザー側でコミット手順を回すこと（このスキルは自動コミットしない）。
```

## 動作原則

- **既存ファイル上書き禁止**: 同名ファイルがあれば skip。差分があってもマージしない（手動編集を尊重）
- **CLAUDE.md マーカー方式**: `<!-- zeus-pm:start -->` 〜 `<!-- zeus-pm:end -->` で安全に再 init 可能
- **CLAUDE.md が無いプロジェクトは新規作成**: その場合 PM セクションだけのファイルになる
- **自動コミットしない**: `.zeus/pm/` や CLAUDE.md の変更は `git add` までで止める（CLAUDE.md ルール準拠）
- **personal モードは必ず .gitignore 確認**: 漏洩防止
- **再 init は安全**: 既存ファイルを壊さず、欠けているスケルトンと CLAUDE.md マーカーだけ更新

## 他スキルとの関係

| スキル | 用途 |
|---|---|
| **`/zeus:pm-init`** | **初回セットアップ（このスキル）** |
| `/zeus:pm` | 日常運用: brief / sync / decision / done / next |
| `/zeus:plan` `/zeus:dev` `/zeus:review` 等 | PM の存在を前提にしない（直接 PM を更新しない）が、CLAUDE.md ルールにより Claude が完了時に `/zeus:pm sync` を呼ぶ習慣を持つ |
