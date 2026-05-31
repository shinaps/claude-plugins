---
name: dev
description: feature-dev の上位互換となる「計画策定 + 実装 + セルフレビュー」一気通貫スキル。zeus-explorer でコードベース調査 → zeus-architect で実装ブループリント策定 → 第三者レビュー → 実装 → zeus-reviewer でセルフレビュー → Critical/Warning 自動修正までを単一スキルで完走する。ユーザーインタラクション最小・bypassPermissions と両立する設計
argument-hint: <実装したい機能・解決したい課題 | 既存 plan.md/ディレクトリパス>
---

# Zeus Dev スキル（計画策定 + 実装 + セルフレビュー）

公式 `feature-dev` の上位互換となる一気通貫スキル。
タスク受領からセルフレビュー完了までを **1 スキルで完走** する。

## 引数仕様

| 呼び出し | 動作 |
|---|---|
| `/zeus:dev <task>` | タスク内容を指定して計画策定 → 実装まで一気通貫実行（標準ルート） |
| `/zeus:dev <path/to/plan.md>` | 既存 `plan.md` を入力に実装フェーズから開始（再開・他スキルからの handoff） |
| `/zeus:dev <path/to/dir>` | ディレクトリ内の `plan.md` を読み込んで実装フェーズから開始 |
| `/zeus:dev` | エラー: 引数なし不可。タスク or plan.md を渡すよう案内 |

**引数判定ロジック**:
- 引数が既存ファイル（拡張子 `.md`）or 既存ディレクトリで `plan.md` を含む → **既存プランモード**（Phase 7 から開始）
- それ以外の文字列 → **新規タスクモード**（Phase 1 から開始）

引数のパスは絶対パスでも相対パスでも可。

## 設計の核

**ユーザーインタラクション最小**: `EnterPlanMode` / `AskUserQuestion` は原則使わない。
これにより以下を実現する:

- `bypassPermissions` モード（リモート実行等）で全フェーズが走り切る
- 一度起動したら完了まで自走する
- 細かい承認 UI が出ない

判断が必要な場面（差し戻し / Warning / 既存コードとの食い違い）は **自動既定アクション** で進む。
詳細は各 Phase の動作原則を参照。

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
├── review-{n}.md              ← 修正後の再レビュー（n は 2 始まり、Critical 修正があった場合のみ）
└── fix-log.md                 ← 修正ループの履歴（修正があった場合のみ）
```

`{slug}` はタスク内容の短い英語スラッグ（kebab-case, 30 文字以内）。
既存プランモードでは、引数の plan.md があるディレクトリをそのまま流用する。

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Explorer | `zeus-explorer` | コードベース探索、必読ファイル抽出 |
| Zeus Architect | `zeus-architect` | 複数観点を内包した実装ブループリント策定（初回 + self-critique） |
| Zeus Plan Reviewer | `zeus-plan-reviewer` | architect の plan を第三者視点で批判レビュー |
| Zeus Reviewer | `zeus-reviewer` | logic / design / security / performance / maintainability を統合観点でレビュー |

## 実行フロー

### Phase 0: モード判定

引数を解析してモードを決定:

1. 引数なし → エラー終了「`/zeus:dev <task>` または `/zeus:dev <plan.md>` を指定してください」
2. 引数が `.md` ファイルで存在 → **既存プランモード**（Phase 7 へジャンプ、Phase 1-6 はスキップ）
3. 引数がディレクトリで `plan.md` を含む → **既存プランモード**（Phase 7 へジャンプ）
4. 上記以外 → **新規タスクモード**（Phase 1 から実行）

### Phase 1: タスク受領（新規タスクモード）

1. 引数の文字列をタスク内容として確定
2. タスクから英語 slug を生成（kebab-case, 30 文字以内）
3. 作業ディレクトリを確定: `.claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/`
4. `raw/` サブディレクトリも作成

**AskUserQuestion による要件ヒヤリングは行わない**。
タスク文字列が曖昧でも explorer / architect / plan-reviewer に判断を委ねる。

### Phase 2: コードベース探索

`zeus-explorer` を起動してコードベースを読み解く。

- タスク領域が広い場合は **複数並列起動** 可（領域を分けて同時調査）
- 領域が狭い場合は 1 体で十分

`zeus-explorer` は出力ガイダンスに従って **必読ファイル一覧 5-10 件** を返す。
返ってきたファイル一覧は **主体（あなた）が直接 Read** して深い文脈を作る。

生レポートを `raw/explorer.md`（並列時は `explorer-1.md` `explorer-2.md` ...）に **全文保存**。

### Phase 3: 実装ブループリント策定（初回）

`zeus-architect` を 1 体起動する。
プロンプトには以下を含める:

- 実装したいタスク内容
- Phase 2 で得た主要ファイル一覧と要点サマリ
- **「作業前に必ず CLAUDE.md / プロジェクト規約を Read せよ」と再強調**

`zeus-architect` は複数観点を内部で検討した上で **唯一最強の単一案** を返す。

生レポートを `raw/architect-initial.md` に **全文保存**。

### Phase 4: Self-Critique（盲点炙り出し）

Phase 3 の結果を踏まえ、`zeus-architect` を **もう一度起動** する。
プロンプトには以下を含める:

- Phase 3 で出力された案の全文
- 「上記案を **批判的に再評価** せよ。盲点・落とし穴・トレードオフを徹底的に列挙し、修正が必要なら修正版を出せ」

`zeus-architect` は自分の前案を批判し、必要なら修正案を返す。
これにより初回の単一最強案では見落としていた論点を炙り出す。

生レポートを `raw/architect-critique.md` に **全文保存**。

### Phase 5: 第三者プランレビュー

Phase 4 までの成果（初回案 + self-critique）を踏まえ、`zeus-plan-reviewer` を起動する。
self-critique は同じ architect による自己批判のため **視点固定バイアス** が残る。
別人格のレビュアーで破る。

プロンプトには以下を含める:

- 元のタスク内容
- Phase 2 の `zeus-explorer` 結果（必読ファイルと要点）
- Phase 3 の初回案
- Phase 4 の self-critique 結果
- 「第三者視点で批判的にレビューせよ」

`zeus-plan-reviewer` は総合判定（承認 / 条件付き承認 / 差し戻し）と Critical / Warning / Info を返す。

生レポートを `raw/plan-review.md` に **全文保存**。

#### 判定別の自動アクション（AskUserQuestion なし）

| 判定 | 自動アクション |
|---|---|
| **承認** | そのまま Phase 6 へ |
| **条件付き承認** | 指摘箇所を統合プランで反映して Phase 6 へ |
| **差し戻し** | **最大 2 回まで自動再策定ループ**: レビュー指摘を渡して `zeus-architect` を再起動、`raw/architect-revised-{n}.md` に保存（n は 1 始まり）。2 回目でも差し戻されたら指摘を統合プランに「未解決リスク」として明記して Phase 6 へ進む |

ユーザーへの確認は挟まず、自動進行する。

### Phase 6: 統合プラン作成

主体（あなた）が `zeus-architect` の最終出力を中心に、`zeus-explorer` の発見・`zeus-plan-reviewer` の指摘も統合した
**最終的な実装プラン** を作成する。

- `zeus-architect` の最終案（self-critique 反映済み、差し戻し時は最後の再策定版）を基本構造として採用
- `zeus-plan-reviewer` の Critical / Warning 指摘を必ず反映
- 差し戻し後の未解決指摘は「未解決リスク」セクションに明記

統合プランを以下に保存:

```
.claude/zeus/{ts}-{slug}/plan.md
```

**`EnterPlanMode` は使わない**。プランは保存してそのまま Phase 7 に進む。
ユーザーへの承認確認は挟まない。

### Phase 7: 実装事前チェック

既存プランモードの場合はここから開始（引数の plan.md を起点に Phase 7-14 を実行）。

1. plan の以下要素を抽出:
   - タスク理解
   - アーキテクチャ判断
   - 実装ブループリント（変更/新規ファイル一覧、ビルド順序）
   - テスト戦略
2. plan の **生レポート（`raw/` があれば）も読む**。実装中に文脈を見返すため
3. plan の「変更/新規ファイル一覧」が示すファイルを **全て事前 Read** する
   - 既に実装済み・想定と異なる状態がないか確認
4. plan の「ビルド順序」を `TaskCreate` に展開して進捗管理を開始

**既存コードと plan の前提が食い違っていた場合の自動アクション**:
- plan で「新規作成」とされたファイルが既に存在 → 内容を確認し、既存実装を活かす方向で進む（diff を `implementation.md` の「plan からの逸脱」セクションに記録）
- plan で「変更」とされたファイルが存在しない → 該当部分はスキップして `implementation.md` に記録
- AskUserQuestion による確認は行わない

### Phase 8: 実装

plan の「ビルド順序」に従ってフェーズ順に実装する。

各フェーズ完了時に:
- `TaskUpdate` で進捗更新
- `implementation.md` の「変更ファイル」セクションに追記

実装中の原則:
- plan に明示されていない設計判断が必要になった場合、`raw/` の関連レポートを参照
- それでも判断不能なら **架構的に妥当な選択肢を採用** し、`implementation.md` の「実装中の判断」セクションに記録（AskUserQuestion はしない）
- plan からの **意図的な逸脱** が必要になった場合は `implementation.md` に理由を記録（ユーザー確認はしない）

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

- {逸脱箇所}: {理由 / 自動判断の根拠}

## 実装中の判断（plan に無かった論点）

- {論点}: {採用した選択肢 / 根拠}

## 実装中に発見した課題

- {scope 外として残した項目}
```

### Phase 10: 動作確認（型チェック・ビルド・テスト）

実装後、コードが実際に動く状態かを **自動検証** する。
プロジェクトに応じて以下のコマンドを順に試す（プロジェクトの package.json / Makefile / pyproject.toml 等から検出）:

- 型チェック: `tsc --noEmit` / `mypy` / `cargo check` 等
- リント: `eslint` / `ruff` / `golangci-lint` 等
- ビルド: `npm run build` / `cargo build` 等（必要な場合）
- テスト: `npm test` / `pytest` / `cargo test` 等（plan で言及があれば）

**検出方針**:
- 利用可能なコマンドを試す。存在しないものは skip
- 失敗があれば `implementation.md` の「動作確認結果」セクションに記録
- **Critical な失敗（型エラー・テスト失敗等）は自動修正対象** → Phase 12 の修正ループへ繰り込む

実行できるコマンドが何もないプロジェクトの場合は、その旨を `implementation.md` に記録してスキップ。

### Phase 11: セルフレビュー

`zeus-reviewer` を 1 体起動する。

プロンプトには以下を含める:

- **plan.md の全文**
- **implementation.md の全文**（動作確認結果も含む）
- **変更ファイル一覧と diff**（`git diff` の出力。git 管理されていないファイルは Read 結果）

`zeus-reviewer` は出力ガイダンスに従って Critical / Warning / Info を返す。
（confidence ≥ 80 のみ報告される設計）

応答を **省略せず全文** 以下に保存:

```
.claude/zeus/{ts}-{slug}/review.md
```

### Phase 12: 修正ループ（自動）

- **Critical があれば必ず修正**（自動進行、承認不要）
- **Phase 10 で検出された動作確認の失敗** も Critical として修正
- **Warning も自動修正**（ユーザー確認なし。インタラクション最小化方針）
- **Info は記録のみで修正しない**

修正を行った場合:
- `fix-log.md` に「指摘 → 修正内容 → 該当ファイル」を記録

### Phase 13: 修正後の再レビュー（Critical / Warning 修正時のみ）

Phase 12 で **Critical または Warning を修正した場合のみ**、もう一度 `zeus-reviewer` を起動する。
これは「修正で別バグを生むリスク」を検出するため。

- プロンプトには「修正後の差分」「修正前の指摘」「修正内容」を渡す
- 応答は `review-{n}.md` として保存（n は 2 始まり、初回 review.md の続き番号）
- 再レビューでさらに Critical が出た場合は再修正 → 再レビューを Critical が無くなるまで繰り返す
- 各ラウンドの修正は `fix-log.md` に追記し、ラウンド数が判別できるようにする

Critical / Warning 修正がなかった場合は再レビューをスキップして Phase 14 へ。

### Phase 14: 完了報告

ユーザーに以下を報告:

```
## /zeus:dev 完了

- plan: .claude/zeus/{ts}-{slug}/plan.md
- 生レポート: .claude/zeus/{ts}-{slug}/raw/
- 実装ログ: .claude/zeus/{ts}-{slug}/implementation.md
- レビュー: .claude/zeus/{ts}-{slug}/review.md
- 再レビュー: .claude/zeus/{ts}-{slug}/review-{n}.md（Critical/Warning 修正があった場合、n は 2 始まり）
- 修正履歴: .claude/zeus/{ts}-{slug}/fix-log.md（修正があった場合）

### 次のステップ
- コミット: `/commit`
- PR 作成: `/create-pr`
```

`/commit` や `/create-pr` の自動起動は **しない**。CLAUDE.md ルールに従い、git 操作はユーザー判断で実行する。

## 動作原則

- **ユーザーインタラクション最小**: `EnterPlanMode` / `AskUserQuestion` は使わない。判断が必要な場面は自動既定アクションで進む
- **bypassPermissions と両立**: プランモードに入らない設計なので、リモート bypassPermissions モードでも完走する
- **生レポート保存厳守**: explorer / architect / plan-reviewer / reviewer の応答は全文保存。後から議論の足跡を辿れることが価値
- **統合プランは単一案**: A/B 案を残すのは plan-reviewer で「未解決リスク」として明記された場合だけ
- **Critical / Warning は自動修正**: Info のみ記録扱い。修正後は必ず再レビュー
- **plan からの逸脱は記録、確認は不要**: 自動判断の根拠を `implementation.md` に残す
- **git 操作は自動化しない**: commit / push / PR は別スキルへ案内のみ

## 他スキルからの呼び出し

`/zeus:spec` `/zeus:tech-survey` `/zeus:review` `/zeus:debug` などから handoff される際は、
それらが生成した `plan-handoff.md` のパスを引数に渡せばよい:

```
Skill(skill="zeus:dev", args="<元タスク要約>。詳細は .claude/zeus/.../plan-handoff.md を参照")
```

`/zeus:dev` は引数文字列をそのままタスクとして受領し、新規タスクモードで計画策定から実装まで一気通貫で実行する。

## ultraplan / feature-dev / 旧 /zeus:plan からの移行

| 旧 | 新 |
|---|---|
| `/ultraplan <task>` | `/zeus:dev <task>` |
| `/feature-dev <task>` | `/zeus:dev <task>` |
| `/zeus:plan <task>` + `/zeus:dev <plan.md>` の 2 ステップ | `/zeus:dev <task>` の 1 ステップ |

旧 `/zeus:plan` で作成済みの `plan.md` がある場合は `/zeus:dev <path/to/plan.md>` で実装フェーズだけ実行できる。
