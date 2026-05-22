---
name: pr-review
description: GitHub PR を zeus-reviewer + zeus-review-validator でレビューし、CodeRabbit ライクな inline + summary コメントを投稿する。fresh / re-review / comment-response の 3 モード自動判定。プロジェクトメモリ `.zeus/review-memory.md` と連動して won't-fix / 方針指摘を蓄積し他 PR でも活用。/zeus:pr-watch から自動委譲される
argument-hint: <PR番号 | PR URL>
---

# Zeus PR Review スキル（PR 単発レビュー担当）

GitHub の単一 PR に対して、`zeus-reviewer` + `zeus-review-validator` を使って **CodeRabbit ライクなレビューコメント** を投稿するスキル。
プロジェクトメモリ (`.zeus/review-memory.md`) を読み込み、won't-fix / 方針判断と重複しない指摘だけを出す。
ユーザーが PR に書いた「これは意図的」などのコメントは自動でメモリに学習する。

## 引数仕様

```
/zeus:pr-review <PR番号>            # 現在の repo の PR
/zeus:pr-review <PR URL>            # 他 repo の PR も OK
```

引数なしの場合はエラー終了（曖昧さ回避）。`/zeus:pr-watch` から呼ばれる場合は必ず PR 番号付き。

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Reviewer | `zeus-reviewer` | logic / design / security / performance / maintainability を統合観点でレビュー |
| Zeus Review Validator | `zeus-review-validator` | reviewer の指摘を実コードと照合し false positive を排除 + 追加発見 |
| Zeus Tech Surveyor | `zeus-tech-surveyor` | **必要時のみ起動**: PR が新規ライブラリ追加 / 大規模依存変更を含む場合 |

## ディレクトリ規約

実行ごとに以下を保存する:

```
.claude/zeus/pr-reviews/{ts}-{repo-slug}-{N}-{mode}/
├── input.md                  ← PR 情報・diff・モード判定の根拠
├── memory-snapshot.md        ← その時点の .zeus/review-memory.md（変化検知用）
├── review.md                 ← zeus-reviewer の一次レポート
├── review-validated.md       ← zeus-review-validator の検証済み指摘
├── findings-filtered.md      ← メモリ照合で除外/減衰した指摘の最終リスト
├── comments-payload.md       ← 投稿前の inline + summary 完成形プレビュー
└── memory-diff.md            ← comment-response モード時のメモリ追記差分
```

`{mode}` は `fresh` / `re-review` / `comment-response` のいずれか。

## 状態管理（GitHub-side only / 専用ファイルなし）

このスキルは **ローカル状態ファイルを持たない**。GitHub に投稿したレビュー本文の HTML マーカーから状態を再構築する。

### 投稿マーカー（必ず含める）

- **Summary review 本文の冒頭**:
  ```
  <!-- zeus:pr-review version=1 reviewed-sha={head-sha} reviewer={gh-login} at={iso8601} -->
  ```
- **各 inline comment の末尾**:
  ```
  <!-- zeus:finding fingerprint={sha1(file:line:body[:80])} severity={critical|warning|info} -->
  ```

### 既存レビュー検出

「我々が過去にこの PR に投稿した zeus レビュー」の判定は以下:

1. `gh api repos/:owner/:repo/pulls/:N/reviews` で全レビュー取得
2. `user.login` が現在の `gh api user --jq .login` と一致するものだけ抽出
3. その中で body に `<!-- zeus:pr-review` が含まれるものだけ抽出
4. `submitted_at` で降順ソートし最新を「直近の zeus レビュー」とする

その直近レビューの本文から `reviewed-sha=` を正規表現で抽出し、PR の `headRefOid` と比較する。

### 既出指摘の重複排除

inline comment 投稿前に、既存 review comments を全部取り、各コメントから `zeus:finding fingerprint=` を抽出して set 化する。
新規 finding の fingerprint がこの set に含まれていればスキップ（同じ指摘を 2 回出さない）。

## モード自動判定

1. PR を取得し `headRefOid` を控える
2. 既存 zeus レビューを上記手順で探す
3. 以下の優先順で判定:

| 条件 | mode |
|---|---|
| 既存 zeus レビューが **無い** | `fresh` |
| 既存あり & `headRefOid != reviewed-sha` | `re-review` |
| 既存あり & `headRefOid == reviewed-sha` & 直近 zeus レビュー以降にコラボレータの新規コメントあり | `comment-response` |
| 上記すべて該当せず | `no-op`（"already reviewed, no changes" と表示して終了） |

「コラボレータの新規コメント」は `authorAssociation in {OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR}` かつ bot ではないコメントに限定する。

## 実行フロー

### Phase 1: 引数解析 + 前提チェック

1. 引数を `PR番号` または `PR URL` から `{owner, repo, number}` にパース
   - `gh repo view --json nameWithOwner` で現在の repo を取得（数字のみのとき）
2. `gh auth status` で認証確認、失敗ならエラー終了
3. `gh pr view <N> --repo {owner}/{repo} --json number,title,headRefOid,state,isDraft,baseRefName,headRefName,author,url` で PR メタ取得
4. **state != OPEN** ならスキップ（"PR is closed/merged, skipping" と通知して終了）
5. **isDraft == true** なら `AskUserQuestion` で続行するか確認（draft の自動レビューはノイズ源）

### Phase 2: メモリ読み込み

1. `.zeus/review-memory.md` を Read（無ければ空のテンプレートを脳内に持つだけで OK、ファイルは作らない）
2. 内容を `input.md` 用に控える
3. `memory-snapshot.md` にも同内容をコピー（後で diff 比較するため）

### Phase 3: モード判定

「状態管理」セクションのとおりに既存 zeus レビュー検出 → mode 決定。
`no-op` の場合は短いメッセージを出して終了。

### Phase 4: モード別データ取得

#### fresh モード
- `gh pr diff <N>` で全 diff
- `gh pr view <N> --json files` で変更ファイル一覧
- `input.md` に PR 情報 + diff 全文を保存

#### re-review モード
- `gh api repos/:o/:r/compare/{last-reviewed-sha}...{head-sha} --jq .files` で差分ファイル取得
- ファイルごとの patch を結合し「前回レビュー以降の diff」を構築
- `input.md` に「前回レビュー時 SHA、現在 SHA、追加された commit のリスト、新規 diff」を保存

#### comment-response モード
- 直近 zeus レビューの `submitted_at` 以降のコメントを取得:
  - issue comments: `gh api repos/:o/:r/issues/:N/comments`
  - review comments: `gh api repos/:o/:r/pulls/:N/comments`
- コラボレータ & 非 bot だけに絞る
- 各コメントを `input.md` に時系列で並べる

### Phase 5: 観点別実行

#### fresh / re-review の場合

1. **依存変更チェック**:
   - 変更ファイルに `package.json` / `Cargo.toml` / `go.mod` / `requirements.txt` / `pyproject.toml` / `Gemfile` / `composer.json` などのマニフェストが含まれ、かつ **新規依存追加** が diff に見える場合のみ:
     - `zeus-tech-surveyor` を起動して新規依存の鮮度・代替案を調査
     - 結果を `findings-filtered.md` の「依存に関する補足」として末尾に追加
   - それ以外は **tech-survey は起動しない**（高速化）

2. `zeus-reviewer` を 1 体起動。プロンプトには以下を含める:
   - PR タイトル・本文・diff 全文 (`input.md` 抜粋)
   - **`.zeus/review-memory.md` の内容**（重要: 「以下の `Project Conventions` / `Won't Fix Patterns` に該当する観点は指摘しないこと」と明記）
   - mode（fresh / re-review）

3. レポートを `review.md` に全文保存

4. `zeus-review-validator` を起動。プロンプトには `input.md` + `review.md` + メモリ内容を渡し、「指摘ごとに該当コードを Read で確認し、confirmed / false positive / partial / out-of-scope に分類、見落としは additional finding」と指示

5. 結果を `review-validated.md` に全文保存

6. **メモリで再フィルタ**:
   - validator が confirmed/partial/additional とした指摘について、`.zeus/review-memory.md` の `Won't Fix Patterns` と再度マッチング
   - マッチしたら除外し、`findings-filtered.md` の「メモリで除外」セクションに理由付きで記録
   - 残った指摘が **最終的に投稿される指摘**

#### comment-response の場合

`zeus-reviewer` は起動しない。代わりに本スキルのメインスレッドが各ユーザーコメントを LLM 判断で分類:

| 分類 | 判断基準（自然言語マッチ + 文脈） | アクション |
|---|---|---|
| `policy` | 「方針」「規約」「うちは○○を使う」など、プロジェクト全体に効く判断 | `.zeus/review-memory.md` の `Project Conventions` に追記 |
| `wont-fix` | 「これは意図的」「修正しない」「won't fix」「許容範囲」 | `.zeus/review-memory.md` の `Won't Fix Patterns` に追記 |
| `fix-requested` | 「再レビューして」「修正したので確認」「もう一度見て」 | mode を `re-review` に切り替えて Phase 4 再走（コミットがあるなら） |
| `clarification` | 「なぜ？」「理由は？」など質問 | 該当 inline comment にスレッド返信で説明 |
| `unrelated` | 上記いずれにも該当しない雑談 | 何もしない |

複数コメントある場合は **時系列順に 1 件ずつ処理**。`policy` / `wont-fix` が混ざる場合は最後にまとめてメモリ更新を 1 回。

### Phase 6: メモリ更新（comment-response モードのみ）

1. メモリに追記する内容を `memory-diff.md` に出力
2. `AskUserQuestion` で「メモリに追記してよいか？」を確認:
   - **追記する (Recommended)**: `.zeus/review-memory.md` を Edit で更新
   - **追記内容を見て編集する**: ユーザーに `memory-diff.md` を見せて手動編集を促す
   - **追記しない**: スキップ
3. メモリ追記時のフォーマット:

```markdown
### {short-title}

- **Rule** / **Pattern**: {ルール内容}
- **Why**: {ユーザーコメントから抽出した理由}
- **Source**: PR #{N} ({owner}/{repo}) — comment by @{user} on {date}
- **Applies to**: {影響範囲: ファイルパターン / 言語 / フレームワーク等}
```

4. メモリ更新後、PR コラボレータが他リポジトリでも使えるよう **`git add` のみ実行しユーザーにコミット案内** （自動コミットはしない）

### Phase 7: コメント整形 + プレビュー

最終的な投稿物を `comments-payload.md` に書き出す。**CodeRabbit ライクな構造**:

#### Inline comment テンプレート

```markdown
_{severity-badge}_ | _{tag-badge}_

**{1行要約}**

{詳細説明: なぜ問題か、どんな影響があるか}

<details>
<summary>🔧 修正案</summary>

```diff
{diff suggestion}
```

</details>

<details>
<summary>🤖 AI Agent 向け指示</summary>

```
{該当コード位置と修正方針を明示した、AI agent が読める短い指示}
```

</details>

<!-- zeus:finding fingerprint={sha1} severity={critical|warning|info} -->
```

#### Severity badge マップ

| zeus reviewer の分類 | badge |
|---|---|
| Critical | `⚠️ Potential issue` + `🔴 Critical` |
| Warning | `🟠 Major` または `🟡 Nitpick`（影響度で判断） |
| Info | `💡 Suggestion` または `⚡ Quick win` |

#### Summary review 本文テンプレート

```markdown
<!-- zeus:pr-review version=1 reviewed-sha={head-sha} reviewer={gh-login} at={iso} -->

## Zeus Review Summary

**Actionable comments posted: {N}**

| Severity | Count |
|---|---|
| 🔴 Critical | {n} |
| 🟠 Major | {n} |
| 🟡 Nitpick | {n} |
| 💡 Suggestion | {n} |

### 概要

{PR 全体に対する 2-3 行の所感}

### 主要な懸念

{Critical / Major の 1 行サマリリスト, 各 inline comment への anchor}

<details>
<summary>ℹ️ Review info</summary>

- Mode: `{mode}`
- Reviewed SHA: `{head-sha}`
- Files reviewed: {N}
- Memory snapshot: `.zeus/review-memory.md` ({M} conventions, {K} won't-fix patterns)
- Tech survey: {invoked: yes/no}
- Validator: {confirmed: N / false-positive: N / partial: N / additional: N}

</details>

<details>
<summary>📒 Files reviewed</summary>

{ファイル一覧}

</details>
```

### Phase 8: GitHub 投稿

1. 既存 review comments の fingerprint set を作成（重複排除用）
2. 各 inline comment について:
   - fingerprint set に含まれない場合のみ投稿
   - `gh api -X POST repos/:o/:r/pulls/:N/comments` で個別投稿（`commit_id` は head SHA、`path` / `line` / `side: RIGHT`）
3. 全 inline 投稿後、summary review を一括投稿:
   - `gh pr review <N> --comment --body-file <summary-body-file>`
   - state: `COMMENTED`（PR ブロックしない）
4. comment-response モードでユーザーコメントに対する返信がある場合:
   - `gh api -X POST repos/:o/:r/pulls/:N/comments/{id}/replies` でスレッド返信
   - 処理済みコメントに 👀 (`eyes`) リアクションを付ける（重複処理防止）

### Phase 9: 結果報告

```
## /zeus:pr-review 完了

- PR: {owner}/{repo}#{N} "{title}"
- Mode: {mode}
- Reviewed SHA: {head-sha[:8]}
- Inline comments posted: {N} (skipped {M} duplicates)
- Summary review: {url}
- 確定指摘: Critical {n} / Major {n} / Nitpick {n} / Suggestion {n}
- メモリ更新: {追記件数} ({.zeus/review-memory.md})

### 次アクション
- レビュー結果を `/zeus:plan` で修正計画化したい場合: `/zeus:plan PR#{N} のレビュー指摘を修正`
- 監視ループ起動: `/loop 5m /zeus:pr-watch`
```

## 動作原則

- **状態ファイル不要**: GitHub 側の HTML マーカーから状態を再構築
- **fingerprint で重複排除**: 同じ指摘を 2 回投稿しない（再レビュー時の冗長化を防ぐ）
- **メモリで継続学習**: won't-fix / プロジェクト方針を `.zeus/review-memory.md` に蓄積、他 PR でも活用
- **メモリ自動コミットはしない**: `git add` までで止めてユーザーに案内（CLAUDE.md の add / commit 分離ルールに準拠）
- **無人運用 / 投稿前承認なし**: `/zeus:pr-watch` から /loop で常駐運用する前提のため、投稿前 UI 承認は **挟まない**。誤投稿の予防は fingerprint と memory フィルタで担保。事前に内容だけ見たい場合は `/zeus:review <PR番号>` を使う（こちらはローカル保存のみで投稿しない）
- **tech-survey は依存変更時のみ**: 通常 PR では起動せず高速化
- **既存 reviewer / validator を再利用**: PR 専用エージェントは追加しない（メンテコスト最小）
- **bot コメントは無視**: コラボレータの非 bot コメントだけを「ユーザーコメント」として扱う
- **draft PR は確認後**: 自動 watch から draft をレビューするとノイズになるため確認を挟む
- **closed / merged はスキップ**: 即終了

## 他スキルとの使い分け

| スキル | 用途 |
|---|---|
| `/zeus:review` | ローカル diff / 任意 path / PR の **単発レビュー**。`.claude/zeus/reviews/` に保存して `/zeus:plan` 橋渡しできる |
| **`/zeus:pr-review`** | **PR への自動コメント投稿 + メモリ学習**。直接呼び出しも、`/zeus:pr-watch` からの自動委譲も対応 |
| `/zeus:pr-watch` | open PR を定期スキャンし未レビュー PR / 新コミット / 新コメントを検知、本スキルに委譲（トリガーコメント不要） |

`/zeus:review` の PR モードはローカル保存メインで投稿は手動承認だが、`/zeus:pr-review` は **CodeRabbit 風の常駐レビュアー** として PR に張り付くことを想定した別系統。
