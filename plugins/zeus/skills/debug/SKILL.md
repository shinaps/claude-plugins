---
name: debug
description: バグ報告・不具合の根本原因を多角的に調査し、対症療法ではなく根本解決を導くスキル。コードトレース + WebSearch + GitHub Issue 検索で仮説を立て、実コード検証で確定させ、必要に応じて zeus-tech-surveyor + zeus-survey-validator で外部情報 (ライブラリ既知バグ / changelog / 修正パターン / 代替案) を深掘りし、/zeus:dev に橋渡しする
argument-hint: <なし | エラーメッセージ / 症状の説明 | ファイルパス>
---

## 引数仕様と動作モード

| 呼び出し | モード | 動作 |
|---|---|---|
| `/zeus:debug` | interactive | `AskUserQuestion` で症状・再現手順を聞いてから開始 |
| `/zeus:debug <症状/エラーメッセージ>` | freeform | 記述をそのまま調査対象として扱う |
| `/zeus:debug <ファイルパス>` | trace | 指定ファイルを起点にコードを追跡して問題を特定 |

引数判定:
- 引数なし → interactive モード
- ファイルパスが存在する → trace モード
- それ以外の文字列 → freeform モード

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Debugger | `zeus-debugger` | コードトレース + WebSearch + GitHub Issue 検索で仮説を立案 |
| Zeus Debug Validator | `zeus-debug-validator` | 仮説を実コードと照合し root-cause / red-herring 等に分類 |
| Zeus Tech Surveyor | `zeus-tech-surveyor` | （Phase 4.5 で任意起動）ライブラリの既知バグ / changelog / 修正パターン / 代替案を WebSearch / WebFetch で深掘り |
| Zeus Survey Validator | `zeus-survey-validator` | （Phase 4.5 で任意起動）surveyor の主張を出典 URL で再確認し、鮮度・正確性を検証 |

## ディレクトリ規約

```
.claude/zeus/debug/{YYYYMMDD-HHMMSS}-{slug}/
├── input.md                ← 症状・再現手順のサマリ
├── debug-report.md         ← zeus-debugger の生レポート（仮説一覧）
├── debug-validated.md      ← zeus-debug-validator の検証済みレポート
├── raw/                    ← Phase 4.5 で外部情報深掘りを実施した場合のみ
│   ├── survey.md           ← zeus-tech-surveyor の生レポート
│   └── survey-validated.md ← zeus-survey-validator の検証済みレポート
└── plan-handoff.md         ← /zeus:dev への引き継ぎ（橋渡し時のみ）
```

`{slug}` は症状の短い英語スラッグ（kebab-case, 30 文字以内）。

## 実行フロー

### Phase 1: 引数判定と入力収集

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

`zeus-debugger` を 1 体起動。プロンプトには以下を含める:

- `input.md` の全文
- プロジェクト `CLAUDE.md` の全文
- 「対症療法ではなく根本原因を特定せよ。コードトレース・WebSearch・GitHub Issue 検索・公式ドキュメント確認を多角的に行い、仮説を確信度付きで立案すること」
- trace モードの場合: 「起点ファイル: {パス}。このファイルから追跡を開始せよ」

応答を省略せず全文 `.claude/zeus/debug/{ts}-{slug}/debug-report.md` に保存。

### Phase 4: zeus-debug-validator 起動（仮説検証）

`zeus-debug-validator` を 1 体起動。プロンプトには以下を含める:

- `input.md` の全文
- `debug-report.md` の全文
- 「各仮説について該当コードを Read で確認し、root-cause / contributing-factor / red-herring / needs-reproduction に分類せよ。因果関係を実際のコードパスで追跡すること」

応答を省略せず全文 `.claude/zeus/debug/{ts}-{slug}/debug-validated.md` に保存。

### Phase 4.5: 外部情報深掘り調査（任意）

`debug-validated.md` の内容を踏まえ、以下のいずれかに該当する場合は `AskUserQuestion` で「外部情報深掘り調査をするか」を確認する (Recommended: Yes)。該当しない場合は **Phase 5 へスキップ**。

- 根本原因が **外部ライブラリ / フレームワーク / SaaS の挙動** に起因する疑いが強い
- 修正方針として **ライブラリのバージョン上げ / 代替ライブラリへの移行 / 公式推奨パターンの採用** が選択肢に上がる
- debugger / validator が「公式情報や changelog の確認が必要」と示唆している
- 類似事例 (他プロジェクトの実装パターン) を集めると修正方針の確信度が上がる

実施する場合:

1. `zeus-tech-surveyor` を起動。プロンプトには以下を含める:
   - `input.md` の全文
   - `debug-validated.md` の確定根本原因セクション
   - プロジェクト `CLAUDE.md` の関連抜粋（依存ライブラリの制約があれば）
   - 「この根本原因に関連する **既知バグ / changelog / 公式推奨の修正パターン / 代替ライブラリ / 類似事例** を WebSearch / WebFetch で調査せよ。**実装可能な修正方針を具体化することが目的**」
2. 応答を全文 `.claude/zeus/debug/{ts}-{slug}/raw/survey.md` に保存
3. `zeus-survey-validator` を起動して出典・鮮度を検証、`raw/survey-validated.md` に全文保存
4. 検証結果を Phase 6 の `plan-handoff.md` 生成時に「関連する外部情報」セクションへ反映

### Phase 5: 次アクション選択

root-cause または contributing-factor が **1 件以上ある場合**、`AskUserQuestion` で次の選択を確認:

- **修正実装に進む（`/zeus:dev` へ橋渡し）（推奨）**
- **追加調査を依頼する** — needs-reproduction の仮説や新たな観点について再調査
- **保存のみで終了**

root-cause が 0 件で needs-reproduction のみの場合:
- **再現手順を追加して再調査** — 追加情報を入力して Phase 3 からやり直す
- **現時点の情報で `/zeus:dev` に進む** — contributing-factor ベースで修正
- **保存のみで終了**

### Phase 6: /zeus:dev への橋渡し（修正実装選択時）

1. `debug-validated.md` の root-cause / contributing-factor を整理し、`plan-handoff.md` に保存:

```markdown
# /zeus:dev への引き継ぎ（デバッグ結果）

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

{WebSearch / GitHub Issue で見つけた関連情報への参照。Phase 4.5 を実施した場合は `raw/survey-validated.md` の要点 (採用すべき修正パターン・避けるべき落とし穴・代替案など) もここに反映}
```

2. `Skill` ツールで `zeus:dev` を起動:
   - 引数例: 「以下のデバッグ結果に基づき根本原因を修正する。詳細は `.claude/zeus/debug/{ts}-{slug}/plan-handoff.md` を参照: {根本原因の 1 行サマリ}」

### Phase 7: 追加調査（追加調査選択時）

1. `AskUserQuestion` で追加情報を収集（新たな再現手順、環境情報、ログなど）
2. `input.md` を更新
3. Phase 3 に戻り、前回の `debug-report.md` も参照コンテキストとして渡す

## 動作原則

- **根本原因志向**: 「とりあえず動く」修正ではなく「なぜ壊れているか」を解明する
- **多角的調査**: コード内部 + WebSearch + GitHub Issues + 公式ドキュメントの 4 方向から情報収集
- **二段検証**: debugger の仮説を validator が実コードで検証し、red-herring を排除
- **生レポート保存厳守**: 両エージェントの応答は省略せず全文保存
