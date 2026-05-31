---
name: ask
description: PM への読み取り専用問い合わせスキル。引数なしでブリーフィング (300 行サマリ)、`status` でファイル別軽量メタ情報、自由質問 (例 「先週何やった?」「○○の決定理由は?」) で PM ファイル + git log から回答。書き込みは一切行わない (書き込みは /pm:sync の責務)
argument-hint: <なし | status | 自由質問テキスト>
---

# PM Ask スキル（読み取り専用問い合わせ）

`/pm:init` で初期化したプロジェクト PM への **読み取り専用** インタラクション窓口。
ブリーフィング・軽量サマリ・自由質問のすべてをこの 1 スキルで処理する。

書き込みは一切行わない。状態更新が必要なときは `/pm:sync` を使う。

## 引数仕様

```
/pm:ask                          # ブリーフィング（state / roadmap / decisions / workflow を 300 行サマリ）
/pm:ask status                   # 軽量サマリ（各ファイルの行数・更新日時・件数のみ。エージェント起動なし）
/pm:ask 先週何やった?             # 自由質問: PM ファイル + git log を参照して回答
/pm:ask あの決定の理由は?         # 自由質問: decisions.md を中心に回答
/pm:ask 今日中に終わるタスクは?    # 自由質問: state.md + 進捗から推測して回答
```

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| PM Agent | `pm-agent` | `.pm/` `.pm-local/` を読んで質問に応答 (mode=ask) |

## 前提チェック

実行前に:

1. `.pm/` または `.pm-local/` のいずれかが存在するか確認
2. **どちらも存在しない** → `/pm:init` を案内して終了:
   ```
   PM が未初期化です。先に /pm:init を実行してください。
   ```

## 実行フロー

### Phase 1: 引数判定

| 引数 | モード判定 |
|---|---|
| なし | `brief` |
| `status` | `status` |
| 上記以外の文字列 | `freeform`（自由質問） |

### Phase 2: status モード（軽量サマリ、エージェント起動なし）

`pm-agent` を起動せず、スキル本体が直接 PM ファイルのメタ情報を集めて表示:

1. `.pm/` `.pm-local/` 配下の各 md ファイルについて:
   - 行数（`wc -l`）
   - 最終更新日時（`stat` or `git log -1`）
   - state.md: 進行中件数 / 最近完了件数 / ブロッカー件数
   - roadmap.md: 短期 / 中期 / 長期件数
   - decisions.md: エントリ件数
2. 1 画面に収まる形式で出力

出力例:

```
## PM Status

### .pm/ (team-shared)
- state.md     — 42 lines, updated 2026-05-22 14:30
  - 進行中: 3 件 / 最近完了: 8 件 / ブロッカー: 1 件
- roadmap.md   — 28 lines, updated 2026-05-20 10:15
  - 短期: 5 / 中期: 2 / 長期: 3
- decisions.md — 156 lines, 12 entries
- workflow.md  — 89 lines

### .pm-local/ (personal overlay) — 検出
- state.md     — 18 lines, updated 2026-05-22 16:00
- scratch.md   — 124 lines

### 直近の更新ファイル
1. .pm-local/state.md (today)
2. .pm/state.md (today)
3. .pm/decisions.md (3 days ago)
```

### Phase 3: brief モード

1. `pm-agent` を `mode=ask`, `request=brief` で起動
2. 返ってきたブリーフィング（300 行以内）をそのままユーザーに提示
3. 末尾に以下を追加:

```
---

ブリーフィングは `.pm/state.md` ほかから自動生成されています。
詳細を見るには各ファイルを直接 Read してください。
`/pm:sync` で最新の git 活動を反映できます。
自由質問は `/pm:ask <質問>` で。
```

### Phase 4: freeform モード（自由質問）

1. `pm-agent` を `mode=ask`, `request=<引数文字列>` で起動
2. エージェントの応答をそのままユーザーに提示
3. 応答末尾でユーザーに「該当情報が PM に無い場合は `/pm:sync` で取り込めるかもしれない」と案内（PM ファイルに該当情報無しと判定された場合のみ）

## 動作原則

- **読み取り専用**: 一切のファイル書き換えを行わない。書き込みは `/pm:sync` に委譲
- **status モードはエージェント起動なし**: 軽量・高速
- **brief モードは 300 行以内**: コンテキスト窓を圧迫しない
- **自由質問は出典明示**: PM ファイル / git log のどこから引いたか明記
- **空 PM ファイルでも動く**: スケルトンのまま中身が空でも brief は成立する
- **personal overlay 優先**: 同名ファイルがあれば personal が team を上書き / 補強する

## 他スキルとの関係

| スキル | 用途 |
|---|---|
| `/pm:init` | 初回セットアップ |
| **`/pm:ask`** | **PM への読み取り専用問い合わせ（このスキル）** |
| `/pm:sync` | PM ファイルへの書き込み窓口（git 活動から自動更新） |
