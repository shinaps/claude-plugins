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
| Zeus Tech Surveyor | `zeus-tech-surveyor` | **新規性検出時のみ起動** — 採用 API / library / 言語機能が現代的で deprecated でないか、最新推奨パターンに従っているか、より良い代替があるかを WebSearch / WebFetch で調査 |
| Zeus Survey Validator | `zeus-survey-validator` | tech-surveyor の主張を出典 URL で再確認、情報の鮮度 / 主張の正確性を検証 |
| Zeus Review Validator | `zeus-review-validator` | reviewer の指摘を実コードと照合して事実確認・妥当性検証 (tech-survey 結果も統合) |

## ディレクトリ規約

```
.claude/zeus/reviews/{YYYYMMDD-HHMMSS}-{mode}/
├── input.md                  ← レビュー対象のサマリ
├── review.md                 ← zeus-reviewer の生レポート
├── tech-survey.md            ← zeus-tech-surveyor の生レポート (新規性検出時のみ)
├── tech-survey-validated.md  ← zeus-survey-validator の検証済みレポート (新規性検出時のみ)
└── review-validated.md       ← zeus-review-validator の検証済み指摘リスト (dev には直接このパスを渡す)
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

### Phase 3: zeus-reviewer + zeus-tech-surveyor を **並列起動**（一次レビュー）

両者は互いに独立した分析で、入力 (input.md) も共通。同じ Agent ツール呼び出しの **1 メッセージ内** で
2 つ並列に spawn して全体待ち時間を `max(reviewer, surveyor)` に圧縮する。

#### zeus-reviewer (logic / design / security / performance / maintainability)

プロンプトには以下を含める:

- レビューモード（branch / pr / path）
- `input.md` の全文
- モード別の追加指示:
  - **branch / PR**: 「変更差分（diff）の妥当性をレビュー」
  - **path**: 「フルコードを精査し、既存品質・技術的負債・改善点を指摘」

応答を省略せず全文 `.claude/zeus/reviews/{ts}-{mode}/review.md` に保存。

#### zeus-tech-surveyor (採用 API / library / 言語機能の現代性チェック)

**毎回起動する**。条件分岐で skip すると「既存パターンで使われているから」という理由で見落とすため、
レビュー対象の変更行に登場するすべての公開 API / library / 言語機能を一律で調査する。
WebSearch / WebFetch の time cost は reviewer と並列で吸収されるので実時間ロスは最小。

プロンプトには以下を含める:

- `input.md` の全文
- 「以下の観点で WebSearch / WebFetch で最新情報を調査せよ:
  - (a) 採用 API / library / 言語機能は **現代的か** (deprecated じゃないか、現在の公式推奨か)
  - (b) **より良い代替** (新しい標準 API / 軽量ライブラリ / 公式 first-party 機能) が出ていないか
  - (c) **既知の落とし穴 / 互換性問題 / known bugs** がないか (changelog / GitHub Issues)
  - (d) 採用しているバージョンが安全か (直近のリリース直後で breaking changes が報告されていないか)
  - **出典 URL を必ず付ける** (記事・公式ドキュメント・GitHub release notes など)
  - レビュー対象が小規模で調査対象が乏しい場合は『今回の変更には特筆すべき外部情報なし』と
    1 文で結論しても良い (無理に推奨案を捻り出さない)」

応答を省略せず全文 `.claude/zeus/reviews/{ts}-{mode}/tech-survey.md` に保存。

### Phase 3.5: zeus-survey-validator 起動（tech-survey の出典検証）

tech-surveyor の出力に **1 件でも具体的な推奨 / 警告 / 代替提案** が含まれる場合のみ起動する。
surveyor が「特筆事項なし」とだけ返した場合は省略。

`zeus-survey-validator` を 1 体起動。プロンプトには:

- `tech-survey.md` の全文
- 「全ての出典 URL を WebFetch で再確認し、(a) 記事の鮮度 (古すぎないか)、(b) 主張が実際に
  ソースに記載されているか、(c) deprecated 主張は本当にその API が deprecated なのか、を検証せよ。
  false claim / outdated source / cherry-picked context があれば指摘」

応答を省略せず全文 `.claude/zeus/reviews/{ts}-{mode}/tech-survey-validated.md` に保存。

### Phase 4: zeus-review-validator 起動（妥当性検証 + tech-survey 統合）

`zeus-review-validator` を 1 体起動。プロンプトには以下を含める:

- `input.md` の全文
- `review.md` の全文
- **`tech-survey-validated.md` の全文** (Phase 3.5 が起動した場合のみ。出典検証済みの「採用 API の現代性」
  「より良い代替の提案」を validator の判断材料に追加する。surveyor が「特筆事項なし」だった場合は省略)
- 「指摘ごとに該当コードを Read で確認し、confirmed / false positive / partial / out-of-scope に分類せよ。
  さらに見落としがあれば additional finding として追加せよ。tech-survey 結果に基づく **新規 finding**
  (例: "採用 API X は deprecated 予定、Y への移行を検討") もここで confirmed として登録する」

応答を省略せず全文 `.claude/zeus/reviews/{ts}-{mode}/review-validated.md` に保存。

### Phase 5: 次アクション選択

確定指摘（confirmed + partial + additional finding の Critical / Warning）が **1 件以上ある場合**、`AskUserQuestion` で次の選択を確認:

- **修正実装に進む（`/zeus:dev` へ橋渡し）**: 確定指摘を修正タスクとして `/zeus:dev` を起動
- **PR にコメント投稿する**（PR モードのみ）
- **ローカル保存のみで終了**

確定指摘が 0 件の場合は「指摘なし」と通知して終了。

### Phase 6: /zeus:dev への橋渡し（修正実装選択時）

中間ファイル (旧 `plan-handoff.md`) は生成しない。`Skill` ツールで `zeus:dev` を起動し、引数に `review-validated.md` のパスを直接渡す。

dev 側の Phase 1 で `review-validated.md` を Read して確定指摘を修正タスクとして取り込み、Phase 2-3 (explorer / architect) で指摘箇所のコードを再調査・修正計画を立てる。

引数例:

```
Skill(skill="zeus:dev", args="以下のレビュー指摘を修正する。詳細は .claude/zeus/reviews/{ts}-{mode}/review-validated.md を参照: {修正タスクの 1 行サマリ}")
```

### Phase 7: PR コメント投稿（PR モードかつ投稿選択時）

- `gh pr review <番号> --comment --body-file <review-validated.md>` で投稿
- 投稿前にコメント本文を確認（外部に影響する操作のため）
- 行コメント形式が必要なら `gh api` で個別投稿

## 動作原則

- **並列 + 検証パイプライン**: Phase 3 で reviewer と tech-surveyor を **1 メッセージ内で並列 spawn**、
  Phase 3.5 で survey-validator (出典検証)、Phase 4 で review-validator (false positive 排除 + tech-survey 統合)
- **tech-surveyor は毎回起動**: 「既存パターンだから」で skip すると見落とすため、レビュー対象に登場する
  API / library / 言語機能を一律で「現代性 / 代替 / 既知の落とし穴」観点で調査する。
  reviewer と並列なので実時間ロスは最小
- **survey-validator は surveyor の出力次第で省略可**: surveyor が「特筆事項なし」と返したら survey-validator
  も review-validator への tech-survey 入力もスキップ
- **生レポート保存厳守**: reviewer / surveyor / survey-validator / review-validator 全ての応答を全文保存
- **PR コメント投稿は要承認**: 外部影響のある操作は必ず確認
- **diff が空ならエラー終了**: 何もレビューせず終わる
