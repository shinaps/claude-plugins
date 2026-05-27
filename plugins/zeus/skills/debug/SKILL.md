---
name: debug
description: バグ報告・不具合の根本原因を多角的に調査し、対症療法ではなく根本解決を導くスキル。コードトレース + WebSearch + GitHub Issue 検索で仮説を立て、実コード検証で確定させ、/zeus:plan に橋渡しする
argument-hint: <なし | エラーメッセージ / 症状の説明 | ファイルパス>
---

# Zeus Debug スキル（根本原因調査担当）

「うまくいかない」「バグがある」という報告から出発し、**対症療法ではなく根本原因** を特定するスキル。
`zeus-debugger`（多角的調査 + 仮説立案）と `zeus-debug-validator`（実コード検証）の二段構成で、表面的な修正に流れることを防ぐ。

zeus プラグインは以下のスキルで構成される:

- **`/zeus:spec`**: 要件定義・仕様策定
- **`/zeus:tech-survey`**: 技術選定の調査・比較
- **`/zeus:plan`**: 仕様や明確なタスクから実装計画策定
- **`/zeus:dev`**: plan.md を入力に実装＋セルフレビュー
- **`/zeus:review`**: 単独レビュー（plan に橋渡し可能）
- **`/zeus:debug`**（このスキル）: バグ・不具合の根本原因調査

## 引数仕様と動作モード

| 呼び出し | モード | 動作 |
|---|---|---|
| `/zeus:debug` | **interactive モード** | `AskUserQuestion` で症状・再現手順を聞いてから開始 |
| `/zeus:debug <症状/エラーメッセージ>` | **freeform モード** | 記述をそのまま調査対象として扱う |
| `/zeus:debug <ファイルパス>` | **trace モード** | 指定ファイルを起点にコードを追跡して問題を特定 |

引数判定:
- 引数なし → interactive モード
- ファイルパスが存在する（`/` で始まるか相対パスで実在）→ trace モード
- それ以外の文字列 → freeform モード

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Debugger | `zeus:zeus-debugger` | コードトレース + WebSearch + GitHub Issue 検索で仮説を立案 |
| Zeus Debug Validator | `zeus:zeus-debug-validator` | 仮説を実コードと照合し root-cause / red-herring 等に分類 |

## ディレクトリ規約

調査結果は以下に保存:

```
.claude/zeus/debug/{YYYYMMDD-HHMMSS}-{slug}/
├── input.md                ← 症状・再現手順のサマリ
├── debug-report.md         ← zeus-debugger の生レポート（仮説一覧）
├── debug-validated.md      ← zeus-debug-validator の検証済みレポート
└── plan-handoff.md         ← /zeus:plan への引き継ぎ（橋渡し時のみ）
```

`{slug}` は症状の短い英語スラッグ（kebab-case, 30 文字以内）。

## 実行フロー

### Phase 1: 引数判定と入力収集

引数を判定し、モード別に入力を集める:

#### interactive モード（引数なし）
1. `AskUserQuestion` で症状を聞く（何が起きているか / 期待する動作は何か）
2. 続けて再現条件を聞く（いつ起きるか / どの操作で起きるか / エラーメッセージはあるか）
3. 必要に応じて関連ファイルや最近の変更について確認（最大 2〜3 段階）

#### freeform モード（文字列）
1. 引数文字列をそのまま症状記述として扱う
2. 情報が極端に少ない場合のみ `AskUserQuestion` で 1 回だけ補足を確認

#### trace モード（ファイルパス）
1. 指定ファイルを Read で確認
2. `AskUserQuestion` で「このファイルに関してどんな問題が起きているか」を確認

### Phase 2: input.md 保存

`input.md` に以下を保存:

```markdown
# デバッグ対象

- モード: {interactive / freeform / trace}
- 取得時刻: {YYYY-MM-DD HH:MM:SS}
- 元入力: {引数文字列 / ファイルパス / "なし"}

## 症状

{何が起きているか。エラーメッセージがあれば全文}

## 期待する動作

{本来どう動くべきか}

## 再現条件

{いつ / どの操作で / どの環境で起きるか}

## 関連情報

- 最近の変更: {あれば}
- 関連ファイル: {trace モードならパス、他モードでもユーザーが言及したもの}
- エラーログ: {あれば}
```

### Phase 3: zeus-debugger 起動（根本原因調査）

`zeus:zeus-debugger` を 1 体起動する。
プロンプトには以下を含める:

- `input.md` の全文
- プロジェクト `CLAUDE.md` の全文
- 「対症療法ではなく根本原因を特定せよ。コードトレース・WebSearch・GitHub Issue 検索・公式ドキュメント確認を多角的に行い、仮説を確信度付きで立案すること」
- trace モードの場合: 「起点ファイル: {パス}。このファイルから追跡を開始せよ」

`zeus-debugger` は出力ガイダンスに従って調査レポート（仮説一覧）を返す。

応答を **省略せず全文** 以下に保存:

```
.claude/zeus/debug/{ts}-{slug}/debug-report.md
```

### Phase 4: zeus-debug-validator 起動（仮説検証）

`zeus:zeus-debug-validator` を 1 体起動する。
プロンプトには以下を含める:

- `input.md` の全文
- `debug-report.md` の全文
- 「各仮説について該当コードを Read で確認し、root-cause / contributing-factor / red-herring / needs-reproduction に分類せよ。因果関係を実際のコードパスで追跡すること」

`zeus-debug-validator` は検証済み仮説レポートを返す。

応答を **省略せず全文** 以下に保存:

```
.claude/zeus/debug/{ts}-{slug}/debug-validated.md
```

### Phase 5: 結果提示

ユーザーに **検証済み** の最終結果を提示する:

```
## /zeus:debug 完了

- モード: {interactive / freeform / trace}
- 症状: {1 行サマリ}
- 調査レポート: .claude/zeus/debug/{ts}-{slug}/debug-report.md
- 検証済み: .claude/zeus/debug/{ts}-{slug}/debug-validated.md

### 仮説検証サマリ
- root-cause: {N} 件
- contributing-factor: {N} 件
- red-herring: {N} 件
- needs-reproduction: {N} 件

### 確定した根本原因
{root-cause と判定された仮説の要約}

### 推奨修正方針
{対症療法ではない根本的な修正アプローチの要約}

### 対症療法との比較
| アプローチ | 再発リスク | 修正規模 |
|---|---|---|
| 対症療法 | 高 | 小 |
| 根本解決 | 低 | {中 / 大} |
```

### Phase 6: 次アクション選択

root-cause または contributing-factor が **1 件以上ある場合**、`AskUserQuestion` で次の選択を確認:

- **修正計画を立てる（`/zeus:plan` へ橋渡し）（推奨）** — 確定した根本原因に対する修正計画を策定
- **追加調査を依頼する** — needs-reproduction の仮説や新たな観点について再調査
- **保存のみで終了** — 後で別途 `/zeus:plan` を呼ぶ

root-cause が 0 件で needs-reproduction のみの場合:
- **再現手順を追加して再調査** — 追加情報を入力して Phase 3 からやり直す
- **現時点の情報で `/zeus:plan` に進む** — contributing-factor ベースで修正計画
- **保存のみで終了**

### Phase 7: /zeus:plan への橋渡し（修正計画選択時）

修正計画を選んだ場合:

1. `debug-validated.md` の root-cause / contributing-factor を整理し、修正タスク記述を作成
2. 以下を `plan-handoff.md` に保存:

```markdown
# /zeus:plan への引き継ぎ（デバッグ結果）

- 元調査: .claude/zeus/debug/{ts}-{slug}/debug-validated.md
- 症状: {1 行サマリ}

## 確定した根本原因

### Root Cause
{root-cause の説明。コード参照付き}

### Contributing Factors
{あれば}

## 修正タスク

### 1. {修正項目}（優先度: 高）
- 対象: `path/to/file.ts:42`
- 修正内容: {根本的な修正方針}
- 注意点: {副作用・影響範囲}

### 2. ...

## 対症療法ではない理由

{なぜこの修正方針が根本解決になるか。対症療法との違い}

## テスト方針

{修正後に確認すべき再現テストとリグレッションテスト}

## 関連する外部情報

{WebSearch / GitHub Issue で見つけた関連情報への参照}
```

3. `Skill` ツールで `zeus:plan` を起動:
   - 引数例: 「以下のデバッグ結果に基づき根本原因を修正する。詳細は `.claude/zeus/debug/{ts}-{slug}/plan-handoff.md` を参照: {根本原因の 1 行サマリ}」

### Phase 8: 追加調査（追加調査選択時）

1. `AskUserQuestion` で追加情報を収集（新たな再現手順、環境情報、ログなど）
2. `input.md` を更新
3. Phase 3 に戻り、前回の `debug-report.md` も参照コンテキストとして渡す

## 動作原則

- **根本原因志向**: 「とりあえず動く」修正ではなく「なぜ壊れているか」を解明する
- **多角的調査**: コード内部 + WebSearch + GitHub Issues + 公式ドキュメントの 4 方向から情報収集
- **二段検証**: debugger の仮説を validator が実コードで検証し、red-herring を排除
- **対症療法を可視化**: 根本解決との比較表を必ず提示し、ユーザーが判断できるようにする
- **生レポート保存厳守**: 両エージェントの応答は省略せず全文保存
- **テキストでの承認質問は禁止**: `AskUserQuestion` を使う
- **最大推論**: 両エージェントは `effort: max` で動作し、深い因果推論を行う

## 他スキルとの使い分け

| スキル | 用途 |
|---|---|
| **`/zeus:debug`** | **「これが動かない」から根本原因を特定し、修正計画に橋渡し** |
| `/zeus:review` | 既存コード / diff のレビュー（品質改善観点） |
| `/zeus:plan` | 要件が明確で何を実装するか分かっている時 |
| `/zeus:tech-survey` | 技術選定で迷っている時 |
| `/zeus:spec` | 要望が曖昧で要件を詰めたい時 |

`/zeus:review` は「コードの品質を上げる」目的。`/zeus:debug` は「壊れている原因を突き止める」目的。
バグ報告や「うまくいかない」という状況では `/zeus:debug` を使う。
