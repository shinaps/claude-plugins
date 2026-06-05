---
name: refactor-loop
description: コードベース全体を継続的にリファクタする無人ループスキル。zeus-refactor-scout が「次にリファクタすべき 1 件」を返し、zeus-refactor-implementer が contract boundary を宣言した上で characterization test 整備 → 内部実装の大胆な変更 (state 統合・hook 抽出・責務再編) → contract 維持のテスト検証まで完走、テスト通過したら refactor プレフィックスで自動コミットして次ラウンドへ。安全性は implementer のセルフ検証 + 次ラウンド scout の regression-suspect 再点検で二段防御
argument-hint: [max=N] [include=<glob>] [exclude=<glob>]
---

## 引数仕様

| 呼び出し | 動作 |
|---|---|
| `/zeus:refactor-loop` | 無限ループ。scout が "no-more" を返すまで継続 |
| `/zeus:refactor-loop max=10` | 最大 10 ラウンドで停止 |
| `/zeus:refactor-loop include="src/**/*.ts"` | scout の探索範囲を絞る |
| `/zeus:refactor-loop exclude="src/legacy/**"` | デフォルト除外に追加 |

引数は順不同、複数渡し可。`max` は省略可 (デフォルト無限)。

## ディレクトリ規約

```
.claude/zeus/{YYYYMMDD-HHMMSS}-refactor-loop/
├── done.md                       ← 全ラウンドの履歴 (scout が次ラウンドで読む)
├── summary.md                    ← 全完了後の総括レポート
├── refactor-1.md                 ← ラウンド 1 の refactor-implementer ログ
├── refactor-2.md                 ← ラウンド 2 の refactor-implementer ログ
├── ...
└── raw/
    ├── scout-1.md                ← ラウンド 1 の scout 生レポート
    ├── scout-2.md
    └── ...
```

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Refactor Scout | `zeus-refactor-scout` | 改善対象 1 件を返却 + 直近 3 件の regression-suspect 再点検 |
| Zeus Refactor Implementer | `zeus-refactor-implementer` | contract boundary 宣言 → characterization test → リファクタ → contract 維持検証 |

## 実行フロー

### Phase 1: 初期化

1. 引数を parse:
   - `max=N` → 最大ラウンド数 `MAX_ROUNDS` (省略時は無限、ただし安全のため hard limit 50)
   - `include=<glob>` → 探索範囲 include 上書き
   - `exclude=<glob>` → デフォルト除外に追加
2. 作業ディレクトリを作成: `.claude/zeus/{YYYYMMDD-HHMMSS}-refactor-loop/`
3. `raw/` サブディレクトリも作成
4. `done.md` を初期化:

```markdown
# refactor-loop 履歴

開始: {YYYY-MM-DD HH:MM:SS}
include: {デフォルト or 引数で上書き}
exclude: {デフォルト + 引数追加}

| ラウンド | ファイル | スコープ | 対応 | 状態 |
|---|---|---|---|---|
```

5. 現在の git の clean 状態を確認 (working tree が dirty なら `AskUserQuestion` で「stash する / 中断 / dirty のまま進める」を確認)

### Phase 2: ラウンドループ

`round = 1` から開始し、以下を `MAX_ROUNDS` または終了条件まで繰り返す:

#### Phase 2a: scout 起動

`zeus-refactor-scout` に以下を渡して起動:

- `WORK_DIR` (作業ディレクトリパス)
- `done.md` パス
- include / exclude Glob (デフォルト + 引数追加)
- モード: `normal` (普通) / `regression-recheck-priority` (再点検優先)

scout の応答を `raw/scout-{round}.md` に全文保存。

scout の返却 JSON を parse:

| status | アクション |
|---|---|
| `found` | Phase 2b へ |
| `regression-suspect` | Phase 2b へ (`refactor-implementer` には `regression_suspect_from_round` も渡す) |
| `no-more` | **ループ終了** → Phase 3 へ |

#### Phase 2b: refactor-implementer 起動

`zeus-refactor-implementer` に以下を渡して起動:

- `WORK_DIR`
- scout の出力 JSON 全体
- ラウンド番号 `{round}`

implementer は Phase 0〜F を内部で完走し、`refactor-{round}.md` を執筆して以下のいずれかの状態で返ってきます:

- `done`: contract 維持で実装完了、テスト pass
- `skipped: {理由}`: contract 定義困難 / characterization 不能 / その他で中止
- `failed: {理由}`: 実装したが contract 違反、revert 必要

#### Phase 2c: 状態別アクション

##### `done` の場合

そのまま Phase 2e (コミット) へ進む。

##### `skipped` の場合

1. `git status` で working tree が変更されているか確認:
   - characterization test だけが追加された状態 (Phase B 完了で skip) → そのまま残す or 破棄を `AskUserQuestion` で確認 (デフォルト: 残す。テスト追加自体は価値)
   - 何も変更されていない → そのまま Phase 2e へ
2. done.md に追記:

```
| {round} | {target.file} | {target.scope} | skipped: {理由} | skipped |
```

3. Phase 2e へ

##### `failed` の場合

1. `git restore .` で working tree を破棄 (まだコミットしていないので安全)

```bash
git restore .
git clean -fd  # 新規ファイル (失敗した characterization test 等) も破棄
```

2. done.md に追記:

```
| {round} | {target.file} | {target.scope} | failed: {理由} | reverted |
```

3. **同じファイルが 2 ラウンド連続で fail した場合**, そのファイルを done.md に `permanently-skipped` 状態で記録し、scout が今後扱わないようにマーク
4. Phase 2e へ

#### Phase 2e: コミット & 次ラウンド準備

`done` の場合のみ実行:

1. `git status` で変更ファイルを確認 (空なら何も変えなかったのでコミットスキップ、done.md に `no-op` 記録)
2. 変更があれば:
   - `git add` で実装変更 + characterization test を staging
   - `refactor:` プレフィックスでコミット:

```bash
git commit -m "$(cat <<'EOF'
refactor: {implementer のコミットメッセージ案 1 行}

- 対象: {target.file} / {target.scope}
- Contract: {Contract Boundary サマリ 1〜2 行}
- See: {WORK_DIR}/refactor-{round}.md
EOF
)"
```

3. done.md に追記:

```
| {round} | {target.file} | {target.scope} | done: {改善内容 1 行} | committed |
```

4. `round += 1` してループ継続

#### 終了条件

- `round > MAX_ROUNDS`
- scout が `no-more` を返した
- ユーザーが `AskUserQuestion` で「中断」を選んだ (途中で `AskUserQuestion` が発生する場面: dirty working tree 検出時、failed が連続発生時など)
- hard limit 50 ラウンド到達

### Phase 3: 総括レポート

`summary.md` を以下のフォーマットで作成:

```markdown
# refactor-loop 完了レポート

- 開始: {YYYY-MM-DD HH:MM:SS}
- 完了: {YYYY-MM-DD HH:MM:SS}
- 終了理由: max-rounds-reached | no-more | user-interrupted | hard-limit
- 総ラウンド数: {N}
- 成功 (committed): {N}
- skipped: {N}
- failed (reverted): {N}

## 改善サマリ

- {ラウンド N}: {target} — {改善内容 1 行}
- ...

## permanently-skipped (今後扱わない)

- {file}: 連続 fail のためマーク済み

## 推奨される次のアクション

- 全体テストの再実行 (個別ラウンドで全体スイートが走っていないものがある場合)
- 型チェック / ビルド の最終確認
- {その他、ラウンド中に発見された out_of_scope_findings がある場合は別途扱う旨}

## ラウンド別詳細

- ラウンド 1: `./refactor-1.md`
- ラウンド 2: `./refactor-2.md`
- ...
```

ユーザーに「合計 {N} 件のリファクタが完了しました。詳細は `{WORK_DIR}/summary.md` を参照」と短く報告して終了。

## デフォルト除外 Glob (scout に渡す)

以下はデフォルトで除外:

- `**/node_modules/**`
- `**/dist/**` / `**/build/**` / `**/.next/**` / `**/out/**`
- `**/__generated__/**` / `**/generated/**` / `**/*.generated.*`
- `**/*.test.*` / `**/*.spec.*` / `**/__tests__/**`
- `**/vendor/**` / `**/third_party/**`
- `**/.git/**` / `**/.claude/**`
- ロックファイル (`*.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` 等)
- ビルド設定ファイル (`tsconfig*.json`, `next.config.*`, `vite.config.*`, `webpack.config.*` 等)

`exclude=<glob>` 引数で追加可、`include=<glob>` 引数で範囲を絞れる。

## 動作原則

- **無人ループだが安全側に倒す**: 各ラウンドはテスト pass + contract 維持を確認してからコミット
- **failed は git restore で巻き戻す**: 動作しない状態のコミットは絶対に残さない
- **scout の再点検でデグレを後追い検出**: 直近 3 ラウンドの結果を次ラウンドの scout が軽く読む
- **EnterPlanMode は使わない**: bypassPermissions モードと両立
- **dirty working tree の扱いは確認**: ユーザー意図を `AskUserQuestion` で確認してから進める
- **無限ループの hard limit**: 安全のため最大 50 ラウンドで強制停止
- **git push は自動化しない**: コミットはするが push はユーザー判断
