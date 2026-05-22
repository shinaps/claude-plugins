---
name: pr-watch
description: open な GitHub PR を定期スキャンし、未レビュー PR / 新コミット / 新規ユーザーコメントを検出して `/zeus:pr-review` に自動委譲する監視スキル。トリガーコメント不要で全 open PR を自動レビュー（CodeRabbit 同等）。`/loop 5m /zeus:pr-watch` で常駐運用する想定。状態は GitHub 側のみで管理（専用ファイルなし）
argument-hint: <なし | repo:owner/name>
---

# Zeus PR Watch スキル（PR 監視・委譲担当）

カレントリポジトリの open な GitHub PR を定期スキャンし、レビューが必要な PR を検出して `/zeus:pr-review` に委譲する **watcher** スキル。
**トリガーコメントは不要**、open な PR は draft / bot 以外すべて自動レビュー対象（CodeRabbit と同じ運用感）。
**ローカル状態ファイルは持たず**、GitHub 上のレビュー本文に埋め込まれた HTML マーカーから状態を再構築する。

## 引数仕様

```
/zeus:pr-watch                                 # 現在の repo の open PR を全部スキャン
/zeus:pr-watch repo:owner/name                 # 指定 repo をスキャン
```

`/loop` から繰り返し呼ばれる前提の **冪等な** 1 回 1 サイクル実装。状態を残さない。

## 想定運用

```
/loop 5m /zeus:pr-watch
```

これで 5 分おきにスキャンされ、新規トリガー・新コミット・新規ユーザーコメントを検出すれば自動で `/zeus:pr-review <N>` に委譲する。
**`/loop` の起動はユーザーが手動で行う**（このスキル自身は `/loop` を呼ばない）。

## 使用ツール

- `gh` CLI（`gh pr list`, `gh api`）
- `Skill` ツールで `zeus:pr-review` を起動して 1 PR ずつ委譲

## トリガー仕様

PR ごとに以下のシグナルを評価する。**トリガーコメントは不要**で、open な PR は無条件で fresh-review 対象。

### 1. fresh-review トリガー

**条件**: 過去に zeus レビューが投稿されていない（= 未レビュー PR）

- 既存 zeus レビュー判定: `gh api repos/:o/:r/pulls/:N/reviews` で `user.login == $(gh api user --jq .login)` かつ body に `<!-- zeus:pr-review` を含むものが **存在しない**
- 該当する PR は **すべて** 初回レビュー対象（CodeRabbit と同じ無差別運用）
- 例外: draft / bot 作成 PR は Phase 2 の `gh pr list` 段階で除外済み

### 2. re-review トリガー

**条件**: 過去に zeus レビューがあり、その後 head SHA が変わっている（= 新規コミット）

- 直近 zeus レビューの body から `reviewed-sha={SHA}` を正規表現抽出
- PR の `headRefOid` と比較し、不一致なら re-review トリガー
- 「直近の zeus レビュー」は `submitted_at` で降順ソート

### 3. comment-response トリガー

**条件**: 過去に zeus レビューがあり、SHA は変わっていないが、コラボレータが新規コメントを書いている

- 直近 zeus レビューの `submitted_at` 以降に書かれた:
  - issue comments
  - review comments（inline）
- それらの中で:
  - bot ではない
  - コラボレータ（OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR）
  - まだ 👀 (`eyes`) リアクション（zeus 側が処理済みマーカー）が付いていない
- そのようなコメントが 1 つでもあれば comment-response トリガー

### 優先順

1 PR について複数トリガーが立つこともある。優先順位は:

1. `comment-response`（ユーザーが返信しているなら最優先で処理）
2. `re-review`（新コミットへの追従）
3. `fresh-review`（初回）

トリガーが何も立たなければ skip。

## 実行フロー

### Phase 1: 環境チェック

1. `gh auth status` で認証確認、失敗なら **エラー終了**（自動ループ中なので静かに終わる: stderr に短いメッセージ）
2. repo 解決:
   - 引数 `repo:owner/name` 指定があればそれ
   - 無ければ `gh repo view --json nameWithOwner --jq .nameWithOwner`
3. `gh api user --jq .login` で自分の GitHub ログイン名を取得（既存レビュー判定で使う）

### Phase 2: open PR 列挙

```
gh pr list --repo {owner}/{repo} --state open --limit 50 \
  --json number,title,headRefOid,isDraft,author,updatedAt
```

- **draft PR は除外**（ノイズ源）
- **bot 作成 PR は除外**（renovate / dependabot などは別系統で扱う想定）
- updatedAt が直近 24 時間以内のものを優先（変動が無い PR の再評価コストを下げる）。**ただし fresh トリガーは古い PR にも反応するため、issue comments の created_at も見る**

### Phase 3: 各 PR を分類

各 PR について以下を並列で取得（PR 数 × 3 リクエスト程度）:

- `gh api repos/:o/:r/pulls/:N/reviews`
- `gh api repos/:o/:r/issues/:N/comments`
- `gh api repos/:o/:r/pulls/:N/comments`

その後「トリガー仕様」セクションに従って各 PR の状態を `fresh-review` / `re-review` / `comment-response` / `idle` のいずれかに分類する。

idle は何もしない。それ以外は **アクション対象リスト** に追加。

### Phase 4: アクション対象リストの表示

```
## /zeus:pr-watch スキャン結果 ({owner}/{repo})

- スキャン件数: {N} (open / 非 draft / 非 bot)
- アクション対象: {M}
  - fresh-review: {a} 件
  - re-review: {b} 件
  - comment-response: {c} 件

### 対象 PR
1. #{N1} "{title}" — {trigger}
2. #{N2} "{title}" — {trigger}
...
```

アクション対象が **0 件** ならここで終了（"nothing to do" と通知）。

### Phase 5: 委譲確認

複数 PR が対象の場合、**並列ではなく順次** 処理する（GitHub API レート制限・コメント順序の予測可能性を優先）。

- アクション対象が **5 件以下**: そのまま順次処理に進む（無条件自動レビューで `/loop` 中の頻繁な確認を避ける）
- **6 件以上**: `AskUserQuestion` で「全件処理 / 上位 5 件のみ / キャンセル」を確認
  - 初回起動時に大量の open PR を抱えるリポジトリで、一気にレビュースパムが出るのを防ぐためのガード
  - 上位 5 件の優先順は: `comment-response` > `re-review` > `fresh-review`、同順位内では `updatedAt` 降順

### Phase 6: 1 PR ずつ /zeus:pr-review に委譲

各 PR について `Skill` ツールで `zeus:pr-review` を起動:

```
Skill(skill="zeus:pr-review", args="{PR番号}")
```

引数として PR 番号を渡すだけ。`/zeus:pr-review` 側で mode 自動判定するので、watcher 側はトリガー種別を意識する必要は無い（情報伝達のロスを避ける）。

#### 委譲時の挙動

- `/zeus:pr-review` は内部で `EnterPlanMode` で承認 UI を出すので、**自動実行ループ中は承認が止まる**
- 完全自動運用したい場合の選択肢:
  1. ユーザーが各 PR ごとに承認する（標準動作）
  2. このスキル冒頭で `--auto-approve` フラグを受け取り、`/zeus:pr-review` 側の承認 UI をスキップするモードを将来追加（**初版では実装しない**。誤投稿リスクが高い）

### Phase 7: comment-response 処理時の eye リアクション

`/zeus:pr-review` の comment-response モード内で、処理済みコメントに `eyes` リアクションを付ける挙動は **pr-review スキル側の責務**。watcher は付けない（重複処理防止のマーキングは委譲先に統一）。

### Phase 8: サイクル終了

```
## /zeus:pr-watch サイクル完了

- 処理: {N} 件の PR で /zeus:pr-review を起動
- 結果: pr-review の出力を参照（PR ごとに別エントリ）
- 次回スキャン: /loop が稼働していれば自動。手動なら再度 /zeus:pr-watch
```

`/loop` 動的モードで動いている場合、次回スケジューリングは `/loop` 側に任せる。このスキルは 1 サイクルで完結する。

## 動作原則

- **状態ファイル不要**: GitHub 側の HTML マーカーから毎回再構築。watcher が落ちても再起動で完全復旧
- **冪等**: 同じ状態で何度呼ばれても同じ結論。重複 review は `/zeus:pr-review` 側の fingerprint で防ぐ
- **draft / bot は除外**: ノイズ源を最初に切る
- **委譲先に集約**: トリガー検出だけ責務とし、レビュー実行・コメント整形・メモリ更新は `/zeus:pr-review` に一任
- **並列処理しない**: PR は順次処理（API レート・コメント順序の予測可能性）
- **承認 UI はスキップしない**: 初版では `/zeus:pr-review` の `EnterPlanMode` 承認をスキップしない。誤投稿が出るより止まったほうが安全
- **ループ起動は人間が行う**: `/zeus:pr-watch` 自身は `/loop` を呼ばない（暴走防止）
- **静かな失敗**: 認証失敗 / repo 解決失敗は短いエラーログだけ出して終了（`/loop` 中の例外連発を避ける）

## 個別 PR を手動でレビューしたい場合

`/zeus:pr-watch` を待たず、`/zeus:pr-review <N>` で直接特定 PR をレビューできる。
特定 PR を緊急レビューしたい / watch サイクルを待ちたくない場合はこちら。

```
/zeus:pr-review 42
/zeus:pr-review https://github.com/owner/repo/pull/42
```

`/zeus:pr-watch` と `/zeus:pr-review` は同じ fingerprint / HTML マーカー機構を共有するので、混在運用しても重複レビューは出ない。

## プロジェクトメモリとの連携

`.zeus/review-memory.md` の管理は `/zeus:pr-review` 側の責務。watcher 側はメモリを **読まない**（トリガー判定にメモリは関係ないため）。

## /loop との関係

`/loop` は本プラグインに含まれる skill ではなく、Claude Code 側の機能。
ユーザーが `/loop 5m /zeus:pr-watch` で起動することを推奨運用とする。間隔の目安:

- **5 分**: アクティブなチームで PR が頻繁に動く時
- **15 分**: 通常運用
- **1 時間**: 低頻度な個人プロジェクト

`/loop` を停止すれば watch は止まる。`/zeus:pr-watch` を単発で呼べばその時点で 1 サイクルだけ走る。

## 他スキルとの使い分け

| スキル | 用途 |
|---|---|
| `/zeus:pr-review <N>` | 単一 PR をレビューしてコメント投稿（直接実行 or 委譲先） |
| **`/zeus:pr-watch`** | **open PR をスキャンしてレビュー対象を検出 + `/zeus:pr-review` に委譲** |
| `/zeus:review` | ローカル diff / path のレビュー（PR への自動投稿はしない別系統） |
