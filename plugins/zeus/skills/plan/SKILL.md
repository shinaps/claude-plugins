---
name: plan
description: ultraplanの上位互換となる超深掘り実装計画策定スキル。タスクの性質に応じて専門エージェントを動的選択し、並列議論で最強の実装計画を作る。各エージェントの生レポートと統合プランの両方を保存する。実装は /zeus:dev に引き継ぐ。
argument-hint: <実装したい機能・解決したい課題>
---

# Zeus Plan スキル（計画策定担当）

ultraplan の上位互換となる、最高神レベルの実装計画策定スキル。
タスクの性質を判定し、必要な専門エージェントを **動的に選択** して並列起動。
各エージェントの生レポートを保存しつつ、合議で **唯一最強の統合プラン** を作る。

zeus プラグインは計画と実装で 2 スキルに分かれている:

- **`/zeus:plan`**（このスキル）: 計画策定までを担う
- **`/zeus:dev`**: /zeus:plan の出力（plan.md）を入力に、実装＋セルフレビューを担う

## 位置づけ

- `ultraplan` および `feature-dev` の **完全上位互換** として置き換えを推奨
- 単一視点の深掘り（ultraplan）から、**多視点の動的合議** へ進化
- このスキルは計画策定で完結する。実装は必ず `/zeus:dev` で実行する

## 引数仕様

| 呼び出し | 動作 |
|---|---|
| `/zeus:plan <task>` | タスク内容を指定して計画策定を開始 |
| `/zeus:plan` | 引数なしの場合は AskUserQuestion でタスクをヒヤリング |

## エージェントプール

zeus 専用エージェントは **本プラグインに同梱** されている（`agents/` ディレクトリ）。
タスク性質に応じて以下から **動的選択** する。
小タスクには重エージェントセットを起動しないこと。

### 探索系（コードベース理解）

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Explorer | `zeus-explorer` | 類似機能トレース、アーキテクチャマップ、該当エリア分析、必読ファイル抽出 |

### 設計系（実装ブループリント）

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Architect | `zeus-architect` | 観点違いで複数並列起動。各々が単一最強案を主張 |

`zeus-architect` を起動する際は、それぞれに観点を割り当てる:

- `minimal-change`: 既存への変更を最小化、再利用最大化
- `clean-architecture`: 保守性・抽象化を最大化
- `pragmatic-balance`: 実装速度と品質のバランス

### 専門観点系

| エージェント | subagent_type | 起動条件の例 |
|---|---|---|
| Zeus Security | `zeus-security` | 認証/権限/外部入力/PII を扱う |
| Zeus Performance | `zeus-performance` | 大量データ/高頻度呼び出し/UI 描画 |
| Zeus UX | `zeus-ux` | UI 変更/ユーザー対面機能 |
| Zeus DX | `zeus-dx` | 共通基盤/SDK/内部 API |
| Zeus Testing | `zeus-testing` | 重要ロジック/分岐多い処理 |
| Zeus Debt | `zeus-debt` | リファクタ/古いコードに触る |
| Zeus Data | `zeus-data` | DB スキーマ変更/モデル追加 |
| Zeus Integration | `zeus-integration` | 外部連携/Webhook/サードパーティ |
| Zeus Migration | `zeus-migration` | 既存機能の置き換え/破壊的変更 |
| Zeus Operability | `zeus-operability` | 本番影響大/夜間バッチ |
| Zeus Failure Mode | `zeus-failure-mode` | 決済/通知/不可逆処理 |

### 推奨セット早見表（参考）

| タスク性質 | 推奨エージェント |
|---|---|
| 小規模バグ修正 | zeus-explorer×1 + zeus-architect×1 |
| 中規模機能追加 | zeus-explorer×2 + zeus-architect×2 + 関連 2-3 観点 |
| 大規模新機能 | zeus-explorer×3 + zeus-architect×2 + 関連 4-6 観点 |
| 基盤刷新/移行 | zeus-explorer×3 + zeus-architect×2 + zeus-migration + zeus-debt + zeus-operability + zeus-failure-mode |
| パフォーマンス改善 | zeus-explorer×2 + zeus-architect×1 + zeus-performance + zeus-data + zeus-testing |
| セキュリティ強化 | zeus-explorer×2 + zeus-architect×1 + zeus-security + zeus-failure-mode + zeus-testing |

## 実行フロー

### Phase 1: タスク受領 & 性質判定

1. 引数からタスクを把握
2. **不明点が重要なら** `AskUserQuestion` で確認（要件・制約・優先度）
   - 細かい質問を連発しない。本当に分岐に影響する論点だけ
3. タスクの規模と性質を判定し、後段で起動する専門エージェントセットを決める

### Phase 2: コードベース探索（並列）

`zeus-explorer` を **2-3 体並列起動** する。
各探索エージェントには異なる観点を割り当てる:

- 類似機能の実装トレース
- 該当エリアのアーキテクチャ・抽象化レイヤーのマップ
- 関連する周辺機能・拡張ポイントの調査

`zeus-explorer` は出力フォーマットに従って **必読ファイル一覧 5-10 件** を返す。
返ってきたファイル一覧は **主体（あなた）が直接 Read** して深い文脈を作る。

### Phase 3: 専門エージェントの動的選択

Phase 1 の性質判定 + Phase 2 の探索結果から、起動する専門エージェントを確定する。

- 起動セットは 1 行で簡潔にユーザー通知（承認は求めない）
- ただし「重大な観点が複数候補あり判断が割れる」ケースは `AskUserQuestion` で確認

### Phase 4: 並列議論

選定した `zeus-architect`（観点違いで複数）と `zeus-{role}` 専門観点エージェントを **同一メッセージ内で並列起動**。

各エージェントへのプロンプトには以下を含めること:

- 実装したいタスク内容
- Phase 2 で得た主要ファイル一覧と要点サマリ
- `zeus-architect` には観点割り当て（`minimal-change` / `clean-architecture` / `pragmatic-balance` 等）
- 専門観点エージェントには「他観点との合議に使う。対立意見・トレードオフを曖昧にせず明示せよ」と再強調
- 出力形式は各エージェント定義に従う（既に明示済み）

### Phase 5: 生レポート保存

各エージェントの返答を **省略せず全文** 以下に保存する:

```
.claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/raw/{agent-role}.md
```

- `slug` はタスク内容の短い英語スラッグ（kebab-case, 30 文字以内）
- ディレクトリが存在しなければ作成
- 保存先パスを Phase 7 のプランファイル冒頭にも記載しておく

### Phase 6: 合議・統合

主体（あなた）が全レポートを読み比べ、以下を抽出する:

- 全エージェント合意の **共通結論**
- 観点間で衝突している **トレードオフ**
- 単独エージェントしか指摘していない **盲点**

統合プランは **唯一最強の単一案** として提示する。
A/B 案の併記は「ユーザー判断が必要な重大トレードオフ」だけに限定。
重大トレードオフが残った場合は `AskUserQuestion` で方針確認。

### Phase 7: 統合プラン保存 & 承認

統合プランを以下に保存:

```
.claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/plan.md
```

その後、プラン本文を `EnterPlanMode` に渡して承認 UI を表示する。
（CLAUDE.md ルール: 「方針承認はテキストではなく EnterPlanMode で」）

### Phase 8: /zeus:dev への引き渡し

承認後:

- /zeus:plan はここで完了
- ユーザーに **次の起動コマンドを明示** する:
  ```
  /zeus:dev .claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/plan.md
  ```
- 生レポートのパスも併記し、実装中に観点を見返せるようにする
- ユーザーが計画修正を希望した場合は、再度本スキルを実行（plan.md は上書きせず、新しい timestamp で別ディレクトリに保存）

## アウトプット形式

### プランファイルテンプレート

```markdown
# Zeus 統合プラン: {task title}

- 作成日時: {YYYY-MM-DD HH:MM:SS}
- タスク: {元の引数}
- 起動エージェント: {agent1, agent2, ...}
- 生レポート: `.claude/zeus/{...}/raw/`

## 1. タスク理解

{Phase 1 で確定した要件・制約・優先度}

## 2. 現状分析サマリ

{Phase 2 の探索結果。主要ファイルパス付き}

## 3. 全エージェント合意の方針

{合議で全員が一致した実装方針}

## 4. 残ったトレードオフと判断

{衝突点と、なぜその判断にしたか。ユーザー承認を経た場合はその旨も}

## 5. 実装ブループリント

### 5.1 変更/新規ファイル一覧
- `path/to/file.ts` — {責務}

### 5.2 データフロー
{入力 → 変換 → 出力}

### 5.3 ビルド順序（フェーズ別チェックリスト）
- [ ] Phase A: {...}
- [ ] Phase B: {...}

## 6. 観点別の重要事項

### Security
{security エージェントの結論ハイライト}

### Performance
{...}

{...観点ごとに}

## 7. テスト戦略

{testing エージェントの結論、または主体の判断}

## 8. ロールアウト/移行（該当時）

{migration / operability エージェントの結論}

## 9. 残課題・次アクション

{今回スコープ外だが今後検討すべき項目}
```

### 生レポートファイル

各エージェントの応答をそのまま全文保存。冒頭に以下メタデータを付与:

```markdown
# {agent-role} レポート

- タスク: {元の引数}
- 起動時刻: {YYYY-MM-DD HH:MM:SS}
- 観点: {役割の説明}

---

{エージェントの応答全文}
```

## 動作原則

- **重要ポイントだけ確認**: AskUserQuestion / EnterPlanMode は本当に判断が必要な分岐だけ
- **動的選択**: 小タスクに重エージェントセットを起動しない。費用対効果で決める
- **生レポート保存厳守**: 省略せず全文。後から議論の足跡を辿れることが zeus の価値
- **統合プランは単一案**: A/B 案を残すのは重大トレードオフだけ。曖昧な選択肢を残さない
- **並列起動の徹底**: 同一メッセージ内で複数 Agent ツールを呼び出す（直列起動は禁止）
- **テキストでの承認質問は禁止**: 必ず AskUserQuestion / EnterPlanMode を使う

## ultraplan / feature-dev からの移行

| 旧 | 新 |
|---|---|
| `/ultraplan <task>` | `/zeus:plan <task>` |
| `/feature-dev <task>` の Phase 1-4（計画まで） | `/zeus:plan <task>` |
| `/feature-dev <task>` の Phase 5-7（実装以降） | `/zeus:dev <plan.md>` |

/zeus:plan は計画の質を最大化することに集中する。実装は /zeus:dev に引き継ぐ。
