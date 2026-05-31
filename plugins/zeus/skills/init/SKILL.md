---
name: init
description: プロジェクトに zeus を初期化する。2 モード構成 — shared は CLAUDE.md にマーカー付きで zeus 利用ルールを挿入 + .claude/zeus/ を commit (チーム共有 or 1 人プロジェクト)、personal は CLAUDE.local.md にルール挿入 + .claude/zeus/ を gitignore (個人で zeus を使うが他人に見せたくない時)。ルール挿入により Claude が「実装は /zeus:dev、レビューは /zeus:review、デバッグは /zeus:debug、要件が曖昧なら /zeus:spec」を毎セッション自動参照するようになる
argument-hint: <なし | shared | personal>
---

## 引数仕様

```
/zeus:init                     # interactive: AskUserQuestion で shared / personal を選択
/zeus:init shared              # CLAUDE.md にルール挿入 + .claude/zeus/ commit
/zeus:init personal            # CLAUDE.local.md にルール挿入 + .claude/zeus/ gitignore
```

## モードの違い

| モード | ルール挿入先 | .claude/zeus/ | git 管理 | 用途 |
|---|---|---|---|---|
| `shared` | `CLAUDE.md` | commit | 両方 commit | チーム共有 or 1 人プロジェクトで zeus 設定を公式化 |
| `personal` | `CLAUDE.local.md` | gitignore | 両方 gitignore | 個人で zeus を使うが、利用ルールも作業ログも git に残さない |

### モード選択の判断軸

- **コンテキスト (`.claude/zeus/` の plan.md / spec.md / review.md 等) を git で共有したいか?** → No なら `personal`、Yes なら `shared`
- 「他のメンバーがいない 1 人プロジェクト」でも shared を選んでよい (CLAUDE.md で自分用の zeus 設定を統一化)

## 実行フロー

### Phase 1: 引数判定 + モード確認

1. 引数が `shared` / `personal` のいずれかなら採用
2. 引数なし or 無効値 → `AskUserQuestion` で選択 (Recommended: `shared`)
3. 既存マーカー (`<!-- zeus:start -->` 〜 `<!-- zeus:end -->`) が CLAUDE.md / CLAUDE.local.md にあれば、モードに応じて更新

### Phase 2: .gitignore 更新

#### personal モード時

`.gitignore` を Read (無ければ新規作成) し、不足分だけ末尾に追記:

```
# zeus (personal mode — keep zeus context private)
.claude/zeus/
CLAUDE.local.md
```

`CLAUDE.local.md` は Claude Code 公式が gitignore 推奨する local override ファイル。
**personal モードでは zeus ルール本体もこのファイルに書かれる** ため、ルールも `.claude/zeus/` の生成物も両方 git に残らない完全 local 構成になる。

#### shared モード時

`.gitignore` 変更なし (`.claude/zeus/` を commit するのが正しい運用)。

### Phase 3: ルール挿入先ファイルの更新

挿入先ファイルはモード別に切り替える:

| モード | 挿入先ファイル |
|---|---|
| `shared` | `CLAUDE.md` (プロジェクトルート) |
| `personal` | `CLAUDE.local.md` (プロジェクトルート) |

#### 共通処理

1. 対象ファイルを Read (無ければ新規作成)
2. 既存マーカー `<!-- zeus:start -->` 〜 `<!-- zeus:end -->` の有無を確認
3. マーカーあり → 中身を最新版で置換
4. マーカーなし → ファイル末尾にマーカー付きで挿入

#### shared モード (CLAUDE.md に挿入)

```markdown
<!-- zeus:start -->
## zeus 利用ガイド

このプロジェクトでは zeus プラグインを使って実装 / レビュー / デバッグを行う。
Claude は以下の判断基準で適切な zeus スキルを自動で選択すること。

### スキル使い分け

| 作業内容 | 使うスキル | 役割 |
|---|---|---|
| 要件が曖昧 / 仕様を詰めたい | `/zeus:spec` | 対話的ヒアリング + 既存実装調査 + フィジビリティ調査 (必要ならプロトタイプ実装) で「ほぼ実現できる」レベルまで仕様を詰める |
| 技術選定で迷う (ライブラリ / フレームワーク) | `/zeus:tech-survey` | WebSearch + WebFetch で候補を観点別比較、出典の鮮度も検証 |
| 実装タスク (機能追加 / 修正) | `/zeus:dev` | 計画策定 → 実装 → セルフレビュー一気通貫 (Critical 自動修正、Warning は確認の上修正) |
| コード / PR / diff のレビュー単発 | `/zeus:review` | zeus-reviewer + zeus-review-validator で精度の高いレビュー、修正実装は /zeus:dev に橋渡し可能 |
| バグ / 不具合の根本原因調査 | `/zeus:debug` | 多角的調査 (コードトレース + WebSearch + GitHub Issue) で対症療法ではなく根本解決を導き、修正は /zeus:dev に橋渡し |

### 推奨される作業フロー

- **要件が曖昧な新機能**: `/zeus:spec` → (技術選定が必要なら `/zeus:tech-survey`) → `/zeus:dev`
- **要件が明確な実装**: 直接 `/zeus:dev <task>`
- **コードレビュー単発**: `/zeus:review` (確定指摘があれば `/zeus:dev` に橋渡し)
- **バグ修正**: `/zeus:debug` → 根本原因確定後 `/zeus:dev` に橋渡し

### zeus の設計原則 (Claude が踏襲すること)

- **EnterPlanMode は使わない**: bypassPermissions モードと両立させるため
- **不明な論点は AskUserQuestion で必ずユーザーに確認** (回数制限なし、曖昧なまま自動進行しない)
- **spec で実現可能性を詰めてから dev に進む** ことで差し戻しをほぼゼロにする

### 生成物の場所

zeus の各スキルは `.claude/zeus/{category}/{ts}-{slug}/` 配下に成果物を保存する。
セッション横断で読み返すべき情報 (plan.md / spec.md / review-validated.md 等) はこのディレクトリにある。

<!-- zeus:end -->
```

#### personal モード (CLAUDE.local.md に挿入)

shared 版と同じ構造 (内容も同じ、`.claude/zeus/` は gitignore されているという前提)。
挿入先が CLAUDE.local.md に変わるだけで、テキストは shared 版を流用する。

### Phase 4: 結果報告

セットアップ完了をユーザーに報告:

```
## /zeus:init 完了

- モード: {shared / personal}
- ルール挿入先: {CLAUDE.md / CLAUDE.local.md} ({新規作成 / マーカー追記 / マーカー更新})
- .gitignore: {更新あり (追記行: ...) / 変更なし}

これ以降、Claude はセッション開始時に上記ファイルを読み、適切な zeus スキル
(/zeus:spec / /zeus:tech-survey / /zeus:dev / /zeus:review / /zeus:debug) を
自動で選択するようになります。
```

## 動作原則

- **CLAUDE.md / CLAUDE.local.md は新規作成 OK**: 無ければ作る (zeus セクションだけのファイルになる)
- **CLAUDE.md マーカー方式**: `<!-- zeus:start -->` 〜 `<!-- zeus:end -->` で安全に再 init 可能
- **自動コミットしない**: CLAUDE.md / .gitignore の変更は `git add` までで止める
- **personal モードは必ず .gitignore 確認**: 漏洩防止
- **再 init は安全**: 既存マーカー内のみ最新版で置換、ユーザーが追加した独自セクションは保持
- **スキルやエージェントは転写しない**: zeus を使うチームメンバーは各自 `/plugin install zeus` でインストールする前提 (5 スキル + 10 エージェントを転写すると重いため)
