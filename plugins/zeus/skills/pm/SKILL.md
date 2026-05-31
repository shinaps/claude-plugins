---
name: pm
description: Zeus PM の日常運用スキル。引数なしでセッション開始時のブリーフィング、`sync` で git 活動から状態更新、`decision <text>` で意思決定ログ、`done <task>` でタスク完了、`next <text>` でロードマップ追加。`.zeus/pm/`（チーム）+ `.zeus/pm-local/`（個人 overlay）を読み込み、CLAUDE.md ルールでセッション毎に自動参照される
argument-hint: <なし | sync | decision <text> | done <task> | next <text> | status>
---

# Zeus PM スキル（PM 日常運用担当）

`/zeus:pm-init` で初期化したプロジェクト PM の **日常的な参照・更新** を担当するスキル。
セッション横断のコンテキスト（state / roadmap / decisions / workflow）に対する操作をサブコマンド形式で提供する。

## サブコマンド一覧

| 呼び出し | 動作 |
|---|---|
| `/zeus:pm` | **brief モード**: `zeus-pm` エージェントでブリーフィング生成 |
| `/zeus:pm sync` | **sync モード**: 直近の git 活動 + .claude/zeus/ から state.md 更新案を作成 |
| `/zeus:pm decision <text>` | 意思決定を decisions.md に追記 |
| `/zeus:pm done <task>` | state.md の進行中タスクを完了マーク + 最近完了に移動 |
| `/zeus:pm next <text>` | roadmap.md の「短期」に項目追加 |
| `/zeus:pm status` | ファイル別の行数・更新日時など軽量サマリ（ブリーフィングしない） |

引数判定:
- 引数なし → brief
- 第 1 引数が上記コマンドのいずれか → そのモード
- それ以外 → エラー（"unknown subcommand. Run /zeus:pm-init if not initialized"）

## 前提チェック

すべてのモードで実行前に:

1. `.zeus/pm/` または `.zeus/pm-local/` のいずれかが存在するか確認
2. **どちらも存在しない** → `/zeus:pm-init` を案内して終了:
   ```
   Zeus PM が未初期化です。先に /zeus:pm-init を実行してください。
   ```

## モード別動作

### brief モード（引数なし）

1. `zeus-pm` エージェントを `mode=brief` で起動
2. 返ってきたブリーフィング（300 行以内）をそのままユーザーに提示
3. 末尾に以下を追加:

```
---

ブリーフィングは `.zeus/pm/state.md` ほかから自動生成されています。
詳細を見るには各ファイルを直接 Read してください。
`/zeus:pm sync` で最新の git 活動を反映できます。
```

### sync モード

1. `zeus-pm` エージェントを `mode=sync` で起動
2. 返ってきた「PM Sync 提案」を整形してユーザーに提示
3. `AskUserQuestion` で次を確認:
   - **全部適用**: 提案を全部反映して state.md / decisions.md / roadmap.md を更新
   - **個別に確認**: 各項目を 1 つずつ `AskUserQuestion` で yes/no（多数あると煩雑なのでデフォルトは「全部適用」を Recommended）
   - **適用しない**: 変更せず終了
4. 適用時の書き込み手順:
   - `Edit` で該当ファイルを更新
   - 完了マークは `- [ ]` → `- [x]` への置換
   - 新規追加は該当セクションの末尾に追記
   - decisions.md は時系列降順（新エントリは先頭）
5. 書き込み後 **自動コミットしない**。ユーザーに「`.zeus/pm/` の変更を `git add` して必要ならコミットしてください」と案内（CLAUDE.md ルール準拠）

### decision モード

`/zeus:pm decision この機能は SSE で実装する。理由は Workers の constraints` のような自由記述を受ける。

1. `zeus-pm` エージェントを `mode=decision` で起動、入力テキストを渡す
2. エージェントから返る「意思決定エントリ案」を確認
3. **不足項目があれば** `AskUserQuestion` で補完（context / alternatives / applies_to など）
4. ユーザー確認後、`decisions.md` の **先頭近く**（# Decision Log タイトルの直後）に挿入
5. 自動コミットしない

### done モード

`/zeus:pm done <task description or partial match>` でタスク完了。

1. `state.md` を Read
2. 「進行中のタスク」セクション内で引数のテキストに **部分一致** するタスクを探す
3. 候補が複数あれば `AskUserQuestion` でどれか確認
4. 候補が 0 件なら「該当タスク無し。先に追加が必要か?」と確認
5. 確定したタスクを:
   - 「進行中のタスク」から削除
   - 「最近完了」セクションの先頭に追加（日付付き: `- {task} (YYYY-MM-DD)`）
6. 「最近完了」が **15 件超** になっていたら末尾を切り詰め（流れていく性質のため）
7. 必要なら `roadmap.md` から次タスクを引いて「進行中のタスク」に昇格するか確認（`AskUserQuestion`）

### next モード

`/zeus:pm next <text>` で roadmap に追加。

1. `roadmap.md` を Read
2. `AskUserQuestion` で「短期 / 中期 / 長期 / 検討中」から優先度を選択（Recommended: 短期）
3. 該当セクション末尾に追記
4. 自動コミットしない

### status モード

軽量サマリ。エージェント起動しない。

1. 各 PM ファイルの行数、最終更新日時、進行中タスク数、roadmap 件数、decisions 件数をカウント
2. 1 画面で表示:

```
## Zeus PM Status

### .zeus/pm/ (team-shared)
- state.md           — 42 lines, updated 2026-05-22 14:30
  - 進行中: 3 件 / 最近完了: 8 件 / ブロッカー: 1 件
- roadmap.md         — 28 lines, updated 2026-05-20 10:15
  - 短期: 5 / 中期: 2 / 長期: 3
- decisions.md       — 156 lines, 12 entries
- workflow.md        — 89 lines

### .zeus/pm-local/ (personal overlay) — 検出
- state.md           — 18 lines, updated 2026-05-22 16:00
- scratch.md         — 124 lines

### 直近の更新ファイル
1. .zeus/pm-local/state.md (today)
2. .zeus/pm/state.md (today)
3. .zeus/pm/decisions.md (3 days ago)
```

## overlay マージのルール

ブリーフィング・sync モードで、`pm-local/` と `pm/` に同名ファイルがある場合の扱い:

- **state.md**: pm-local が **追加情報** として overlay される（team の内容は残し、その後に personal セクションを連結）
- **roadmap.md / decisions.md / workflow.md**: pm-local がある場合は **personal version が優先**（team は補助として参照）
- **scratch.md**: pm-local 専用ファイル。team 側は読まない

ユーザーが書き込み操作（done / next / decision / sync 適用）する時、**team / personal どちらに書くか**:

- 両方ある場合は `AskUserQuestion` で確認（Recommended: team）
- team しか無ければ team へ
- personal しか無ければ personal へ

## 動作原則

- **自動コミット禁止**: PM ファイル更新後は `git add` までで止め、ユーザーに案内
- **エージェント分離**: 重い分析（brief / sync / decision 整形）は `zeus-pm` に委譲し、書き込みはスキル本体が責任を持つ
- **ファイル全文上書きしない**: 必ず Edit で部分更新
- **既存セクション構造を尊重**: スケルトンに無い独自セクションをユーザーが追加していても消さない
- **空 PM ファイルでも動く**: スケルトンのまま中身が空でも brief / sync が成立する
- **personal overlay 優先**: 同名ファイルがあれば personal が team を上書き / 補強する
- **CLAUDE.md ルール経由で自動呼び出し**: 直接呼ばれなくても、Claude がセッション開始時に CLAUDE.md を読む過程でこのスキルへの誘導が効く

## 他スキルとの関係

| スキル | 用途 |
|---|---|
| `/zeus:pm-init` | PM の初回セットアップ。一度だけ実行 |
| **`/zeus:pm`** | **PM の日常運用（このスキル）** |
| `/zeus:dev` `/zeus:review` | 完了時に内部から `/zeus:pm sync` や `/zeus:pm decision` を呼ぶ習慣を Claude が持つ（CLAUDE.md ルール経由） |
| `/zeus:spec` `/zeus:tech-survey` | 結果が固まったら decisions.md に追記される（sync 経由） |

## トラブルシュート

| 症状 | 対処 |
|---|---|
| ブリーフィングが空っぽ | `.zeus/pm/state.md` 等のスケルトンに中身を書く |
| sync 提案が出ない | git log が短い or `.claude/zeus/` が無い。手動で `decision` / `done` 等を使う |
| 同名ファイルが team と personal の両方にあり挙動が分からない | `/zeus:pm status` で検出されている内容を確認、書き込み先は AskUserQuestion で選ぶ |
| CLAUDE.md のマーカー外に PM 情報を書きたい | マーカー内は再 init で上書きされるので、マーカー外に書く（再 init は中身を消さない） |
