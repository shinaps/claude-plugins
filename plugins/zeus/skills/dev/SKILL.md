---
name: dev
description: feature-dev の上位互換となる「計画策定 + 実装 + セルフレビュー」一気通貫スキル。zeus-explorer でコードベース調査 → zeus-architect で実装ブループリント策定 → 第三者レビュー → 実装 → zeus-reviewer でセルフレビュー → Critical 自動修正までを単一スキルで完走する。EnterPlanMode は使わず bypassPermissions モード (リモート実行など) と両立する設計。不明な論点は AskUserQuestion で必ずユーザーに確認する
argument-hint: <実装したい機能・解決したい課題>
---

## 引数仕様

| 呼び出し | 動作 |
|---|---|
| `/zeus:dev <task>` | タスク内容を指定して計画策定 → 実装まで一気通貫実行 |
| `/zeus:dev` | エラー: 引数なし不可。タスクを渡すよう案内 |

引数の文字列がそのままタスクとして扱われる（自由記述、長文可）。

## ディレクトリ規約

```
.claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/
├── plan.md                    ← 統合プラン（Phase 6 で作成）
├── raw/                       ← 計画フェーズの生レポート（全文保存）
│   ├── explorer.md            ← または explorer-1.md, explorer-2.md ... （並列起動時）
│   ├── architect-initial.md
│   ├── architect-critique.md
│   ├── plan-review.md
│   └── architect-revised-{n}.md  ← 差し戻し再策定時のみ（n は 1 始まり）
├── implementation.md          ← 実装ログ・変更ファイル一覧・動作確認結果
├── review.md                  ← zeus-reviewer の生レポート
├── review-{n}.md              ← 修正後の再レビュー（n は 2 始まり）
└── fix-log.md                 ← 修正ループの履歴（修正があった場合のみ）
```

`{slug}` はタスク内容の短い英語スラッグ（kebab-case, 30 文字以内）。

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Explorer | `zeus-explorer` | コードベース探索、必読ファイル抽出 |
| Zeus Architect | `zeus-architect` | 複数観点を内包した実装ブループリント策定（初回 + self-critique） |
| Zeus Plan Reviewer | `zeus-plan-reviewer` | architect の plan を第三者視点で批判レビュー |
| Zeus Reviewer | `zeus-reviewer` | logic / design / security / performance / maintainability を統合観点でレビュー |

## 実行フロー

### Phase 1: タスク受領

1. 引数なし → エラー終了「`/zeus:dev <task>` でタスクを指定してください」
2. 引数の文字列をタスク内容として確定
3. タスクから英語 slug を生成（kebab-case, 30 文字以内）
4. 作業ディレクトリを確定: `.claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/`
5. `raw/` サブディレクトリも作成
6. タスク文字列が曖昧 / 制約が不明確な場合は `AskUserQuestion` で要件を確認 (何回聞いても良い)

### Phase 2: コードベース探索

`zeus-explorer` を起動してコードベースを読み解く。

- タスク領域が広い場合は複数並列起動可（領域を分けて同時調査）
- 領域が狭い場合は 1 体で十分

`zeus-explorer` は必読ファイル一覧 5-10 件を返す。
返ってきたファイル一覧はメインエージェントが直接 Read して深い文脈を作る。

生レポートを `raw/explorer.md`（並列時は `explorer-1.md` `explorer-2.md` ...）に全文保存。

### Phase 3: 実装ブループリント策定（初回）

`zeus-architect` を 1 体起動する。プロンプトには以下を含める:

- 実装したいタスク内容
- Phase 2 で得た主要ファイル一覧と要点サマリ
- **「作業前に必ず CLAUDE.md / プロジェクト規約を Read せよ」と再強調**

生レポートを `raw/architect-initial.md` に全文保存。

### Phase 4: Self-Critique（盲点炙り出し）

`zeus-architect` をもう一度起動。プロンプトには以下を含める:

- Phase 3 で出力された案の全文
- 「上記案を批判的に再評価せよ。盲点・落とし穴・トレードオフを徹底的に列挙し、修正が必要なら修正版を出せ」

生レポートを `raw/architect-critique.md` に全文保存。

### Phase 5: 第三者プランレビュー

`zeus-plan-reviewer` を起動。プロンプトには以下を含める:

- 元のタスク内容
- Phase 2 の `zeus-explorer` 結果（必読ファイルと要点）
- Phase 3 の初回案
- Phase 4 の self-critique 結果
- 「第三者視点で批判的にレビューせよ」

`zeus-plan-reviewer` は総合判定（承認 / 条件付き承認 / 差し戻し）と Critical / Warning / Info を返す。

生レポートを `raw/plan-review.md` に全文保存。

#### 判定別のアクション

| 判定 | アクション |
|---|---|
| **承認** | そのまま Phase 6 へ |
| **条件付き承認** | 指摘箇所を統合プランで反映して Phase 6 へ |
| **差し戻し** | `AskUserQuestion` で「再策定する / 指摘を未解決リスクとして明記して進む / タスク見直し」を確認。再策定の場合は指摘を渡して `zeus-architect` を再起動、`raw/architect-revised-{n}.md` に保存（n は 1 始まり）。再策定後も差し戻されたら再度 `AskUserQuestion` |

### Phase 6: 統合プラン作成

メインエージェントが `zeus-architect` の最終出力を中心に、`zeus-explorer` の発見・`zeus-plan-reviewer` の指摘も統合した最終的な実装プランを作成する。

- `zeus-architect` の最終案（self-critique 反映済み、差し戻し時は最後の再策定版）を基本構造として採用
- `zeus-plan-reviewer` の Critical / Warning 指摘を必ず反映
- 差し戻し後の未解決指摘は「未解決リスク」セクションに明記

統合プランを `.claude/zeus/{ts}-{slug}/plan.md` に保存。

### Phase 7: 実装事前チェック

1. Phase 6 で作成した `plan.md` から以下要素を抽出:
   - タスク理解
   - アーキテクチャ判断
   - 実装ブループリント（変更/新規ファイル一覧、ビルド順序）
   - テスト戦略
2. `raw/` の生レポート（explorer / architect / plan-reviewer）も改めて読む
3. plan の「変更/新規ファイル一覧」が示すファイルを全て事前 Read する
4. plan の「ビルド順序」を `TaskCreate` に展開して進捗管理を開始

**既存コードと plan の前提が食い違っていた場合**:
- plan で「新規作成」とされたファイルが既に存在 → `AskUserQuestion` で「既存実装を活かす / 上書き / 統合」を確認
- plan で「変更」とされたファイルが存在しない → `AskUserQuestion` で「該当部分スキップ / 新規作成として進む / タスク見直し」を確認
- 軽微な差分（フォーマット / 追記済み程度）は `implementation.md` に記録して自動進行

### Phase 8: 実装

plan の「ビルド順序」に従ってフェーズ順に実装する。

各フェーズ完了時に:
- `TaskUpdate` で進捗更新
- `implementation.md` の「変更ファイル」セクションに追記

実装中:
- plan に明示されていない設計判断が必要になった場合、まず `raw/` の関連レポートを参照
- それでも判断が割れる / 不明な場合は `AskUserQuestion` で必ずユーザーに確認 (回数に制限なし)
- plan からの **意図的な逸脱** が必要になった場合は `AskUserQuestion` で確認 + `implementation.md` に理由を記録

### Phase 9: 実装ログ保存

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

## 実装中の判断（plan に無かった論点）

- {論点}: {採用した選択肢 / ユーザー確認結果}

## 実装中に発見した課題

- {scope 外として残した項目}
```

### Phase 10: 動作確認（型チェック・ビルド・テスト）

プロジェクトに応じて以下のコマンドを順に試す（package.json / Makefile / pyproject.toml 等から検出）:

- 型チェック: `tsc --noEmit` / `mypy` / `cargo check` 等
- リント: `eslint` / `ruff` / `golangci-lint` 等
- ビルド: `npm run build` / `cargo build` 等（必要な場合）
- テスト: `npm test` / `pytest` / `cargo test` 等（plan で言及があれば）

検出方針:
- 利用可能なコマンドを試す。存在しないものは skip
- 失敗があれば `implementation.md` の「動作確認結果」セクションに記録
- **Critical な失敗（型エラー・テスト失敗等）は Phase 12 の修正ループへ繰り込む**

実行できるコマンドが何もないプロジェクトの場合は、その旨を `implementation.md` に記録してスキップ。

### Phase 11: セルフレビュー

`zeus-reviewer` を 1 体起動。プロンプトには以下を含める:

- plan.md の全文
- implementation.md の全文（動作確認結果も含む）
- 変更ファイル一覧と diff（`git diff` の出力。git 管理されていないファイルは Read 結果）

応答を省略せず全文 `.claude/zeus/{ts}-{slug}/review.md` に保存。

### Phase 12: 修正ループ

- **Critical は必ず自動修正**（自動進行、承認不要 — 動作を壊している指摘なので）
- **Phase 10 で検出された動作確認の失敗** も Critical として修正
- **Warning は `AskUserQuestion` で確認**: 「全部修正 / 個別に確認 / 後回し (Issue 化) / スコープ外として記録」
- **Info は記録のみで修正しない**

修正を行った場合、`fix-log.md` に「指摘 → 修正内容 → 該当ファイル」を記録。

### Phase 13: 修正後の再レビュー（Critical / Warning 修正時のみ）

Phase 12 で **Critical または Warning を修正した場合のみ**、もう一度 `zeus-reviewer` を起動する。
これは「修正で別バグを生むリスク」を検出するため。

- プロンプトには「修正後の差分」「修正前の指摘」「修正内容」を渡す
- 応答は `review-{n}.md` として保存（n は 2 始まり）
- 再レビューでさらに Critical が出た場合は再修正 → 再レビューを Critical が無くなるまで繰り返す
- 各ラウンドの修正は `fix-log.md` に追記し、ラウンド数が判別できるようにする

修正がなかった場合は再レビューをスキップして終了。

## 動作原則

- **EnterPlanMode は使わない**: bypassPermissions モード (リモート実行など) と両立させるため
- **不明な論点は必ず AskUserQuestion で確認**: 回数に制限なし。「わからないまま自動進行」より「ユーザーに聞く」を優先
- **生レポート保存厳守**: explorer / architect / plan-reviewer / reviewer の応答は全文保存
- **Critical は自動修正、Warning は確認**: Critical は動作を壊しているため必ず修正、Warning は重要度を踏まえてユーザー判断
- **plan からの逸脱は確認 + 記録**: AskUserQuestion で確認した上で `implementation.md` に経緯を残す
- **git 操作は自動化しない**: commit / push / PR は別スキルへ案内のみ

## 他スキルからの呼び出し

`/zeus:spec` `/zeus:tech-survey` `/zeus:review` `/zeus:debug` などから handoff される際は、それらが生成した `plan-handoff.md` のパスを引数に渡せばよい:

```
Skill(skill="zeus:dev", args="<元タスク要約>。詳細は .claude/zeus/.../plan-handoff.md を参照")
```
