# Zeus

公式 `feature-dev` の **上位互換** となる Claude Code プラグイン。
コードベース調査 → 実装計画策定 → 実装 → セルフレビュー までを `plan.md` を介して連携する 2 スキル構成。

## 構成

| スキル | 役割 |
|---|---|
| `/zeus:plan <task>` | `zeus-explorer` でコードベース調査 → `zeus-architect` で実装計画策定。`plan.md` を永続化して次工程に渡す |
| `/zeus:dev <plan.md>` | `/zeus:plan` の出力を入力に、plan に厳密に従って実装し、`zeus-reviewer` でセルフレビュー → 修正ループ |
| `/zeus:review [PR/path]` | plan 不要の単独レビュー。引数なしで現ブランチ diff、数字で GitHub PR、パスで既存コードを `zeus-reviewer` でレビュー |

## 同梱エージェント (5 体)

このプラグイン内に同梱されているので、インストールするだけで使える。

| エージェント | 役割 |
|---|---|
| `zeus-explorer` | コードベース探索、必読ファイル抽出 |
| `zeus-architect` | 複数観点を内包した実装ブループリント策定（単一最強案を断言、self-critique も担当） |
| `zeus-plan-reviewer` | architect の plan を第三者視点で批判レビュー（差し戻し / 条件付き承認 / 承認） |
| `zeus-reviewer` | logic / design / security / performance / maintainability を統合観点でレビュー（confidence ≥ 80 でフィルタ） |
| `zeus-review-validator` | reviewer の指摘を実コードと照合して事実確認・妥当性検証（false positive 排除 + 追加発見） |

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

## 使い方

### 1. 計画策定

```
/zeus:plan ユーザー認証に2要素認証(TOTP)を追加したい
```

`/zeus:plan` が以下を自動実行する:

1. タスク受領（必要なら `AskUserQuestion` で重要点だけ確認）
2. `zeus-explorer` を起動してコードベース探索（領域が広ければ複数並列）
3. 主体が必読ファイルを直接 Read して文脈構築
4. `zeus-architect` を起動して実装ブループリント策定（複数観点を内部で検討した単一案）
5. `zeus-architect` を再起動して **self-critique**（自己批判で盲点を炙り出し）
6. `zeus-plan-reviewer` で **第三者プランレビュー**（視点固定バイアスを破る）
7. 各エージェントの生レポートを `.claude/zeus/{ts}-{slug}/raw/` に全文保存
8. レビュー指摘を反映した統合プランを `.claude/zeus/{ts}-{slug}/plan.md` に作成
9. `EnterPlanMode` で承認 UI 表示

承認後、次のステップが案内される:

```
/zeus:dev .claude/zeus/{ts}-{slug}/plan.md
```

### 2. 実装＋セルフレビュー

```
/zeus:dev .claude/zeus/20260502-141500-totp-auth/plan.md
```

`/zeus:dev` が以下を自動実行する:

1. plan 検証 + 関連ファイル事前 Read
2. plan のビルド順序に従って実装
3. `implementation.md` に実装ログ保存
4. **動作確認**（型チェック・リント・ビルド・テストを利用可能なものから自動実行）
5. `zeus-reviewer` を起動してセルフレビュー
6. レビューの生レポートを `.claude/zeus/{ts}-{slug}/review.md` に保存
7. **Critical は自動修正**（動作確認の失敗も Critical 扱い）、Warning は確認、Info は記録のみ
8. **Critical 修正があれば再レビュー**（修正で生んだ別バグを検出、最大 1 回）
9. 完了報告（次のステップは `/commit` `/create-pr` を案内）

### 3. 単独レビュー（修正計画への橋渡しも可能）

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
   - **修正計画を立てる** → `/zeus:plan` へ自動橋渡し（その後 `/zeus:dev` で実装まで進める）
   - **PR コメント投稿**（PR モードのみ）
   - **ローカル保存のみで終了**

## 出力ディレクトリ

`/zeus:plan` `/zeus:dev` の生成物:

```
.claude/zeus/{ts}-{slug}/
├── plan.md                 ← /zeus:plan が作成
├── raw/                    ← 計画フェーズの生レポート
│   ├── explorer.md
│   ├── architect-initial.md
│   ├── architect-critique.md
│   ├── plan-review.md
│   └── architect-revised.md  ← 差し戻し時のみ
├── implementation.md       ← /zeus:dev が作成（動作確認結果も含む）
├── review.md               ← /zeus:dev が作成
├── review-2nd.md           ← Critical 修正後の再レビュー（あれば）
└── fix-log.md              ← 修正ループの履歴
```

`/zeus:review` の生成物:

```
.claude/zeus/reviews/{ts}-{mode}/
├── input.md                ← レビュー対象のサマリ
├── review.md               ← zeus-reviewer の一次レビュー
├── review-validated.md     ← zeus-review-validator の検証済み指摘
└── plan-handoff.md         ← /zeus:plan へ橋渡し時の修正タスク記述
```

## ultraplan / feature-dev からの移行

| 旧 | 新 |
|---|---|
| `/ultraplan <task>` | `/zeus:plan <task>` |
| `/feature-dev` の Phase 1-4（計画まで） | `/zeus:plan <task>` |
| `/feature-dev` の Phase 5-7（実装以降） | `/zeus:dev <plan.md>` |

## 設計原則

- **重要ポイントだけ確認**: 細かい質問の連発はしない
- **生レポート保存厳守**: 後から議論の足跡を辿れる
- **統合プランは単一案**: A/B 案を残すのは重大トレードオフだけ
- **計画と実装の分離**: `/zeus:dev` は plan.md 必須（単独起動不可）
- **シンプル優先**: 観点を細分化せず、1 エージェントに統合観点を持たせる

## ライセンス

MIT
