# pm

プロジェクトの **継続的なコンテキスト管理** を行う Claude Code プラグイン。
「いま何やってる / 次やる / 進め方 / 過去の意思決定」をセッション横断で `.pm/` と `.pm-local/` に蓄積し、Claude が毎セッション開始時に自動参照する。

他プラグイン (zeus など) から独立して動作する。

## 構成

3 スキル + 1 エージェントのシンプル設計:

| スキル | 役割 |
|---|---|
| `/pm:init [team\|personal]` | 初回セットアップ。`.pm/`（team）または `.pm-local/`（personal）のスケルトン生成 + CLAUDE.md or CLAUDE.local.md にマーカー付きで PM 利用ルールを挿入。**team モードでは PM スキル本体と pm-agent を `.claude/skills/pm-ask/` `.claude/skills/pm-sync/` `.claude/agents/pm-agent.md` にプロジェクト転写し、pm プラグイン未インストールのチームメンバーも `/pm-ask` `/pm-sync` で呼べる**。両方欲しい場合は team → personal を別個に実行 |
| `/pm:ask [質問]` | **読み取り専用**。引数なし=ブリーフィング (300 行サマリ)、`status`=軽量メタ情報、自由質問 (「先週何やった?」「○○の決定理由は?」) で PM ファイル + git log から回答 |
| `/pm:sync` | **唯一の書き込み窓口**。直近の git 活動 / plan.md / spec.md から state / decisions / roadmap への更新案を `pm-agent` に作らせ、ユーザー承認後に適用。完了マーク (done) / 意思決定 (decision) / 次タスク (next) はすべて sync が自動判別 |

## 同梱エージェント

| エージェント | 役割 |
|---|---|
| `pm-agent` | `.pm/` + `.pm-local/` を読んで ask モード (問い合わせ応答) / sync モード (git 活動から更新案生成) の 2 モードで動作。ファイル書き換えはせず提案だけ返す (実書き込みはスキル本体の責務) |

## インストール

### ローカル開発

```bash
git clone https://github.com/shinaps/claude-plugins ~/dev/claude-plugins
claude --plugin-dir ~/dev/claude-plugins/plugins/pm
```

### プラグインマーケットプレイス経由

```
/plugin install pm
```

## 使い方

### 1. 初期化

```
/pm:init                    # interactive: team / personal を選択
/pm:init team               # チーム共有 (commit)
/pm:init personal           # 個人 (gitignore)
```

両方欲しい場合は `/pm:init team` → `/pm:init personal` を別個に実行する。
Claude Code はセッション開始時に CLAUDE.md と CLAUDE.local.md を両方読むため、`.pm/` と `.pm-local/` が自動で overlay として動く。

実行すると以下が整う:

1. `.pm/`（team）または `.pm-local/`（personal、gitignore 済み）に 4 ファイルのスケルトン生成:
   - `state.md` — 現在のフォーカス、進行中タスク、ブロッカー、最近完了
   - `roadmap.md` — 次にやる候補（短期 / 中期 / 長期 / 却下）
   - `decisions.md` — 意思決定ログ（なぜ X を選んだか）
   - `workflow.md` — このプロジェクトの進め方・規約
2. PM 利用ルールをマーカー付きで挿入（モード別、コマンド参照もモード別）:
   - `team`: `CLAUDE.md` に挿入（`/pm-` 系コマンドを参照、チーム全員に効く、commit される）
   - `personal`: **`CLAUDE.local.md`** に挿入（`/pm:` 系コマンドを参照、Claude Code 公式の local override、gitignore 推奨）
3. **team モードのみ**: PM スキル本体と pm-agent をプロジェクトに転写
   - `.claude/skills/pm-ask/SKILL.md`（pm 本体の `ask` SKILL を `name: pm-ask` に書き換え + 内部の `/pm:` → `/pm-` 置換しながらコピー）
   - `.claude/skills/pm-sync/SKILL.md`（同様に転写）
   - `.claude/agents/pm-agent.md`（pm 本体のエージェント定義をそのままコピー）
   - **これにより pm プラグイン未インストールのチームメンバーも `/pm-ask` `/pm-sync` で PM を呼べる**
   - 配布は `git pull` 経由（commit されている前提）
   - pm 本体の更新時は、pm プラグイン保有者が再 `/pm:init` を打って転写ファイルを更新
4. `.gitignore` を自動更新（personal モードでは `.pm-local/` と `CLAUDE.local.md` を追加）
5. ルールに従って Claude が **毎セッション開始時に PM を自動参照**

### 2. 問い合わせ（読み取り）

```
/pm:ask                     # ブリーフィング: いま何やってる / 次やる / 進め方
/pm:ask status              # 軽量サマリ: 各ファイルの行数 / 更新日時 / 件数
/pm:ask 先週何やった?         # 自由質問
/pm:ask あの決定の理由は?     # 自由質問: decisions.md を中心に回答
/pm:ask 今日中に終わるタスクは? # 自由質問: state.md + 進捗から推測
```

`pm-agent` が PM ファイル + 必要なら `git log` を読んで回答する。
書き込みは一切行わない。

### 3. 更新（書き込み）

```
/pm:sync                    # 直近 3 日の git 活動から PM 更新案を生成・適用
```

実行すると以下が自動で行われる:

1. `git log --since="3 days ago"` で直近のコミット取得
2. `.claude/zeus/` 配下の最近の plan.md / spec.md があれば読む (zeus プラグインがあれば)
3. `pm-agent` が 4 種類の差分を検出:
   - **完了マーク (done)**: state.md の進行中タスクのうち、コミットで完了した項目
   - **state 追加**: state.md に無いが最近のコミットで明らかな新作業
   - **decision 追加**: コミットメッセージや plan.md で明示された設計判断
   - **next 追加**: TODO / future work から拾った将来作業
4. ユーザーが「全部適用 / 個別確認 / 適用しない」を選択
5. 承認された項目を `Edit` で各 PM ファイルに書き込み

**設計上の重要点**: 旧来の「decision/done/next/status を個別コマンドにする」設計ではなく、**コミットメッセージや plan.md に書けば sync が自動で拾う** モデル。明示操作を増やさず、git に書く文化と一体化させる。

## モード比較

| モード | コンテキスト | ルール挿入先 | スキル/エージェント転写 | 呼び出すコマンド | git 管理 | 用途 |
|---|---|---|---|---|---|---|
| `team` | `.pm/` | `CLAUDE.md` | あり (`.claude/skills/pm-ask/` `.claude/skills/pm-sync/` `.claude/agents/pm-agent.md`) | `/pm-ask` `/pm-sync` (pm プラグイン保有者は `/pm:ask` `/pm:sync` も可) | 全部 commit | チーム全員で共有する公式コンテキスト。**pm 未インストール環境でも動く** |
| `personal` | `.pm-local/` | `CLAUDE.local.md` | なし | `/pm:ask` `/pm:sync` (pm プラグイン経由) | **両方 gitignore** | 個人スクラッチパッド。**PM の存在自体が git に残らない** |

### personal モードの意義

`CLAUDE.local.md` は Claude Code 公式の「local override」用ファイル (gitignore 推奨)。
このファイルに PM ルールを書き、`.pm-local/` をコンテキスト本体にすることで、**ルールもコンテキストも両方 git に載らない完全 local 構成** になる。

個人プロジェクトでも、チームリポジトリで「自分だけ PM を回したい」ケースでも、他人に存在を漏らさず使える。

### チーム共有 + 個人 overlay の併用

`/pm:init team` 済みのプロジェクトで `/pm:init personal` を別途実行すると、両方が独立して動く:

- `.pm/` はチーム全員で共有 (commit)
- `.pm-local/` は自分だけ持つ overlay (gitignore)
- CLAUDE.md と CLAUDE.local.md は Claude Code が両方読むため、ブリーフィングで両方が参照される
- 同名ファイルがあれば **personal が team を上書き**: 「チーム共有の state はこうだが、自分の中ではこっちが進んでいる」を両立できる

## 出力ディレクトリ

```
.pm/                        ← team モード (git commit)
├── state.md                ← 現在のフォーカス・進行中・ブロッカー・最近完了
├── roadmap.md              ← 次にやる候補 (短期 / 中期 / 長期 / 却下)
├── decisions.md            ← 意思決定ログ (時系列降順)
└── workflow.md             ← 進め方・規約 (ブランチ運用 / レビュー / デプロイ)

.pm-local/                  ← personal モード (gitignore)
├── state.md                ← personal overlay (team を上書き)
├── scratch.md              ← 走り書き・アイデア
└── ...                     ← 他は personal だけのファイル
```

PM 利用ルールは `<!-- pm:start --> ... <!-- pm:end -->` マーカーで以下のファイルに挿入される（モード別）:

- team: `CLAUDE.md`（プロジェクトルート、commit）
- personal: `CLAUDE.local.md`（プロジェクトルート、gitignore）

Claude がセッション開始時に該当ファイルを読むことで PM を自動参照する。再 init はマーカー内だけを安全に置換するため、ユーザーが追加した独自セクションは保持される。

## 設計原則

- **3 スキルだけ**: init / ask / sync。サブコマンド分岐や単発操作は持たない
- **書き込みは sync 1 つに集約**: 個別 decision/done/next コマンドは廃止。コミットメッセージや plan.md に書けば sync が拾う
- **読み取りは ask 1 つに集約**: brief / status / 自由質問すべて
- **CLAUDE.md ルール経由で自動参照**: 直接呼ばれなくても、Claude がセッション開始時に CLAUDE.md を読む過程で自動的に PM を参照する習慣を持つ
- **personal モードは完全 local**: ルールもコンテキストも git に残さない
- **自動コミットしない**: PM ファイル変更は `git add` までで止める

## ライセンス

MIT
