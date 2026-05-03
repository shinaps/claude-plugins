---
name: plan
description: feature-dev の上位互換となる計画策定スキル。zeus-explorer でコードベースを調査し、zeus-architect で複数観点を内包した単一最強の実装計画を作る。生レポートと統合プランを保存し、実装は /zeus:dev に引き継ぐ。
argument-hint: <実装したい機能・解決したい課題>
---

# Zeus Plan スキル（計画策定担当）

公式 `feature-dev` の上位互換となる実装計画策定スキル。
コードベース探索 → 実装ブループリント策定までを担い、
**`plan.md` を永続化** して `/zeus:dev` に引き継ぐ。

zeus プラグインは計画と実装で 2 スキルに分かれている:

- **`/zeus:plan`**（このスキル）: 計画策定までを担う
- **`/zeus:dev`**: `/zeus:plan` の出力（plan.md）を入力に、実装＋セルフレビューを担う

## 引数仕様

| 呼び出し | 動作 |
|---|---|
| `/zeus:plan <task>` | タスク内容を指定して計画策定を開始 |
| `/zeus:plan` | 引数なしの場合は AskUserQuestion でタスクをヒヤリング |

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Explorer | `zeus-explorer` | コードベース探索、必読ファイル抽出 |
| Zeus Architect | `zeus-architect` | 複数観点を内包した実装ブループリント策定 |

## 実行フロー

### Phase 1: タスク受領

1. 引数からタスクを把握
2. **不明点が重要なら** `AskUserQuestion` で確認（要件・制約・優先度）
   - 細かい質問を連発しない。本当に分岐に影響する論点だけ

### Phase 2: コードベース探索

`zeus-explorer` を起動してコードベースを読み解く。

- タスク領域が広い場合は **複数並列起動** 可（領域を分けて同時調査）
- 領域が狭い場合は 1 体で十分

`zeus-explorer` は出力ガイダンスに従って **必読ファイル一覧 5-10 件** を返す。
返ってきたファイル一覧は **主体（あなた）が直接 Read** して深い文脈を作る。

### Phase 3: 実装ブループリント策定

`zeus-architect` を 1 体起動する。
プロンプトには以下を含める:

- 実装したいタスク内容
- Phase 2 で得た主要ファイル一覧と要点サマリ
- 制約・優先度（あれば）

`zeus-architect` は複数観点を内部で検討した上で **唯一最強の単一案** を返す。
出力形式はエージェント定義に従う（既に明示済み）。

### Phase 4: 生レポート保存

`zeus-explorer` と `zeus-architect` の返答を **省略せず全文** 以下に保存:

```
.claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/raw/explorer.md
.claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/raw/architect.md
```

- `slug` はタスク内容の短い英語スラッグ（kebab-case, 30 文字以内）
- 複数 explorer を並列起動した場合は `explorer-1.md` `explorer-2.md` ...
- ディレクトリが存在しなければ作成

### Phase 5: 統合プラン作成

主体（あなた）が `zeus-architect` の出力を中心に、`zeus-explorer` の発見も統合した
**最終的な実装プラン** を作成する。

- `zeus-architect` の単一案を基本構造として採用
- 必要に応じてユーザーの追加要件を反映
- ユーザー判断が必要な重大トレードオフが残った場合のみ `AskUserQuestion` で確認

統合プランを以下に保存:

```
.claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/plan.md
```

### Phase 6: 承認

`plan.md` 本文を `EnterPlanMode` に渡して承認 UI を表示する。
（CLAUDE.md ルール: 「方針承認はテキストではなく EnterPlanMode で」）

### Phase 7: /zeus:dev への引き渡し

承認後:

- `/zeus:plan` はここで完了
- ユーザーに **次の起動コマンドを明示** する:
  ```
  /zeus:dev .claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/plan.md
  ```
- 生レポートのパスも併記し、実装中に観点を見返せるようにする

## アウトプット形式

### プランファイルテンプレート

```markdown
# Zeus 統合プラン: {task title}

- 作成日時: {YYYY-MM-DD HH:MM:SS}
- タスク: {元の引数}
- 生レポート: `.claude/zeus/{...}/raw/`

## 1. タスク理解

{要件・制約・優先度}

## 2. 現状分析サマリ

{Phase 2 の探索結果。主要ファイルパス付き}

## 3. アーキテクチャ判断

{採用したアプローチと理由}

## 4. 実装ブループリント

### 4.1 変更/新規ファイル一覧
- `path/to/file.ts` — {責務}

### 4.2 データフロー
{入力 → 変換 → 出力}

### 4.3 ビルド順序（フェーズ別チェックリスト）
- [ ] Phase A: {...}
- [ ] Phase B: {...}

## 5. テスト戦略

{単体/結合/E2E のどの層で何を検証するか}

## 6. 採用案のトレードオフ

{得るもの / 失うもの}

## 7. 残課題・次アクション

{今回スコープ外だが今後検討すべき項目}
```

### 生レポートファイル

エージェントの応答をそのまま全文保存。冒頭にメタデータを付与:

```markdown
# {agent-role} レポート

- タスク: {元の引数}
- 起動時刻: {YYYY-MM-DD HH:MM:SS}

---

{エージェントの応答全文}
```

## 動作原則

- **重要ポイントだけ確認**: AskUserQuestion / EnterPlanMode は本当に判断が必要な分岐だけ
- **生レポート保存厳守**: 省略せず全文。後から議論の足跡を辿れることが zeus の価値
- **統合プランは単一案**: A/B 案を残すのは重大トレードオフだけ
- **テキストでの承認質問は禁止**: 必ず AskUserQuestion / EnterPlanMode を使う

## ultraplan / feature-dev からの移行

| 旧 | 新 |
|---|---|
| `/ultraplan <task>` | `/zeus:plan <task>` |
| `/feature-dev <task>` の Phase 1-4（計画まで） | `/zeus:plan <task>` |
| `/feature-dev <task>` の Phase 5-7（実装以降） | `/zeus:dev <plan.md>` |

`/zeus:plan` は計画の質を最大化することに集中する。実装は `/zeus:dev` に引き継ぐ。
