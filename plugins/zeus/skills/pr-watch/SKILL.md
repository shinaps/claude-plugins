---
name: pr-watch
description: open な GitHub PR を定期スキャンし、未レビュー PR / 新コミット / 新規ユーザーコメントを検出して `/zeus:pr-review` に自動委譲する監視スキル。引数なしで自動的に 5 分おきの loop を開始（内部で `/loop` を起動）。`<interval>` 指定で間隔変更、`--once` で 1 サイクルだけ。トリガーコメント不要で全 open PR を自動レビュー（CodeRabbit 同等）。状態は GitHub 側のみで管理（専用ファイルなし）
argument-hint: <なし | interval (5m, 15m, 1h) | --once | repo:owner/name>
---

# Zeus PR Watch スキル（PR 監視・委譲担当）

カレントリポジトリの open な GitHub PR を定期スキャンし、レビューが必要な PR を検出して `/zeus:pr-review` に委譲する **watcher** スキル。
**起動するだけで自動的に loop が始まる**（内部で `/loop` を Skill ツール経由で起動）。
**トリガーコメントは不要**、open な PR は draft / bot 以外すべて自動レビュー対象（CodeRabbit と同じ運用感）。
**ローカル状態ファイルは持たず**、GitHub 上のレビュー本文に埋め込まれた HTML マーカーから状態を再構築する。

## 引数仕様

```
/zeus:pr-watch                                  # 5 分おき loop で常駐 (デフォルト)
/zeus:pr-watch 15m                              # 15 分おき loop
/zeus:pr-watch 1h                               # 1 時間おき loop
/zeus:pr-watch --once                           # 1 サイクルだけ実行して終了
/zeus:pr-watch repo:owner/name                  # 他リポジトリ (loop / once どちらでも組み合わせ可)
/zeus:pr-watch 10m repo:owner/name              # 10 分おき loop で他リポジトリ
/zeus:pr-watch --once repo:owner/name           # 他リポジトリで 1 サイクルだけ
```

### 引数パーサ

スペース区切りで各トークンを以下に分類:

| トークン | 解釈 |
|---|---|
| `--once` / `--single` | `once_mode = true`（loop しない） |
| `^\d+[smh]$` にマッチ (`5m`, `15m`, `1h`, `30s` 等) | `interval = <値>` |
| `repo:owner/name` | `repo_override = owner/name` |
| その他 | 無視（警告は出すが続行） |

**デフォルト**: `interval = "5m"`、`once_mode = false`、`repo_override = なし`（カレント repo）。

### loop の起動方法

`once_mode = false` のとき、本スキルは内部で `Skill` ツールを使い `loop` スキルを起動する:

```
Skill(skill="loop", args="{interval} /zeus:pr-watch --once{ repo:owner/name があれば追記}")
```

**ユーザーが `/loop` を手動で打つ必要はない**。`/zeus:pr-watch` 1 つで loop セットアップまで完結する。
過去の `/loop 5m /zeus:pr-watch` 形式も動くが、その場合は **必ず `--once` を付ける** ように案内（付けないと loop の中でさらに loop が立つため）。

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

### Phase 0: モード判定とユーザー通知

1. 引数パーサで `once_mode` / `interval` / `repo_override` を確定
2. **`once_mode = true` の場合**: そのまま Phase 1 へ進む（1 サイクル実行して終了）
3. **`once_mode = false` の場合（loop mode）**:
   - ユーザーに開始メッセージを表示:
     ```
     ## Zeus PR Watch 起動
     - リポジトリ: {owner}/{repo}（{repo_override or "current"}）
     - 間隔: {interval}
     - これより 1 サイクル即時実行 → /loop で常駐します
     - 停止方法:
       1. プロンプトで Esc キーを押して /loop を中断
       2. もしくは会話に新規メッセージを送信して /loop を打ち切る
     ```
   - **まず Phase 1 以降を即時 1 サイクル実行**（即時フィードバックを返す）
   - 1 サイクル完了後、Phase 9 で `/loop` を起動して制御を渡す

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
- 次回スキャン: {loop mode なら "/loop が {interval} 後に自動再実行" / once mode なら "再実行するには /zeus:pr-watch を再度起動"}
```

### Phase 9: /loop 起動（loop mode のみ）

`once_mode = false` で起動された **最初の 1 回目** のみ、サイクル完了後に `/loop` を起動して常駐モードに入る:

1. 既に loop が稼働中なら（= 引数に `--once` が無いのに、これが /loop からの再呼び出しの場合）スキップ
   - **検出方法**: 引数に `--once` が含まれている = /loop からの再呼び出し。Phase 0 で `once_mode = true` ルートに入っているのでここには来ない
   - したがってここに来るのは「ユーザーが直接 `/zeus:pr-watch` を打った 1 回目」だけ
2. `Skill` ツールで `loop` スキルを起動:
   ```
   Skill(skill="loop", args="{interval} /zeus:pr-watch --once{repo_override があれば " repo:" + repo_override を追加}")
   ```
3. ユーザーに通知:
   ```
   /loop に常駐を引き継ぎました。{interval} ごとに再スキャンします。
   ```
4. 制御を /loop に渡して本スキル終了

once_mode で呼ばれた場合（/loop からの再呼び出し含む）は Phase 9 をスキップして終了。これで「ユーザーが /zeus:pr-watch を 1 回打つ → 即時 1 サイクル + /loop 常駐セット」という挙動になる。

## 動作原則

- **状態ファイル不要**: GitHub 側の HTML マーカーから毎回再構築。watcher が落ちても再起動で完全復旧
- **冪等**: 同じ状態で何度呼ばれても同じ結論。重複 review は `/zeus:pr-review` 側の fingerprint で防ぐ
- **draft / bot は除外**: ノイズ源を最初に切る
- **委譲先に集約**: トリガー検出だけ責務とし、レビュー実行・コメント整形・メモリ更新は `/zeus:pr-review` に一任
- **並列処理しない**: PR は順次処理（API レート・コメント順序の予測可能性）
- **デフォルトで loop**: 引数なし起動で即 loop（CodeRabbit と同じ常駐感）。`--once` で単発を明示
- **二重ループ防止**: /loop からの再呼び出しは必ず `--once` 付き。Phase 9 をスキップしてネスト loop を防ぐ
- **無人運用前提**: `/zeus:pr-review` 側も承認 UI 無しで自動投稿。誤投稿は fingerprint と memory フィルタで予防
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

`/loop` は Claude Code に標準で含まれる skill。本スキルは Skill ツール経由で内部から `/loop` を起動する（ユーザーは `/loop` を直接打たなくてよい）。

間隔の目安:

| interval | 用途 |
|---|---|
| `5m` (default) | アクティブなチームで PR が頻繁に動く時 |
| `15m` | 通常運用 |
| `1h` | 低頻度な個人プロジェクト |

### 停止方法

`/loop` 内に入った状態を抜けるには:

1. **Esc キー**: プロンプト入力中なら /loop に割り込みを送れる
2. **新規メッセージ送信**: 会話に何かを送ると /loop が中断される

`/zeus:pr-watch --once` で実行した場合は loop を立てないので、その 1 サイクルが終わったら自然終了する。

## 他スキルとの使い分け

| スキル | 用途 |
|---|---|
| `/zeus:pr-review <N>` | 単一 PR をレビューしてコメント投稿（直接実行 or 委譲先） |
| **`/zeus:pr-watch`** | **open PR をスキャンしてレビュー対象を検出 + `/zeus:pr-review` に委譲** |
| `/zeus:review` | ローカル diff / path のレビュー（PR への自動投稿はしない別系統） |
