# Zeus

公式 `feature-dev` の **上位互換** となる Claude Code プラグイン。
要件定義 → 技術選定 → 実装計画策定 → 実装 → セルフレビュー → PR 監視 → PM までを `spec.md` / `plan.md` / `.zeus/review-memory.md` / `.zeus/pm/` を介して連携する 9 スキル構成。

## 構成

| スキル | 役割 |
|---|---|
| `/zeus:spec [要望]` | ざっくりした要望を対話的なヒアリングで詰めて仕様書化。`zeus-spec-writer` で構造化し、そのまま `/zeus:tech-survey` / `/zeus:plan` へ橋渡し可能 |
| `/zeus:tech-survey [spec.md/要望]` | WebSearch / WebFetch で最新情報を集めてライブラリ・フレームワーク・サービスの候補を観点別に比較。`zeus-tech-surveyor` + `zeus-survey-validator` で鮮度・出典の妥当性も検証 |
| `/zeus:plan <task>` | `zeus-explorer` でコードベース調査 → `zeus-architect` で実装計画策定。`plan.md` を永続化して次工程に渡す |
| `/zeus:dev <plan.md>` | `/zeus:plan` の出力を入力に、plan に厳密に従って実装し、`zeus-reviewer` でセルフレビュー → 修正ループ |
| `/zeus:review [PR/path]` | plan 不要の単独レビュー。引数なしで現ブランチ diff、数字で GitHub PR、パスで既存コードを `zeus-reviewer` + `zeus-review-validator` でレビュー、`/zeus:plan` 橋渡しも可能 |
| `/zeus:pr-review <PR番号>` | GitHub PR への **CodeRabbit ライク自動レビュー投稿**。fresh / re-review / comment-response の 3 モード自動判定。`.zeus/review-memory.md` で won't-fix / プロジェクト方針を蓄積し他 PR でも活用 |
| `/zeus:pr-watch [interval\|--once]` | open PR を定期スキャンして未レビュー PR / 新コミット / 新コメントを検出し `/zeus:pr-review` に委譲。**起動するだけで内部 `/loop` を自動セットアップ**（default 5 分、`--once` で 1 サイクル）。トリガーコメント不要で全 open PR を自動レビュー（CodeRabbit 同等運用） |
| `/zeus:pm-init [team\|personal\|both]` | プロジェクトに Zeus PM を初期化。`.zeus/pm/`（チーム共有 / commit）または `.zeus/pm-local/`（個人 / gitignore）に state / roadmap / decisions / workflow のスケルトンを生成し、CLAUDE.md にマーカー付きで PM 利用ルールを挿入 |
| `/zeus:pm [sync\|decision\|done\|next\|status]` | PM 日常運用。引数なしで `zeus-pm` がブリーフィング、`sync` で git 活動から状態更新、`decision <text>` で意思決定ログ、`done <task>` で完了マーク、`next <text>` で roadmap 追加 |

## 同梱エージェント (9 体)

このプラグイン内に同梱されているので、インストールするだけで使える。

| エージェント | 役割 |
|---|---|
| `zeus-spec-writer` | ヒアリング結果を構造化された仕様書（機能要件 / 非機能要件 / スコープ / 制約 / 受け入れ条件）に整理 |
| `zeus-tech-surveyor` | WebSearch / WebFetch で最新情報を集めてライブラリ・フレームワーク・サービスを観点別に比較する一次レポートを作成 |
| `zeus-survey-validator` | tech-surveyor の主張を出典 URL で再確認し、鮮度・正確性を検証（outdated / inaccurate / unverifiable / additional finding） |
| `zeus-explorer` | コードベース探索、必読ファイル抽出 |
| `zeus-architect` | 複数観点を内包した実装ブループリント策定（単一最強案を断言、self-critique も担当） |
| `zeus-plan-reviewer` | architect の plan を第三者視点で批判レビュー（差し戻し / 条件付き承認 / 承認） |
| `zeus-reviewer` | logic / design / security / performance / maintainability を統合観点でレビュー（confidence ≥ 80 でフィルタ） |
| `zeus-review-validator` | reviewer の指摘を実コードと照合して事実確認・妥当性検証（false positive 排除 + 追加発見） |
| `zeus-pm` | `.zeus/pm/` + `.zeus/pm-local/` を読んで brief / sync / decision の 3 モードで PM 状態を整形（書き換えはスキル側が責任を持つ） |

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

### 0. 仕様策定（要望が曖昧なとき）

```
/zeus:spec 通知機能を追加したい
```

`/zeus:spec` が以下を自動実行する:

1. 初期要望の受領（引数なしなら `AskUserQuestion` で確認）
2. **段階的ヒアリング**（機能要件 / ユーザー / スコープ / 優先度 / 制約 / 非機能要件 / 受け入れ条件 を順次確認）
3. `zeus-spec-writer` で構造化された仕様書を作成
4. `EnterPlanMode` で仕様書承認
5. そのまま `/zeus:plan` に橋渡し可能（or ローカル保存のみで終了）

要件が既に明確な場合はスキップして直接 `/zeus:plan` を呼ぶ方が速い。

### 0.5. 技術選定（使う技術が未定のとき）

```
/zeus:tech-survey                                                # interactive: 何を選定したいか聞かれる
/zeus:tech-survey .claude/zeus/specs/{ts}-{slug}/spec.md         # spec モード: spec.md の未確定論点を抽出して調査
/zeus:tech-survey "Next.js 用の認証ライブラリを比較したい"          # freeform モード
```

`/zeus:tech-survey` が以下を自動実行する:

1. 引数判定（なし=interactive / `.md` パス=spec / その他=freeform）
2. `input.md` に調査対象と既知の制約を記録
3. `zeus-tech-surveyor` を起動して候補列挙＋観点別比較レポート作成（WebSearch / WebFetch で公式情報を取得）
4. `zeus-survey-validator` を起動して出典 URL を再確認し、鮮度・正確性を検証
5. 結果を `.claude/zeus/tech-surveys/{ts}-{slug}/` に保存
6. `EnterPlanMode` で採用候補を承認 UI に提示
7. 次アクションを確認:
   - **spec.md に追記して `/zeus:plan` へ橋渡し**（spec モード時の Recommended）
   - **tech-decision.md として独立保存して `/zeus:plan` へ橋渡し**
   - **保存のみで終了**

要件と技術の両方が固まっていれば、このスキルをスキップして直接 `/zeus:plan` を呼ぶ方が速い。

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
8. **Critical 修正があれば再レビュー**（修正で生んだ別バグを検出、Critical が無くなるまで繰り返し）
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

### 4. GitHub PR への自動レビュー投稿

```
/zeus:pr-review 42                                          # 現在の repo の PR #42
/zeus:pr-review https://github.com/owner/repo/pull/42       # 他 repo の PR
```

`/zeus:pr-review` が以下を自動実行する:

1. PR 取得 + 認証チェック（`gh` CLI）
2. `.zeus/review-memory.md`（プロジェクトメモリ）を読み込み
3. **モード自動判定**:
   - `fresh`: 過去に zeus レビュー無し → 全 diff をレビュー
   - `re-review`: zeus レビュー済みだが head SHA が変わった → 前回レビュー以降の diff だけレビュー
   - `comment-response`: SHA は同じだがユーザーが新規コメント → コメント分類して won't-fix / 方針はメモリへ、修正要求は再レビュー
4. `zeus-reviewer` + `zeus-review-validator` で精度の高い指摘リスト作成
5. メモリの `Won't Fix Patterns` / `Project Conventions` で再フィルタ（重複指摘の排除）
6. 依存マニフェスト変更があれば `zeus-tech-surveyor` で追加調査（必要時のみ）
7. **CodeRabbit ライクな inline + summary コメント** を整形（投稿前承認 UI は **挟まず即投稿**、unattended 運用前提）
8. `gh api` で inline comment 個別投稿 + summary review 投稿
9. 各 inline / summary に `<!-- zeus:pr-review reviewed-sha=... -->` / `<!-- zeus:finding fingerprint=... -->` を埋め込んで状態管理（**ローカル状態ファイル無し**）

事前にレビュー内容だけ確認したい場合は `/zeus:review <PR番号>`（投稿しないローカル保存型）を使う。

#### プロジェクトメモリ `.zeus/review-memory.md`

`/zeus:pr-review` の comment-response モードで、ユーザーの返信が:

- 「これはプロジェクト方針」「うちは○○を使う」→ `Project Conventions` に追記
- 「これは意図的」「won't fix」「修正しない」→ `Won't Fix Patterns` に追記

として自動的にこのファイルに蓄積される。**他 PR のレビューでも自動で読み込まれ、同じ指摘を繰り返さない**。
チームで共有したい場合は `.zeus/review-memory.md` をコミットすればよい（自動コミットはしない、`git add` まで）。

### 5. PR 監視ループ（常駐レビュアー化）

```
/zeus:pr-watch                                              # 5 分おき loop で常駐 (デフォルト)
/zeus:pr-watch 15m                                          # 15 分おき loop
/zeus:pr-watch 1h                                           # 1 時間おき loop
/zeus:pr-watch --once                                       # 1 サイクルだけ実行
/zeus:pr-watch repo:owner/another                           # 他リポジトリ
```

`/zeus:pr-watch` が以下を自動実行する:

1. **モード判定**: 引数なし or `<interval>` のみなら loop モード、`--once` なら単発モード
2. ユーザーに loop 開始通知（停止方法: Esc / 新規メッセージ送信）
3. open かつ非 draft かつ非 bot 作成の PR を `gh pr list` で列挙
4. 各 PR について以下のトリガーを評価:
   - `fresh-review`: zeus レビューがまだ無い PR（**トリガーコメント不要、全 open PR が対象**）
   - `re-review`: zeus レビュー済みだが head SHA が変わった
   - `comment-response`: zeus レビュー済みで、SHA は同じだが新規ユーザーコメントあり
5. アクション対象が **6 件以上** あれば `AskUserQuestion` で「全件処理 / 上位 5 件 / キャンセル」を確認（初回スパム防止）
6. トリガー検出した PR を `/zeus:pr-review <N>` に順次委譲（**投稿前承認 UI は挟まず即投稿**、unattended 運用前提）
7. loop モードならサイクル完了後に `Skill` ツール経由で `/loop {interval} /zeus:pr-watch --once` を起動して常駐化
8. 状態は **すべて GitHub 側の HTML マーカーから再構築** するためローカル状態ファイル無し → ループが落ちても再起動で完全復旧

PR を open するだけで次のスキャンサイクルで自動レビューが走る（コメントトリガー不要）。
レビューに対してユーザーが「これは方針」と返信すれば、次サイクルで `.zeus/review-memory.md` に学習が蓄積される。
特定 PR を即時レビューしたい場合は `/zeus:pr-review 42` で直接呼び出すこともできる。

### 6. プロジェクト PM（セッション横断のコンテキスト管理）

```
/zeus:pm-init                    # interactive: team / personal / both を選択
/zeus:pm-init team               # チーム共有 (commit)
/zeus:pm-init personal           # 個人 (gitignore)

/zeus:pm                         # ブリーフィング: いま何やってる / 次やる / 進め方
/zeus:pm sync                    # 直近の git 活動から state.md 更新案
/zeus:pm decision <text>         # 意思決定ログを decisions.md に追記
/zeus:pm done <task>             # state.md の進行中タスクを完了マーク
/zeus:pm next <text>             # roadmap.md に項目追加
/zeus:pm status                  # ファイル別の軽量サマリ
```

`/zeus:pm-init` を 1 回実行すると以下が整う:

1. `.zeus/pm/`（team）または `.zeus/pm-local/`（personal、gitignore 済み）に 4 ファイルのスケルトン生成:
   - `state.md` — 現在のフォーカス、進行中タスク、ブロッカー、最近完了
   - `roadmap.md` — 次にやる候補（短期 / 中期 / 長期 / 却下）
   - `decisions.md` — 意思決定ログ（なぜ X を選んだか）
   - `workflow.md` — このプロジェクトの進め方・規約
2. `CLAUDE.md` に `<!-- zeus-pm:start --> ... <!-- zeus-pm:end -->` マーカーで PM 利用ルールを挿入
3. ルールに従って Claude が **毎セッション開始時に PM を自動参照** し、作業区切りで `/zeus:pm sync` `/zeus:pm decision` を呼ぶ習慣を持つ

#### 「ユーザーが意識しなくても PM が把握する」を実現する仕組み

- **セッション開始時**: Claude が CLAUDE.md を読み → ルールに従って `.zeus/pm/state.md` を自動参照 → 曖昧な質問は PM の内容から答える
- **作業完了時**: CLAUDE.md のルールにより、タスク完了 / 意思決定 / 新タスク追加のタイミングで Claude が `/zeus:pm done` 等の呼び出しを提案する
- **personal overlay**: `.zeus/pm-local/` がある場合は team の同名ファイルより優先される（チーム共有 + 個人スクラッチを両立）

#### team / personal / both の使い分け

| モード | 用途 |
|---|---|
| `team` | チーム共有の公式コンテキスト。`/zeus:pm-init team` で `.zeus/pm/` を作成、git commit して共有 |
| `personal` | 個人プロジェクト or 公にしたくない作業メモ。`/zeus:pm-init personal` で `.zeus/pm-local/` を作成、自動で .gitignore に登録 |
| `both` | OSS / 複数人プロジェクトで「チーム共有の公式情報」と「個人的なメモ・思考」を併用したい場合 |

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
│   └── architect-revised-{n}.md  ← 差し戻し時のみ（n は 1 始まり）
├── implementation.md       ← /zeus:dev が作成（動作確認結果も含む）
├── review.md               ← /zeus:dev が作成
├── review-{n}.md           ← Critical 修正後の再レビュー（あれば、n は 2 始まり）
└── fix-log.md              ← 修正ループの履歴
```

`/zeus:spec` の生成物:

```
.claude/zeus/specs/{ts}-{slug}/
├── spec.md                 ← 構造化された仕様書
├── interview-log.md        ← ヒアリングのやりとり記録
└── plan-handoff.md         ← /zeus:plan 橋渡し時の引き継ぎ
```

`/zeus:review` の生成物:

```
.claude/zeus/reviews/{ts}-{mode}/
├── input.md                ← レビュー対象のサマリ
├── review.md               ← zeus-reviewer の一次レビュー
├── review-validated.md     ← zeus-review-validator の検証済み指摘
└── plan-handoff.md         ← /zeus:plan へ橋渡し時の修正タスク記述
```

`/zeus:tech-survey` の生成物:

```
.claude/zeus/tech-surveys/{ts}-{slug}/
├── input.md                ← 調査対象と既知の制約のサマリ
├── survey.md               ← zeus-tech-surveyor の一次調査レポート
├── survey-validated.md     ← zeus-survey-validator の検証済みレポート
├── tech-decision.md        ← 採用決定の記録（独立保存選択時のみ）
└── plan-handoff.md         ← /zeus:plan へ橋渡し時の引き継ぎ
```

`/zeus:pr-review` の生成物:

```
.claude/zeus/pr-reviews/{ts}-{repo-slug}-{N}-{mode}/
├── input.md                ← PR 情報・diff・モード判定の根拠
├── memory-snapshot.md      ← その時点の .zeus/review-memory.md
├── review.md               ← zeus-reviewer の一次レポート
├── review-validated.md     ← zeus-review-validator の検証済み指摘
├── findings-filtered.md    ← メモリ照合で除外/減衰した指摘の最終リスト
├── comments-payload.md     ← 投稿前の inline + summary 完成形プレビュー
└── memory-diff.md          ← comment-response モード時のメモリ追記差分
```

プロジェクトメモリ（リポジトリルートに作成。git で共有可能）:

```
.zeus/review-memory.md      ← Project Conventions / Won't Fix Patterns を蓄積
```

Zeus PM の生成物（`/zeus:pm-init` がスケルトン生成、`/zeus:pm` で日常更新）:

```
.zeus/pm/                   ← team モード (git commit)
├── state.md                ← 現在のフォーカス・進行中・ブロッカー・最近完了
├── roadmap.md              ← 次にやる候補 (短期 / 中期 / 長期 / 却下)
├── decisions.md            ← 意思決定ログ (時系列降順)
└── workflow.md             ← 進め方・規約 (ブランチ運用 / レビュー / デプロイ)

.zeus/pm-local/             ← personal モード (gitignore)
├── state.md                ← personal overlay (team を上書き)
├── scratch.md              ← 走り書き・アイデア
└── ...                     ← 他は personal だけのファイル
```

CLAUDE.md には `<!-- zeus-pm:start --> ... <!-- zeus-pm:end -->` マーカーで PM 利用ルールが挿入され、Claude がセッション開始時に PM を自動参照する。

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
