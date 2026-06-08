---
name: dev
description: feature-dev の上位互換となる「計画策定 + 実装 + セルフレビュー」一気通貫スキル。zeus-explorer でコードベース調査 (spec.md からの handoff なら spec が取った explorer 結果を再利用) → zeus-architect で実装ブループリント策定 → zeus-plan-reviewer が批判 + 修正版最終 plan を返す → メインスレッドが plan.md を直接実装 + 動作確認 (型/lint/test) + implementation.md 執筆 → zeus-reviewer でセルフレビュー → Critical 自動修正までを単一スキルで完走する。実装フェーズをメインスレッドが担うことで、explorer / architect / plan-review で築いた文脈をそのまま実装判断に活用し、レビュー指摘や修正ループでもブレない実装精度を保つ。EnterPlanMode は使わず bypassPermissions モード (リモート実行など) と両立する設計。不明な論点は AskUserQuestion で必ずユーザーに確認する
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
├── plan.md                    ← plan-reviewer Part 2 の修正版最終 plan をそのまま保存
├── raw/                       ← 計画フェーズの生レポート（全文保存）
│   ├── explorer.md            ← または explorer-1.md, explorer-2.md ... （並列起動時、自前で取った場合のみ）
│   ├── architect.md           ← architect の初回案
│   ├── plan-review.md         ← plan-reviewer の Part 1 (レビュー) + Part 2 (最終 plan)
│   └── architect-revised-{n}.md  ← 差し戻し再策定時のみ（n は 1 始まり）
├── implementation.md          ← 実装ログ・変更ファイル一覧・動作確認結果
├── review.md                  ← zeus-reviewer の生レポート
├── review-{n}.md              ← 修正後の再レビュー（n は 2 始まり）
└── fix-log.md                 ← 修正ループの履歴（修正があった場合のみ）
```

`spec.md` からの handoff の場合、spec が取った `raw/explorer.md` を再利用するため自前で explorer を起動しない (Phase 2 参照)。

`{slug}` はタスク内容の短い英語スラッグ（kebab-case, 30 文字以内）。

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Explorer | `zeus-explorer` | コードベース探索、必読ファイル抽出 (spec からの handoff 時は再起動しない) |
| Zeus Architect | `zeus-architect` | 複数観点を内包した実装ブループリント策定 (初回案のみ、self-critique は plan-reviewer に統合) |
| Zeus Plan Reviewer | `zeus-plan-reviewer` | architect 初回案を批判 + Critical/Warning を反映した修正版最終 plan までを返す |
| Zeus Reviewer | `zeus-reviewer` | logic / design / security / performance / maintainability を統合観点でレビュー |

実装フェーズ (Phase 7) は **メインスレッドが直接 Edit/Write で行う**。explorer / architect / plan-review で築いた文脈・設計判断の意図をそのまま実装に持ち込むことで、レビュー指摘の文脈共有と修正ループの精度を最大化する狙い。

## 実行フロー

### Phase 1: タスク受領

1. 引数なし → エラー終了「`/zeus:dev <task>` でタスクを指定してください」
2. 引数の文字列をタスク内容として確定
3. **spec.md からの handoff 判定**: 引数に `.claude/zeus/specs/.../spec.md` のパスが含まれていれば spec モードと判定し、その spec.md を Read してタスク詳細・採用技術・既存実装との関係を取り込む。同 spec ディレクトリ配下の `raw/explorer.md` も存在するか確認 (Phase 2 で再利用)
4. タスクから英語 slug を生成（kebab-case, 30 文字以内）
5. 作業ディレクトリを確定: `.claude/zeus/{YYYYMMDD-HHMMSS}-{slug}/`
6. `raw/` サブディレクトリも作成
7. タスク文字列が曖昧 / 制約が不明確な場合は `AskUserQuestion` で要件を確認 (何回聞いても良い)

### Phase 2: コードベース探索

#### spec.md からの handoff の場合 (推奨パス)

`spec.md` のディレクトリ配下に `raw/explorer.md` があれば、それをそのまま Read で取り込み、**自前で `zeus-explorer` を起動しない**。spec フェーズで既に同じタスク領域を調査済みなので二重探索を避ける。

- spec の `raw/explorer.md` から必読ファイル一覧を抽出 → メインが直接 Read
- 必要なら dev 側の `raw/explorer.md` にコピーまたはシンボリックリンク代わりに「spec 側を再利用」の旨を 1 行追記する形でも可
- 追加の探索が必要だと判断した場合 (spec から時間が経って差分がある / 追加領域が必要) のみ補完的に `zeus-explorer` を起動し、`raw/explorer-supplement.md` に保存

#### handoff でない / explorer.md が存在しない場合

`zeus-explorer` を起動してコードベースを読み解く。

- タスク領域が広い場合は複数並列起動可（領域を分けて同時調査）
- 領域が狭い場合は 1 体で十分

`zeus-explorer` は必読ファイル一覧 5-10 件を返す。
返ってきたファイル一覧はメインエージェントが直接 Read して深い文脈を作る。

生レポートを `raw/explorer.md`（並列時は `explorer-1.md` `explorer-2.md` ...）に全文保存。

### Phase 3: 実装ブループリント策定

`zeus-architect` を 1 体起動する。プロンプトには以下を含める:

- 実装したいタスク内容
- Phase 2 で得た主要ファイル一覧と要点サマリ
- **「作業前に必ず CLAUDE.md / プロジェクト規約を Read せよ」と再強調**

生レポートを `raw/architect.md` に全文保存。

### Phase 4: プランレビュー + 最終 plan 生成

`zeus-plan-reviewer` を起動。プロンプトには以下を含める:

- 元のタスク内容
- Phase 2 の `zeus-explorer` 結果（必読ファイルと要点）
- Phase 3 の architect 初回案
- 「architect 案を批判的にレビューし、Critical / Warning を反映した修正版最終 plan を Part 2 として返せ。self-critique フェーズはここに統合されている」

`zeus-plan-reviewer` は **Part 1 (レビュー結果) + Part 2 (修正版最終 plan)** の 2 部構成で返す。

生レポートを `raw/plan-review.md` に全文保存。

#### 判定別のアクション

| 判定 | アクション |
|---|---|
| **承認** | Part 2 の最終 plan をそのまま `plan.md` として Write → Phase 5 へ |
| **条件付き承認** | Part 2 の修正版最終 plan をそのまま `plan.md` として Write (Critical/Warning は plan-reviewer が既に反映済み) → Phase 5 へ |
| **差し戻し** | `AskUserQuestion` で「再策定する / 指摘を未解決リスクとして明記して進む / タスク見直し」を確認。再策定の場合は Part 1 の差し戻し理由を渡して `zeus-architect` を再起動、`raw/architect-revised-{n}.md` に保存 (n は 1 始まり) → 再度 plan-reviewer を起動。再策定後も差し戻されたら再度 `AskUserQuestion` |

メインがやることは「`plan-review.md` の Part 2 を `plan.md` として Write する」だけ。手動統合は不要。

### Phase 5: 実装フェーズ（メインスレッド直接実装）

メインスレッドが Phase 4 で確定した `plan.md` の実装を **直接 Edit/Write で行う**。
explorer / architect / plan-review で築いた文脈・設計判断の意図をそのまま実装に持ち込むことで、レビュー指摘の理解度と修正ループの精度を最大化する。

実装は以下のサブフェーズに分けて進める:

#### A. 事前整合性チェック

1. `plan.md` を再読し、ビルド順序を `TaskCreate` で展開
2. **raw レポートと必読ファイルは Phase 1〜4 までで既にメイン context に保有済み**。再 Read は不要 — Phase 2 で Read した必読ファイルや Phase 4 で plan-reviewer が指摘した Critical/Warning は、すでにメインスレッドの会話履歴に乗っている。新たに発生した疑問だけ Read で補う
3. 既存実装との衝突や前提の不一致を発見した場合は `AskUserQuestion` で「plan を上書く / 既存に合わせる / Phase 4 に戻って plan-reviewer に再策定させる」を確認

#### B. 実装

- ビルド順序に従って Edit / Write で実装
- 不明点 (命名 / 依存方向 / 例外処理の落とし所など plan で曖昧な点) は **必ず `AskUserQuestion`** で確認 (回数制限なし)
- plan からの逸脱は `AskUserQuestion` で確認した上で `implementation.md` に経緯を記録
- 1 サブタスク完了ごとに `TaskUpdate` で `completed` に進める

#### C. `implementation.md` 執筆

実装と並行して `implementation.md` を更新し、以下を全文記録する:

- 変更ファイル一覧 (パス + 1 行サマリ)
- 各ファイルでの **設計上の WHY** (なぜこの設計を選んだか / plan からの逸脱があれば理由)
- 実装中に判断した重要事項
- 残課題・規約衝突・未解決の論点

#### D. 動作確認

- 型 / lint / build / test を順に実行
- 結果を `implementation.md` の「動作確認結果」セクションに記録
- 自分の実装ミスによる失敗は **3 回まで自己修正**。それを超える場合は `AskUserQuestion` で「さらに修正試行 / Phase 6 のレビュー対象として diff を渡す / Phase 4 に戻って plan-reviewer に再策定させる」を確認
- 環境問題 / 既存リグレッション / plan 前提との食い違いと判断したら Phase 6 のレビュー対象として diff を引き渡す (reviewer が原因を特定 → 修正ループへ)

### Phase 6: セルフレビュー

`zeus-reviewer` を 1 体起動。プロンプトには以下を含める:

- plan.md の全文
- implementation.md の全文（動作確認結果も含む）
- 変更ファイル一覧と diff（`git diff` の出力。git 管理されていないファイルは Read 結果）

応答を省略せず全文 `.claude/zeus/{ts}-{slug}/review.md` に保存。

### Phase 7: 修正ループ

- **Critical は必ず自動修正**（自動進行、承認不要 — 動作を壊している指摘なので）
- **Phase 5 サブフェーズ D で検出された動作確認の失敗** も Critical として修正
- **Warning は `AskUserQuestion` で確認**: 「全部修正 / 個別に確認 / 後回し (Issue 化) / スコープ外として記録」
- **Info は記録のみで修正しない**

修正を行った場合、`fix-log.md` に「指摘 → 修正内容 → 該当ファイル」を記録。

修正実装はメインが直接 Edit/Write で行う (Phase 5 と同じ主体)。reviewer の指摘文脈をメインがそのまま保持しているため、修正判断のブレが起きにくい。大規模な再実装が必要な場合は `AskUserQuestion` で「メインで修正継続 / Phase 4 に戻って plan-reviewer に再策定させる」を確認する。

### Phase 8: 修正後の再レビュー（Critical / Warning 修正時のみ）

Phase 7 で **Critical または Warning を修正した場合のみ**、もう一度 `zeus-reviewer` を起動する。
これは「修正で別バグを生むリスク」を検出するため。

- プロンプトには「修正後の差分」「修正前の指摘」「修正内容」を渡す
- 応答は `review-{n}.md` として保存（n は 2 始まり）
- 再レビューでさらに Critical が出た場合は再修正 → 再レビューを Critical が無くなるまで繰り返す
- 各ラウンドの修正は `fix-log.md` に追記し、ラウンド数が判別できるようにする

修正がなかった場合は再レビューをスキップして終了。

## 動作原則

- **EnterPlanMode は使わない**: bypassPermissions モード (リモート実行など) と両立させるため
- **実装はメインスレッドが担う**: explorer / architect / plan-review で築いた文脈・設計判断の WHY をそのまま実装と修正ループに引き継ぐため。サブエージェント委譲は計画フェーズとレビューフェーズに限定
- **不明な論点は必ず AskUserQuestion で確認**: 回数に制限なし。「わからないまま自動進行」より「ユーザーに聞く」を優先
- **生レポート保存厳守**: explorer / architect / plan-reviewer / reviewer の応答は全文保存
- **Critical は自動修正、Warning は確認**: Critical は動作を壊しているため必ず修正、Warning は重要度を踏まえてユーザー判断
- **plan からの逸脱は確認 + 記録**: AskUserQuestion で確認した上で `implementation.md` に経緯を残す
- **git 操作は自動化しない**: commit / push / PR は別スキルへ案内のみ

## 他スキルからの呼び出し

`/zeus:spec` `/zeus:review` `/zeus:debug` などから handoff される際は、それらが生成した **生成物のパス** を引数に直接渡す (専用の handoff ファイルは生成しない):

| 元スキル | 渡すパス | dev での扱い |
|---|---|---|
| `/zeus:spec` | `.claude/zeus/specs/{ts}-{slug}/spec.md` | Phase 1 で Read してタスク詳細・採用技術を取り込み、Phase 2 で同ディレクトリ配下の `raw/explorer.md` を再利用 |
| `/zeus:review` | `.claude/zeus/reviews/{ts}-{mode}/review-validated.md` | Phase 1 で Read し、確定指摘を修正タスクとして扱う |
| `/zeus:debug` | `.claude/zeus/debug/{ts}-{slug}/debug-validated.md` | Phase 1 で Read し、root-cause / contributing-factor を修正タスクとして扱う |

```
Skill(skill="zeus:dev", args="<元タスク要約>。詳細は <生成物パス> を参照")
```
