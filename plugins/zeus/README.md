# Zeus

公式 `feature-dev` の **上位互換** となる Claude Code プラグイン。
要件定義 + フィジビリティ調査 → 計画策定 + 実装 + セルフレビュー → デバッグまでを `spec.md` / `plan.md` を介して連携する 5 スキル構成。

**設計の核**:
- **EnterPlanMode は一切使わない** — `bypassPermissions` モード（リモート実行など）でも全フェーズが走り切る
- **不明な論点は必ず AskUserQuestion で確認** — 「曖昧なまま進める」より「ユーザーに聞く」を優先 (回数に制限なし)
- **spec で実現可能性を詰める** — `/zeus:spec` の段階でフィジビリティ調査 + 必要ならプロトタイプ実装を行い、「ほぼ実現できる」と確信できるレベルまで仕様を固めることで `/zeus:dev` での差し戻しをほぼゼロにする

## 構成

| スキル | 役割 |
|---|---|
| `/zeus:spec [要望]` | 対話的ヒアリング + 既存実装調査 (zeus-explorer) + フィジビリティ調査 (zeus-tech-surveyor + 必要ならプロトタイプ実装) で「ほぼ実現できる」レベルまで仕様を詰める。`zeus-spec-writer` で構造化し `/zeus:dev` へ橋渡し可能 |
| `/zeus:tech-survey [spec.md/要望]` | 技術選定特化の深掘り調査。WebSearch / WebFetch で候補を観点別比較。`zeus-tech-surveyor` + `zeus-survey-validator` で鮮度・出典の妥当性も検証 |
| `/zeus:dev <task>` | **計画策定 → 実装 → セルフレビュー一気通貫スキル**。`zeus-explorer` → `zeus-architect` (initial + self-critique) → `zeus-plan-reviewer` (第三者レビュー、差し戻し時はユーザー確認しつつ自動再策定ループ) → 実装 → `zeus-reviewer` でセルフレビュー → Critical 自動修正 + Warning は確認の上修正 |
| `/zeus:review [PR/path]` | 単独レビュー。引数なしで現ブランチ diff、数字で GitHub PR、パスで既存コードを `zeus-reviewer` + `zeus-review-validator` でレビュー、確定指摘は `/zeus:dev` 橋渡しで修正実装まで進められる |
| `/zeus:debug <症状>` | バグ報告から根本原因を多角的に調査。`zeus-debugger` でコードトレース + WebSearch + GitHub Issue 検索 → `zeus-debug-validator` で実コード照合 → 確定した根本原因を `/zeus:dev` に橋渡し |

## 同梱エージェント (10 体)

| エージェント | 役割 |
|---|---|
| `zeus-spec-writer` | ヒアリング + 調査結果を構造化された仕様書（機能要件 / 非機能要件 / スコープ / 制約 / 既存実装の状況 / 採用方針 / 受け入れ条件）に整理 |
| `zeus-tech-surveyor` | フィジビリティ調査 (関連ライブラリ・公式推奨パターン・知られた落とし穴) を WebSearch / WebFetch で調査 |
| `zeus-survey-validator` | tech-surveyor の主張を出典 URL で再確認し、鮮度・正確性を検証 |
| `zeus-explorer` | コードベース探索、必読ファイル抽出 |
| `zeus-architect` | 複数観点を内包した実装ブループリント策定 (single best plan + self-critique) |
| `zeus-plan-reviewer` | architect の plan を第三者視点で批判レビュー (承認 / 条件付き承認 / 差し戻し) |
| `zeus-reviewer` | logic / design / security / performance / maintainability を統合観点でレビュー (confidence ≥ 80 でフィルタ) |
| `zeus-review-validator` | reviewer の指摘を実コードと照合して事実確認・妥当性検証 (false positive 排除 + 追加発見) |
| `zeus-debugger` | 症状からコードを追跡し、WebSearch / GitHub Issue 検索で根本原因の仮説を立案 |
| `zeus-debug-validator` | debugger の仮説を実コードと照合し root-cause / contributing-factor / red-herring / needs-reproduction に分類 |

## インストール

### ローカル開発

```bash
git clone https://github.com/shinaps/claude-plugins ~/dev/claude-plugins
claude --plugin-dir ~/dev/claude-plugins/plugins/zeus
```

### プラグインマーケットプレイス経由

```
/plugin install zeus
```

PM 機能も使いたい場合は別途 `pm` プラグインをインストール:

```
/plugin install pm
```

## 出力ディレクトリ

`/zeus:dev` の生成物:

```
.claude/zeus/{ts}-{slug}/
├── plan.md                    ← 統合プラン
├── raw/                       ← 計画フェーズの生レポート
│   ├── explorer.md
│   ├── architect-initial.md
│   ├── architect-critique.md
│   ├── plan-review.md
│   └── architect-revised-{n}.md  ← 差し戻し再策定時のみ
├── implementation.md          ← 実装ログ・変更ファイル一覧・動作確認結果
├── review.md                  ← zeus-reviewer の生レポート
├── review-{n}.md              ← Critical / Warning 修正後の再レビュー
└── fix-log.md                 ← 修正ループの履歴
```

`/zeus:spec` の生成物:

```
.claude/zeus/specs/{ts}-{slug}/
├── spec.md                 ← 構造化された仕様書
├── interview-log.md        ← ヒアリングのやりとり記録
├── raw/                    ← 調査エージェントの生レポート
│   ├── explorer.md         ← 既存実装調査（実施時）
│   ├── survey.md           ← フィジビリティ調査一次レポート（実施時）
│   └── survey-validated.md ← 検証済み調査（実施時）
├── prototype/              ← プロトタイプ実装（実施時、隔離スペース）
│   └── prototype-report.md
└── plan-handoff.md         ← /zeus:dev 橋渡し時の引き継ぎ
```

`/zeus:review` の生成物:

```
.claude/zeus/reviews/{ts}-{mode}/
├── input.md
├── review.md
├── review-validated.md
└── plan-handoff.md         ← /zeus:dev 橋渡し時のみ
```

`/zeus:tech-survey` の生成物:

```
.claude/zeus/tech-surveys/{ts}-{slug}/
├── input.md
├── survey.md
├── survey-validated.md
├── tech-decision.md        ← 独立保存選択時のみ
└── plan-handoff.md         ← /zeus:dev 橋渡し時のみ
```

`/zeus:debug` の生成物:

```
.claude/zeus/debug/{ts}-{slug}/
├── input.md
├── debug-report.md
├── debug-validated.md
└── plan-handoff.md         ← /zeus:dev 橋渡し時のみ
```

## ライセンス

MIT
