# Zeus

ultraplan / feature-dev の **完全上位互換** となる Claude Code プラグイン。
最高神レベルの超深掘り計画策定と、計画駆動の実装＋セルフレビューを提供する。

## 構成

| スキル | 役割 |
|---|---|
| `/zeus:plan <task>` | タスク性質に応じて専門エージェントを動的選択し、並列議論で **唯一最強の統合プラン** を作る |
| `/zeus:dev <plan.md>` | `/zeus:plan` の出力を入力に、plan に厳密に従って実装し、5体のレビューワーで並列セルフレビュー → 修正ループ |

## 同梱エージェント（18体）

すべて `~/.claude/agents/` ではなく **このプラグイン内に同梱**。インストールするだけで使える。

### 計画用 (13体)
- `zeus-explorer` — コードベース探索（haiku, 読み取り専用）
- `zeus-architect` — 実装ブループリント策定（観点違いで複数並列起動）
- 専門観点 11体: `zeus-security`, `zeus-performance`, `zeus-ux`, `zeus-dx`, `zeus-testing`, `zeus-debt`, `zeus-data`, `zeus-integration`, `zeus-migration`, `zeus-operability`, `zeus-failure-mode`

### レビュー用 (5体)
- `zeus-reviewer-security` / `zeus-reviewer-logic` / `zeus-reviewer-performance` / `zeus-reviewer-design` / `zeus-reviewer-maintainability`

## インストール

### ローカル開発（推奨）

```bash
git clone https://github.com/shinaps/zeus ~/dev/claude-plugins/zeus
claude --plugin-dir ~/dev/claude-plugins/zeus
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

zeus-plan が以下を自動実行する:

1. タスク受領 & 性質判定（必要なら AskUserQuestion で重要点だけ確認）
2. `zeus-explorer` を 2-3 体並列起動でコードベース探索
3. タスク性質から専門エージェントセットを動的選択
4. `zeus-architect` (複数観点) + 選んだ専門観点エージェントを **並列起動**
5. 各エージェントの生レポートを `.claude/zeus/{ts}-{slug}/raw/` に全文保存
6. 合議して **唯一最強の統合プラン** を作成 → `.claude/zeus/{ts}-{slug}/plan.md`
7. `EnterPlanMode` で承認UI表示

承認後、次のステップが案内される:
```
/zeus:dev .claude/zeus/{ts}-{slug}/plan.md
```

### 2. 実装＋セルフレビュー

```
/zeus:dev .claude/zeus/20260502-141500-totp-auth/plan.md
```

zeus-dev が以下を自動実行する:

1. plan 検証 + 関連ファイル事前 Read
2. plan のビルド順序に従って実装
3. `implementation.md` に実装ログ保存
4. `zeus-reviewer-*` 5体を **並列起動** でセルフレビュー
5. 各レビューの生レポートを `.claude/zeus/{ts}-{slug}/review/` に保存
6. 統合 → `review-summary.md`
7. **Critical は自動修正、Warning は確認、Info は記録のみ**
8. 完了報告（次のステップは `/commit` `/create-pr` を案内）

## 出力ディレクトリ

すべての生成物は `.claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/` に集約される:

```
.claude/zeus/{ts}-{slug}/
├── plan.md                 ← /zeus:plan が作成
├── raw/                    ← 計画フェーズの専門エージェント生レポート
├── implementation.md       ← /zeus:dev が作成
├── review/                 ← レビューエージェント生レポート
├── review-summary.md       ← レビュー統合結果
└── fix-log.md              ← 修正ループの履歴
```

## ultraplan / feature-dev からの移行

| 旧 | 新 |
|---|---|
| `/ultraplan <task>` | `/zeus:plan <task>` |
| `/feature-dev` の Phase 1-4（計画まで） | `/zeus:plan <task>` |
| `/feature-dev` の Phase 5-7（実装以降） | `/zeus:dev <plan.md>` |

## 設計原則

- **重要ポイントだけ確認**: 細かい質問の連発はしない
- **動的エージェント選択**: 小タスクに重エージェントセットを起動しない
- **生レポート保存厳守**: 後から議論の足跡を辿れる
- **統合プランは単一案**: A/B 案を残すのは重大トレードオフだけ
- **並列起動の徹底**: 同一メッセージ内で複数エージェント呼び出し
- **計画と実装の分離**: zeus-dev は plan.md 必須（単独起動不可）

## ライセンス

MIT
