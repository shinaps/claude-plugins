# Zeus

公式 `feature-dev` の **上位互換** となる Claude Code プラグイン。
要件定義 → 技術選定 → 計画策定 + 実装 + セルフレビュー → デバッグまでを `spec.md` / `plan.md` を介して連携する 5 スキル構成。

**設計の核**: ユーザーインタラクション最小（`EnterPlanMode` を一切使わない）。`bypassPermissions` モード（リモート実行など）でも全フェーズが走り切る。

## 構成

| スキル | 役割 |
|---|---|
| `/zeus:spec [要望]` | ざっくりした要望を対話的なヒアリングで詰めて仕様書化。`zeus-spec-writer` で構造化し、そのまま `/zeus:tech-survey` / `/zeus:dev` へ橋渡し可能 |
| `/zeus:tech-survey [spec.md/要望]` | WebSearch / WebFetch で最新情報を集めてライブラリ・フレームワーク・サービスの候補を観点別に比較。`zeus-tech-surveyor` + `zeus-survey-validator` で鮮度・出典の妥当性も検証 |
| `/zeus:dev <task or plan.md>` | **計画策定 → 実装 → セルフレビュー一気通貫スキル**。`zeus-explorer` でコードベース調査 → `zeus-architect` で実装ブループリント策定 → `zeus-plan-reviewer` で第三者レビュー → 実装 → `zeus-reviewer` でセルフレビュー → Critical/Warning 自動修正までを単一スキルで完走。`EnterPlanMode` / `AskUserQuestion` の要件ヒヤリングは使わない |
| `/zeus:review [PR/path]` | 単独レビュー。引数なしで現ブランチ diff、数字で GitHub PR、パスで既存コードを `zeus-reviewer` + `zeus-review-validator` でレビュー、確定指摘は `/zeus:dev` 橋渡しで修正実装まで進められる |
| `/zeus:debug <症状>` | バグ報告から根本原因を多角的に調査。`zeus-debugger` でコードトレース + WebSearch + GitHub Issue 検索 → `zeus-debug-validator` で実コード照合 → 確定した根本原因を `/zeus:dev` に橋渡し |

## 同梱エージェント (10 体)

このプラグイン内に同梱されているので、インストールするだけで使える。

| エージェント | 役割 |
|---|---|
| `zeus-spec-writer` | ヒアリング結果を構造化された仕様書（機能要件 / 非機能要件 / スコープ / 制約 / 受け入れ条件）に整理 |
| `zeus-tech-surveyor` | WebSearch / WebFetch で最新情報を集めてライブラリ・フレームワーク・サービスを観点別に比較する一次レポートを作成 |
| `zeus-survey-validator` | tech-surveyor の主張を出典 URL で再確認し、鮮度・正確性を検証（outdated / inaccurate / unverifiable / additional finding） |
| `zeus-explorer` | コードベース探索、必読ファイル抽出 |
| `zeus-architect` | 複数観点を内包した実装ブループリント策定（単一最強案を断言、self-critique も担当） |
| `zeus-plan-reviewer` | architect の plan を第三者視点で批判レビュー（差し戻し / 条件付き承認 / 承認） |
| `zeus-reviewer` | logic / design / security / performance / maintainability を統合観点でレビュー（confidence ≥ 80 でフィルタ） |
| `zeus-review-validator` | reviewer の指摘を実コードと照合して事実確認・妥当性検証（false positive 排除 + 追加発見） |
| `zeus-debugger` | 症状からコードを追跡し、WebSearch / GitHub Issue 検索で外部情報を集めて根本原因の仮説を立案 |
| `zeus-debug-validator` | debugger の仮説を実コードと照合し、root-cause / contributing-factor / red-herring / needs-reproduction に分類 |

## インストール

### ローカル開発（推奨）

```bash
git clone https://github.com/shinaps/claude-plugins ~/dev/claude-plugins
claude --plugin-dir ~/dev/claude-plugins/plugins/zeus
```

### プラグインマーケットプレイス経由

[Claude Code プラグインマーケットプレイス](https://docs.claude.com/ja/plugin-marketplaces) に登録後、

```
/plugin install zeus
```

PM 機能も使いたい場合は別途 `pm` プラグインをインストール:

```
/plugin install pm
```

## 使い方

### 0. 仕様策定（要望が曖昧なとき）

```
/zeus:spec 通知機能を追加したい
```

`/zeus:spec` が以下を自動実行する:

1. 初期要望の受領（引数なしなら `AskUserQuestion` で確認）
2. **段階的ヒアリング**（機能要件 / ユーザー / スコープ / 優先度 / 制約 / 非機能要件 / 受け入れ条件 を順次確認）
3. `zeus-spec-writer` で構造化された仕様書を作成
4. サマリをテキスト出力（`EnterPlanMode` は使わない — bypassPermissions と両立させるため）
5. `/zeus:tech-survey` / `/zeus:dev` に橋渡し可能（or ローカル保存のみで終了）

要件が既に明確な場合はスキップして直接 `/zeus:dev` を呼ぶ方が速い。

### 0.5. 技術選定（使う技術が未定のとき）

```
/zeus:tech-survey                                                # interactive: 何を選定したいか聞かれる
/zeus:tech-survey .claude/zeus/specs/{ts}-{slug}/spec.md         # spec モード: spec.md の未確定論点を抽出して調査
/zeus:tech-survey "Next.js 用の認証ライブラリを比較したい"          # freeform モード
```

`/zeus:tech-survey` が以下を自動実行する:

1. 引数判定（なし=interactive / `.md` パス=spec / その他=freeform）
2. `input.md` に調査対象と既知の制約を記録
3. `zeus-tech-surveyor` を起動して候補列挙＋観点別比較レポート作成（WebSearch / WebFetch で公式情報を取得）
4. `zeus-survey-validator` を起動して出典 URL を再確認し、鮮度・正確性を検証
5. 結果を `.claude/zeus/tech-surveys/{ts}-{slug}/` に保存
6. 採用候補の決定（テキスト提示。複数候補で割れる時のみ `AskUserQuestion` で選択。`EnterPlanMode` は使わない）
7. 次アクションを確認:
   - **spec.md に追記して `/zeus:dev` へ橋渡し**（spec モード時の Recommended）
   - **tech-decision.md として独立保存して `/zeus:dev` へ橋渡し**
   - **保存のみで終了**

要件と技術の両方が固まっていれば、このスキルをスキップして直接 `/zeus:dev` を呼ぶ方が速い。

### 1. 計画策定 + 実装 + セルフレビュー（メインスキル）

```
/zeus:dev ユーザー認証に2要素認証(TOTP)を追加したい
```

`/zeus:dev` が以下を一気通貫で自動実行する:

1. タスク受領（**AskUserQuestion による要件ヒヤリングはしない** — 引数の文字列で進める）
2. `zeus-explorer` を起動してコードベース探索（領域が広ければ複数並列）
3. 主体が必読ファイルを直接 Read して文脈構築
4. `zeus-architect` を起動して実装ブループリント策定（複数観点を内部で検討した単一案）
5. `zeus-architect` を再起動して **self-critique**（自己批判で盲点を炙り出し）
6. `zeus-plan-reviewer` で **第三者プランレビュー**（差し戻し時は最大 2 回まで自動再策定ループ）
7. 各エージェントの生レポートを `.claude/zeus/{ts}-{slug}/raw/` に全文保存
8. レビュー指摘を反映した統合プランを `.claude/zeus/{ts}-{slug}/plan.md` に作成（**`EnterPlanMode` は使わない**）
9. plan のビルド順序に従って実装
10. `implementation.md` に実装ログ保存
11. **動作確認**（型チェック・リント・ビルド・テストを利用可能なものから自動実行）
12. `zeus-reviewer` を起動してセルフレビュー
13. **Critical / Warning は自動修正**、Info は記録のみ（ユーザー確認なし）
14. **修正があれば再レビュー**（Critical が無くなるまで繰り返し）
15. 完了報告（次のステップは `/commit` `/create-pr` を案内）

#### 既存 plan.md からの実装再開

```
/zeus:dev .claude/zeus/20260502-141500-totp-auth/plan.md
```

引数が既存 `plan.md` のパス（or ディレクトリ）なら、Phase 1-6（計画フェーズ）をスキップして Phase 7（実装）から開始する。

### 2. 単独レビュー（修正実装への橋渡しも可能）

```
/zeus:review                # 現ブランチの diff をレビュー
/zeus:review 42             # GitHub PR #42 をレビュー
/zeus:review src/           # 指定ディレクトリをフルコードレビュー
```

`/zeus:review` が以下を自動実行する:

1. 引数判定（なし=branch / 数字=PR / その他=path）
2. レビュー対象を取得（git diff / gh pr diff / Read）
3. `zeus-reviewer` で一次レビュー
4. `zeus-review-validator` で事実確認・妥当性検証（false positive 排除 + 追加発見）
5. 結果を `.claude/zeus/reviews/{ts}-{mode}/` に保存
6. 確定指摘がある場合、次アクションを確認:
   - **修正実装に進む** → `/zeus:dev` へ自動橋渡し（計画策定 → 実装 → セルフレビューまで一気通貫）
   - **PR コメント投稿**（PR モードのみ）
   - **ローカル保存のみで終了**

### 3. デバッグ（根本原因調査）

```
/zeus:debug "ユーザー登録 API が稀に 500 を返す"
```

`/zeus:debug` が以下を自動実行する:

1. 症状の受領
2. `zeus-debugger` を起動してコードトレース + WebSearch + GitHub Issue 検索で根本原因の仮説を立案
3. `zeus-debug-validator` で各仮説を実コード照合して root-cause / contributing-factor / red-herring / needs-reproduction に分類
4. 確定した根本原因を `/zeus:dev` に橋渡しして修正実装

## 出力ディレクトリ

`/zeus:dev` の生成物:

```
.claude/zeus/{ts}-{slug}/
├── plan.md                    ← 統合プラン（計画フェーズの最終成果物）
├── raw/                       ← 計画フェーズの生レポート（全文保存）
│   ├── explorer.md
│   ├── architect-initial.md
│   ├── architect-critique.md
│   ├── plan-review.md
│   └── architect-revised-{n}.md  ← 差し戻し再策定時のみ（n は 1 始まり）
├── implementation.md          ← 実装ログ・変更ファイル一覧・動作確認結果
├── review.md                  ← zeus-reviewer の生レポート
├── review-{n}.md              ← Critical/Warning 修正後の再レビュー（n は 2 始まり）
└── fix-log.md                 ← 修正ループの履歴
```

`/zeus:spec` の生成物:

```
.claude/zeus/specs/{ts}-{slug}/
├── spec.md                 ← 構造化された仕様書
├── interview-log.md        ← ヒアリングのやりとり記録
└── plan-handoff.md         ← /zeus:dev 橋渡し時の引き継ぎ
```

`/zeus:review` の生成物:

```
.claude/zeus/reviews/{ts}-{mode}/
├── input.md                ← レビュー対象のサマリ
├── review.md               ← zeus-reviewer の一次レビュー
├── review-validated.md     ← zeus-review-validator の検証済み指摘
└── plan-handoff.md         ← /zeus:dev へ橋渡し時の修正タスク記述
```

`/zeus:tech-survey` の生成物:

```
.claude/zeus/tech-surveys/{ts}-{slug}/
├── input.md                ← 調査対象と既知の制約のサマリ
├── survey.md               ← zeus-tech-surveyor の一次調査レポート
├── survey-validated.md     ← zeus-survey-validator の検証済みレポート
├── tech-decision.md        ← 採用決定の記録（独立保存選択時のみ）
└── plan-handoff.md         ← /zeus:dev へ橋渡し時の引き継ぎ
```

`/zeus:debug` の生成物:

```
.claude/zeus/debug/{ts}-{slug}/
├── input.md                ← 報告された症状と再現条件
├── debug-report.md         ← zeus-debugger の調査レポート（仮説一覧）
├── debug-validated.md      ← zeus-debug-validator の検証済み根本原因
└── plan-handoff.md         ← /zeus:dev へ橋渡し時の修正タスク記述
```

## 設計原則

- **ユーザーインタラクション最小**: `EnterPlanMode` は一切使わない。`AskUserQuestion` も要件ヒヤリングや承認では使わない
- **bypassPermissions と両立**: プランモードに入らない設計なので、リモート bypassPermissions モードでも完走する
- **生レポート保存厳守**: 後から議論の足跡を辿れる
- **統合プランは単一案**: A/B 案を残すのは plan-reviewer で「未解決リスク」として明記された場合だけ
- **Critical / Warning は自動修正**: Info のみ記録扱い
- **シンプル優先**: 観点を細分化せず、1 エージェントに統合観点を持たせる
- **責務の分離**: PM のような「開発フロー外の機能」は別プラグインに切り出す

## ライセンス

MIT
