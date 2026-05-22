---
name: resolve-pr-review
description: GitHub PR で受けたレビューコメント（zeus / CodeRabbit / 人間レビュアー全部）を `zeus-review-validator` で妥当性判定し、confirmed は `/zeus:plan` + `/zeus:dev` に委譲して修正計画化、false-positive / won't-fix は理由付きで返信 + スレッド resolve、clarification は説明返信のみ。push はしない（CLAUDE.md ルール準拠）
argument-hint: <PR番号 | PR URL>
---

# Zeus Resolve PR Review スキル（PR レビュー対応担当）

PR で受けた指摘に **対応する側** のスキル。`/zeus:pr-review` がレビューを「書く」のに対し、これは「書かれた指摘を捌く」。
出典は問わない（zeus が書いた / CodeRabbit が書いた / 人間レビュアーが書いた、すべて対象）。

## 引数仕様

```
/zeus:resolve-pr-review 42                                       # 現在の repo の PR #42
/zeus:resolve-pr-review https://github.com/owner/repo/pull/42    # 他 repo の PR
```

引数なしはエラー終了。

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Review Validator | `zeus-review-validator` | 各 finding を **「該当コードと照合して妥当性判定」**。confirmed / false-positive / partial / out-of-scope / additional に分類 |

`/zeus:plan` 橋渡し時は `zeus-explorer` / `zeus-architect` / `zeus-plan-reviewer` も間接的に走る。

## ディレクトリ規約

```
.claude/zeus/pr-resolutions/{ts}-{repo-slug}-{N}/
├── input.md                ← PR 情報 + 未 resolved スレッド一覧
├── memory-snapshot.md      ← .zeus/review-memory.md の内容
├── threads.json            ← GraphQL で取得した生データ
├── validated.md            ← validator 出力（指摘ごとの分類 + 理由）
├── actions.md              ← 分類結果と決定アクション（reply / resolve / handoff）
├── replies-payload.md      ← false-positive / won't-fix / clarification の返信文面
├── plan-handoff.md         ← confirmed を /zeus:plan に渡す修正タスク記述
└── memory-diff.md          ← .zeus/review-memory.md への追記内容
```

## 実行フロー

### Phase 1: 引数解析 + 前提チェック

1. 引数を `{owner, repo, number}` にパース
2. `gh auth status` で認証確認、失敗ならエラー終了
3. `gh pr view <N> --repo {owner}/{repo} --json number,title,headRefOid,state,isDraft,baseRefName,headRefName,url` で PR メタ取得
4. **state != OPEN** ならエラー終了
5. `gh api user --jq .login` で自分のログイン名を取得（自分の返信を識別するため）

### Phase 2: メモリ読み込み

`.zeus/review-memory.md` を Read（無ければ空）。`memory-snapshot.md` にコピー。
won't-fix 判定とコメント分類の文脈として使う。

### Phase 3: 未 resolved スレッド取得（GraphQL）

```bash
gh api graphql -f query='
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            startLine
            comments(first: 50) {
              nodes {
                id
                databaseId
                author { login }
                authorAssociation
                body
                createdAt
                path
                line
                originalLine
                diffHunk
              }
            }
          }
        }
      }
    }
  }
' -F owner={owner} -F name={repo} -F number={N} > threads.json
```

フィルタ:

- **`isResolved = false`** のスレッドのみ
- **`isOutdated = true` は除外**（行が消えた指摘は別途扱い）
- 各スレッドの **最初のコメント** を「元の finding」、それ以降を「議論履歴」として保持
- **最新コメントが自分（gh login）の返信** なら処理済みとしてスキップ（重複返信防止）

スレッドが 0 件なら `actions.md` に「未 resolved スレッドなし」と書いて Phase 8 へジャンプ。

### Phase 4: validator で分類

`zeus-review-validator` を 1 体起動。プロンプトには以下を渡す:

- `input.md`（PR タイトル・本文・該当ファイル一覧）
- `threads.json` から整形した「指摘 + 議論履歴」のリスト
- `memory-snapshot.md` の内容（**Won't Fix Patterns / Project Conventions に該当しないか必ず照合せよ** と明記）
- 各 finding について以下のフォーマットで判定するよう指示:

  ```
  ### Thread #{i}: {path}:{line} (出典: {author})

  - **元の指摘**: {要約}
  - **議論履歴**: {あれば}
  - **該当コードの現状**: {Read で確認した内容}
  - **分類**: confirmed | false-positive | partial | wont-fix-by-policy | clarification-needed | out-of-scope
  - **理由**: {判断根拠 100-200 字}
  - **アクション**: {handoff / reply-reject / reply-wontfix / reply-clarify / skip}
  ```

分類の定義:

| 分類 | アクション | 説明 |
|---|---|---|
| `confirmed` | handoff | 妥当な指摘。`/zeus:plan` に修正タスクとして渡す |
| `partial` | handoff（縮小スコープで）+ reply | 一部正しい。修正計画に乗せつつ、何を採用し何を却下したか返信 |
| `false-positive` | reply-reject + resolve | 該当コードを確認した結果、指摘が成立しない。根拠を返信 |
| `wont-fix-by-policy` | reply-wontfix + resolve + memory 追記 | `.zeus/review-memory.md` の方針に該当 or プロジェクト方針上意図的。返信で説明、メモリに該当エントリへの参照を追記 |
| `clarification-needed` | reply-clarify | 指摘の意図が不明。質問返信（resolve しない） |
| `out-of-scope` | reply-rejection + resolve | この PR の範囲外。別 issue 推奨返信 |

結果を `validated.md` に全文保存。

### Phase 5: アクション集計

`validated.md` を解析して以下に分類:

```
.claude/zeus/pr-resolutions/{ts}-...-{N}/actions.md
```

```markdown
# アクション集計

## handoff（/zeus:plan で修正計画化）
- Thread #1: path/to/file.ts:42 (confirmed)
- Thread #3: path/to/another.ts:10 (partial)

## reply + resolve
- Thread #2 (false-positive): {要約}
- Thread #5 (wont-fix-by-policy): {要約}
- Thread #7 (out-of-scope): {要約}

## reply only（resolve しない）
- Thread #4 (clarification-needed): {要約}

## skip
- Thread #6: 最新コメントが自分の返信。処理済み
```

### Phase 6: 返信投稿 + resolve（reject / wont-fix / clarification）

各「reply」対象スレッドについて、返信文面を生成して `replies-payload.md` にプレビュー出力。
返信テンプレート例:

#### false-positive

```markdown
@{author} ご指摘ありがとうございます。zeus で該当コードを再確認した結果、以下の理由でこの指摘は **成立しない** と判断しました。

**確認内容**:
{該当コードの動作 / 引用}

**判断理由**:
{なぜ false-positive か}

スレッドを resolve します。誤判定の場合は un-resolve してください。

<!-- zeus:resolve-pr-review reviewed-sha={head-sha} validator=confirmed-false-positive -->
```

#### wont-fix-by-policy

```markdown
@{author} ご指摘ありがとうございます。この点については **プロジェクト方針上意図的に現状の実装としています**。

**理由**:
{方針の説明 + .zeus/review-memory.md の該当エントリへの参照}

`.zeus/review-memory.md` の `Won't Fix Patterns` に追記済みなので、次回以降の自動レビューでも同じ指摘は出ません。

<!-- zeus:resolve-pr-review reviewed-sha={head-sha} validator=wont-fix-by-policy -->
```

#### clarification-needed

```markdown
@{author} ご指摘ありがとうございます。意図を確認させてください。

{具体的に何が不明か / どういう情報があれば対応できるか}

確認後にこのスレッドで再度判断します。

<!-- zeus:resolve-pr-review reviewed-sha={head-sha} validator=clarification-needed -->
```

#### out-of-scope

```markdown
@{author} ご指摘ありがとうございます。妥当な観点と思いますが、**この PR のスコープ外** のため別 issue / 別 PR として扱うことを提案します。

**理由**:
{なぜスコープ外か}

このスレッドは resolve しますが、別途追跡したい場合は issue 化してください。

<!-- zeus:resolve-pr-review reviewed-sha={head-sha} validator=out-of-scope -->
```

#### 投稿手順

1. 各スレッドの最初のコメント `databaseId` に対して `gh api -X POST repos/:o/:r/pulls/:N/comments/{id}/replies -f body="{返信文}"` で返信
2. **resolve 対象（false-positive / wont-fix / out-of-scope）** はその直後に GraphQL `resolveReviewThread` で resolve
3. `clarification-needed` は resolve しない（議論継続）

### Phase 7: メモリ更新（wont-fix-by-policy 分のみ）

新規に `Won't Fix Patterns` に追加すべきエントリを `memory-diff.md` に書き出す。
既に同等パターンがメモリにあれば追記スキップ。

メモリ更新は **`git add` まで**、commit / push はしない。

### Phase 8: confirmed / partial の /zeus:plan 橋渡し

`actions.md` の handoff リストが **1 件以上** あれば:

1. `plan-handoff.md` を作成:

   ```markdown
   # PR #{N} レビュー指摘の修正タスク

   - 元 PR: {url}
   - 対象スレッド数: {N}
   - validator 出力: .claude/zeus/pr-resolutions/{ts}-...-{N}/validated.md

   ## 修正対象の指摘

   ### Critical / Major
   - [{tag}] `path/to/file.ts:42` — {問題} → {修正方針}
     - 元コメント URL: {thread.html_url}
     - 出典: {author}
     - validator 判定: confirmed

   ### Nitpick / Suggestion
   - ...

   ### 部分採用 (partial)
   - [{tag}] `path/to/another.ts:10` — 採用部分: {} / 却下部分: {}

   ## 修正方針サマリ

   {全体の修正方針、優先度、ビルド順序のヒント}

   ## 完了基準

   各 thread の resolve は、修正コミットを push 後に **`/zeus:pr-review {N}` の re-review** が走れば自動 resolve される（fingerprint 一致しないため）。手動 resolve は不要。
   ```

2. `Skill` ツールで `zeus:plan` を起動し、`plan-handoff.md` を引数として渡す:

   ```
   Skill(skill="zeus:plan", args="PR #{N} のレビュー指摘 {handoff件数} 件を修正。詳細は .claude/zeus/pr-resolutions/{ts}-...-{N}/plan-handoff.md を参照")
   ```

3. `/zeus:plan` 完了後、ユーザーに `/zeus:dev <plan.md>` で実装に進む案内が出る（plan スキル側の責務）

4. **/zeus:dev は commit までしか進めない**。push はユーザー手動（CLAUDE.md の add / commit / push 分離ルール）

handoff が 0 件なら Phase 8 をスキップ。

### Phase 9: 結果報告

```
## /zeus:resolve-pr-review 完了

- PR: {owner}/{repo}#{N} "{title}"
- 未 resolved スレッド: {total} 件
  - confirmed (→ handoff): {a}
  - partial (→ handoff): {b}
  - false-positive (→ reject + resolve): {c}
  - wont-fix-by-policy (→ reject + resolve + memory): {d}
  - clarification-needed (→ reply only): {e}
  - out-of-scope (→ reject + resolve): {f}
  - skip (処理済み): {g}
- 投稿: {reply件数} reply、{resolve件数} スレッド resolve
- メモリ追記: {n} 件 ({.zeus/review-memory.md})
- /zeus:plan 橋渡し: {handoff件数 > 0 ? "Yes" : "No"}

### 次アクション
- 修正実装: {/zeus:plan が起動済 → /zeus:dev で実装続行 / 起動なし → なし}
- push 前確認: 実装完了後、ユーザーが手動で commit / push してください
```

## 動作原則

- **対象は未 resolved スレッド全て**: 出典（zeus / CodeRabbit / 人間）を問わない
- **判断は validator 1 体**: 既存 `zeus-review-validator` を流用。専用エージェントは追加しない
- **resolve は明確な拒否時のみ**: false-positive / wont-fix / out-of-scope のみ resolve。clarification は議論継続のため resolve しない
- **修正実装は /zeus:plan + /zeus:dev に委譲**: 自前で書かない。既存パイプラインを再利用
- **push は絶対にしない**: shared state への影響が大きいため、必ずユーザー手動。CLAUDE.md の add / commit / push 分離ルールに準拠
- **メモリ更新は git add まで**: 自動コミットしない
- **自分の返信が最新ならスキップ**: 重複返信防止（冪等性）
- **isOutdated スレッドは扱わない**: 行が消えている指摘は別途。誤反応を避ける
- **bot 出典でも対等に判定**: CodeRabbit / dependabot / 他の bot レビュアーも同じ validator に通す
- **clarification 後は人間ユーザーの返信待ち**: 議論を続けたい場合は手動で次のターン

## 他スキルとの使い分け

| スキル | 用途 |
|---|---|
| `/zeus:pr-review <N>` | PR に **レビューを書く** 側（findings 投稿） |
| **`/zeus:resolve-pr-review <N>`** | **PR で受けた指摘を捌く** 側（妥当性判定 + 返信 / 修正計画化） |
| `/zeus:plan <task>` | 修正タスクを実装計画化（resolve から橋渡し） |
| `/zeus:dev <plan.md>` | plan に従って実装（コミットまで） |

レビュー往復のフロー全体:

```
他レビュアーが PR にコメント
  ↓
/zeus:resolve-pr-review <N>
  ↓ validator で分類
  ├─ false-positive / wont-fix / out-of-scope → 返信 + resolve
  ├─ clarification-needed → 返信のみ
  └─ confirmed / partial → /zeus:plan
       ↓
     /zeus:dev でコミットまで実装
       ↓
     ユーザーが手動 push
       ↓
     /zeus:pr-watch が新 SHA 検知
       ↓
     /zeus:pr-review が re-review → fingerprint 一致しない指摘は auto-resolve
```
