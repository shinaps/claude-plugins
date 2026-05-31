---
name: review
description: zeus-reviewer + zeus-review-validator で精度の高い単独レビューを行うスキル。差分・PR・既存コードを引数で切り替え。確定指摘があればそのまま /zeus:dev へ橋渡しして修正計画 + 実装まで進められる
argument-hint: <なし | PR番号 | ファイル/ディレクトリパス>
---

## 引数仕様と動作モード

| 呼び出し | モード | 動作 |
|---|---|---|
| `/zeus:review` | branch | `git diff <base>...HEAD` を取得してレビュー |
| `/zeus:review <PR番号>` | PR | GitHub PR の diff をフェッチしてレビュー |
| `/zeus:review <path>` | path | 指定パス配下のファイルをフルコードレビュー |

引数の型判定:
- 引数なし → branch モード
- 数字のみ（例: `42`）→ PR モード
- それ以外 → path モード

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Reviewer | `zeus-reviewer` | logic / design / security / performance / maintainability を統合観点でレビュー |
| Zeus Review Validator | `zeus-review-validator` | reviewer の指摘を実コードと照合して事実確認・妥当性検証 |

## ディレクトリ規約

```
.claude/zeus/reviews/{YYYYMMDD-HHMMSS}-{mode}/
├── input.md              ← レビュー対象のサマリ
├── review.md             ← zeus-reviewer の生レポート
├── review-validated.md   ← zeus-review-validator の検証済み指摘リスト
└── plan-handoff.md       ← /zeus:dev へ引き継ぐ修正タスク記述（橋渡し時のみ）
```

`{mode}` は `branch` / `pr-{N}` / `path-{slug}` のいずれか。

## 実行フロー

### Phase 1: 引数判定とレビュー対象の取得

#### branch モード（引数なし）
1. ベースブランチを判定:
   - `git symbolic-ref refs/remotes/origin/HEAD` → デフォルトブランチ
   - 取れなければ `main` にフォールバック
2. `git diff <base>...HEAD` を取得
3. `git diff --stat <base>...HEAD` で変更ファイル一覧を取得
4. **diff が空の場合はエラー終了**: 「現ブランチに変更がありません」と通知

#### PR モード（引数が数字）
1. `gh pr view <番号> --json title,body,headRefName,files,additions,deletions` で PR メタ情報取得
2. `gh pr diff <番号>` で diff 取得
3. `gh` コマンドが利用できない、または PR が存在しない場合はエラー終了

#### path モード（引数がパス）
1. パスが存在するか確認
2. ファイルなら Read で読む
3. ディレクトリなら配下のソースコードファイルを再帰的に列挙して読む
4. **50 ファイル超えたら** `AskUserQuestion` で「全部読む / 範囲を絞る / キャンセル」を確認

### Phase 2: 入力サマリ保存

```markdown
# レビュー対象

- モード: {branch / pr-{N} / path-{slug}}
- 取得時刻: {YYYY-MM-DD HH:MM:SS}

## 対象情報

{モード別のメタ情報: ベースブランチ / PR タイトル / パス一覧 など}

## 変更ファイル / 対象ファイル

- `path/to/file.ts`
- ...

## diff / コード本体

{diff の内容、または対象ファイルのコード}
```

### Phase 3: zeus-reviewer 起動（一次レビュー）

`zeus-reviewer` を 1 体起動。プロンプトには以下を含める:

- レビューモード（branch / pr / path）
- `input.md` の全文
- モード別の追加指示:
  - **branch / PR**: 「変更差分（diff）の妥当性をレビュー」
  - **path**: 「フルコードを精査し、既存品質・技術的負債・改善点を指摘」

応答を省略せず全文 `.claude/zeus/reviews/{ts}-{mode}/review.md` に保存。

### Phase 4: zeus-review-validator 起動（妥当性検証）

`zeus-review-validator` を 1 体起動。プロンプトには以下を含める:

- `input.md` の全文
- `review.md` の全文
- 「指摘ごとに該当コードを Read で確認し、confirmed / false positive / partial / out-of-scope に分類せよ。さらに見落としがあれば additional finding として追加せよ」

応答を省略せず全文 `.claude/zeus/reviews/{ts}-{mode}/review-validated.md` に保存。

### Phase 5: 次アクション選択

確定指摘（confirmed + partial + additional finding の Critical / Warning）が **1 件以上ある場合**、`AskUserQuestion` で次の選択を確認:

- **修正実装に進む（`/zeus:dev` へ橋渡し）**: 確定指摘を修正タスクとして `/zeus:dev` を起動
- **PR にコメント投稿する**（PR モードのみ）
- **ローカル保存のみで終了**

確定指摘が 0 件の場合は「指摘なし」と通知して終了。

### Phase 6: /zeus:dev への橋渡し（修正実装選択時）

1. `review-validated.md` の確定指摘を整理し、`plan-handoff.md` に保存:

```markdown
# レビュー指摘修正タスク

- 元レビュー: .claude/zeus/reviews/{ts}-{mode}/review-validated.md
- 対象: {branch / pr-{N} / path-{slug}}

## 修正対象の指摘

### Critical
- [logic] `path/to/file.ts:42` — {問題と修正方針}

### Warning
- [design] `path/to/another.ts:10` — {問題と修正方針}

### 追加発見
- [security] `path/to/xxx.ts:88` — {問題と修正方針}

## 修正方針サマリ

{全体としてどう修正すべきか、優先順位など}
```

2. `Skill` ツールで `zeus:dev` を起動:
   - 引数例: 「以下のレビュー指摘を修正する。詳細は `.claude/zeus/reviews/{ts}-{mode}/plan-handoff.md` を参照: {修正タスクの 1 行サマリ}」

### Phase 7: PR コメント投稿（PR モードかつ投稿選択時）

- `gh pr review <番号> --comment --body-file <review-validated.md>` で投稿
- 投稿前にコメント本文を確認（外部に影響する操作のため）
- 行コメント形式が必要なら `gh api` で個別投稿

## 動作原則

- **2 段階レビュー**: reviewer → validator で false positive を排除
- **生レポート保存厳守**: reviewer / validator 両方の応答を全文保存
- **PR コメント投稿は要承認**: 外部影響のある操作は必ず確認
- **diff が空ならエラー終了**: 何もレビューせず終わる
