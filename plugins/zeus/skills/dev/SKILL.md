---
name: dev
description: /zeus:plan が生成した plan.md を入力に、実装＋セルフレビューを実行する。複数レビューワーを並列起動し、修正ループを回してから完了する。plan.md 必須（単独起動不可）。
argument-hint: <.claude/zeus/{ts}-{slug}/plan.md または同ディレクトリパス>
---

# Zeus Dev スキル（実装＋セルフレビュー担当）

/zeus:plan が策定した統合プランを実装に落とすスキル。
plan.md に厳密に従って実装し、その後 **複数レビューワーを並列起動** してセルフレビュー。
重大指摘は修正ループで解消してから完了する。

zeus プラグインは計画と実装で 2 スキルに分かれている:

- **`/zeus:plan`**: 計画策定までを担う
- **`/zeus:dev`**（このスキル）: /zeus:plan の出力を入力に、実装＋セルフレビューを担う

## 重要: plan.md 必須

このスキルは **`/zeus:plan` を通したタスクしか受け付けない**。
plan.md がない場合、または読み込めない場合は **エラーで終了** し、
「先に `/zeus:plan <task>` を実行してください」とユーザーに案内する。

これは「計画不足のまま実装される事態」を防ぐ意図的な制約。

## 引数仕様

| 呼び出し | 動作 |
|---|---|
| `/zeus:dev <path/to/plan.md>` | 指定された plan.md を読み込んで実装開始 |
| `/zeus:dev <path/to/dir>` | ディレクトリ内の `plan.md` を読み込んで実装開始 |
| `/zeus:dev` | エラー: 引数なし不可。`/zeus:plan` の実行を案内して終了 |

引数のパスは絶対パスでも相対パスでも可。
プロジェクト直下の `.claude/zeus/{ts}-{slug}/plan.md` を想定。

## ディレクトリ規約

/zeus:plan が作成したディレクトリ `.claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/` を共有して使う。

```
.claude/zeus/{ts}-{slug}/
├── plan.md                 ← /zeus:plan が作成（入力）
├── raw/                    ← /zeus:plan の専門エージェント生レポート
│   ├── architect-{n}.md
│   ├── security.md
│   └── ...
├── implementation.md       ← /zeus:dev が作成: 実装ログ・変更ファイル一覧
├── review/                 ← /zeus:dev が作成: 各レビューワーの生レポート
│   ├── security.md
│   ├── logic.md
│   ├── performance.md
│   ├── design.md
│   └── maintainability.md
├── review-summary.md       ← /zeus:dev が作成: レビュー統合結果
└── fix-log.md              ← /zeus:dev が作成: 修正ループの履歴（修正があった場合のみ）
```

## レビューワーチーム

zeus 専用レビューエージェントを `~/.claude/agents/` に配置済み。
実装後のセルフレビューでは、以下の 5 体を **常に全員並列起動**。
（`/review` スキルと整合性のあるロール構成）

| エージェント | subagent_type | 主な分析内容 |
|---|---|---|
| Zeus Reviewer Security | `zeus-reviewer-security` | 脆弱性、認証認可、入力バリデーション、秘密情報の露出 |
| Zeus Reviewer Logic | `zeus-reviewer-logic` | バグ、エッジケース、データフロー、型整合性、状態管理 |
| Zeus Reviewer Performance | `zeus-reviewer-performance` | 計算量、N+1、不要な再計算、メモリ、キャッシュ活用 |
| Zeus Reviewer Design | `zeus-reviewer-design` | 責務分離、命名、API 設計、依存方向、既存パターンとの一貫性 |
| Zeus Reviewer Maintainability | `zeus-reviewer-maintainability` | 可読性、複雑度、重複、テスタビリティ、将来拡張性 |

## 実行フロー

### Phase 1: plan.md 読み込みと検証

1. 引数のパスを解決:
   - ファイル指定 → そのまま読む
   - ディレクトリ指定 → 配下の `plan.md` を読む
   - 引数なし → エラー終了 + `/zeus:plan` 案内
2. `plan.md` が存在しない/読めない → エラー終了 + `/zeus:plan` 案内
3. plan の以下要素を抽出:
   - タスク理解
   - 全エージェント合意の方針
   - 残ったトレードオフと判断
   - 実装ブループリント（変更/新規ファイル一覧、ビルド順序）
   - 観点別重要事項
   - テスト戦略
4. plan の **生レポート（`raw/`）も読む**。実装中に観点を見返すため
5. ユーザーに「plan を読み込みました。実装を開始します」と通知（承認は求めない）

### Phase 2: 実装事前チェック

1. plan の「変更/新規ファイル一覧」が示すファイルを **全て事前 Read** する
   - 既に実装済み・想定と異なる状態がないか確認
2. plan の「ビルド順序」を `TaskCreate` に展開して進捗管理を開始
3. 既存コードと plan の前提が大きく食い違っていた場合のみ `AskUserQuestion` で方針確認
   - それ以外は plan に従って自動進行

### Phase 3: 実装

plan の「ビルド順序」に従ってフェーズ順に実装する。

各フェーズ完了時に:
- `TaskUpdate` で進捗更新
- `implementation.md` の「変更ファイル」セクションに追記

実装中の原則:
- plan に明示されていない設計判断が必要になった場合、`raw/` の関連エージェントレポートを参照
- それでも判断不能なら `AskUserQuestion` で確認（質問の連発はしない）
- plan からの **意図的な逸脱** が必要になった場合は必ずユーザー確認 + `implementation.md` に理由を記録

### Phase 4: 実装ログ保存

`implementation.md` を以下の形式で完成させる:

```markdown
# 実装ログ

- plan: `./plan.md`
- 実装開始: {YYYY-MM-DD HH:MM:SS}
- 実装完了: {YYYY-MM-DD HH:MM:SS}

## 変更ファイル

- `path/to/new-file.ts` (新規) — {責務}
- `path/to/modified-file.ts` (変更) — {変更内容}

## plan からの逸脱（あれば）

- {逸脱箇所}: {理由 / ユーザー判断の経緯}

## 実装中に発見した課題

- {scope 外として残した項目}
```

### Phase 5: セルフレビュー（並列）

5 体の `zeus-reviewer-*` を **同一メッセージ内で並列起動** する。

各レビューワーへのプロンプトに含める情報:

- **plan.md の全文**
- **implementation.md の全文**
- **変更ファイル一覧と diff**（`git diff` の出力。git 管理されていないファイルは Read 結果）
- そのレビューワーの担当観点を再強調

各 `zeus-reviewer-*` エージェントは出力フォーマット（Critical/Warning/Info 別の指摘 + 修正方針）を既に内蔵しているので、追加指示は不要。

各レビューワーの応答を **省略せず全文** 以下に保存:

```
.claude/zeus/{ts}-{slug}/review/{role}.md
```

### Phase 6: レビュー統合

主体（あなた）が全レポートを読み比べ、`review-summary.md` に統合:

```markdown
# セルフレビュー統合結果

- レビュー時刻: {YYYY-MM-DD HH:MM:SS}
- レビューワー: security, logic, performance, design, maintainability

## Critical（修正必須）
- [observation by {role}] {問題と修正方針}

## Warning（改善推奨）
- [observation by {role}] {指摘と改善案}

## Info（参考情報）
- [observation by {role}] {提案}
```

同一指摘が複数観点から出ている場合は最も重要度の高い方に統合。
指摘なしのセクションは省略。

### Phase 7: 修正ループ

- **Critical があれば必ず修正**（自動進行、承認不要）
- **Warning がある場合のみ** `AskUserQuestion` で「修正する / スコープ外として記録 / 一部のみ修正」を確認
- **Info は記録のみで修正しない**

修正を行った場合:
- `fix-log.md` に「指摘 → 修正内容 → 該当ファイル」を記録
- 修正後にもう一度 `/review` 相当の軽量チェックは行わない（無限ループ回避）
  - ただし Critical を修正した場合は、影響範囲のレビューワーを 1 体だけ再走させる

### Phase 8: 完了報告と次アクション案内

ユーザーに以下を報告:

```
## /zeus:dev 完了

- plan: .claude/zeus/{ts}-{slug}/plan.md
- 実装ログ: .claude/zeus/{ts}-{slug}/implementation.md
- レビュー統合: .claude/zeus/{ts}-{slug}/review-summary.md
- 修正履歴: .claude/zeus/{ts}-{slug}/fix-log.md（修正があった場合）

### 次のステップ
- コミット: `/commit`
- PR 作成: `/create-pr`
```

`/commit` や `/create-pr` の自動起動は **しない**。CLAUDE.md ルールに従い、git 操作はユーザー判断で実行する。

## 動作原則

- **plan.md 必須**: 単独起動を許さない。/zeus:plan を必ず通す
- **plan に厳密に従う**: 逸脱は要承認 + 記録
- **重要ポイントだけ確認**: AskUserQuestion は本当に判断が必要な分岐だけ
- **生レポート保存厳守**: レビューワーの応答は全文保存
- **並列起動の徹底**: レビューワー 5 体は同一メッセージ内で並列起動
- **Critical は自動修正、Warning は確認**: 修正方針は重要度で切り替える
- **テキストでの承認質問は禁止**: 必ず AskUserQuestion を使う
- **git 操作は自動化しない**: commit / push / PR は別スキルへ案内のみ
