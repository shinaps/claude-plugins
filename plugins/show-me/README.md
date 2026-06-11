# show-me

staged diff / PR diff を Linear 風 stacked PR UI でブラウザに開き、**人間が目で見て最終承認する**ためのプラグイン。

AI に観点別の分析をさせるレビュー (zeus プラグインの `/zeus:review` 等) とは責務が違い、こちらは「AI が組んだ読書順のナラティブに沿って人間が差分を確認し、group 単位で Approve / Request Changes を返す」ゲートです。Submit すると linear stack で先頭から approved group を 1 commit ずつ作り、最初の request-changes で打ち切って残りは un-commit のまま Claude に戻します。

## インストール

```
/plugin install show-me@shinaps
```

Node 20+ が必要です (同梱 CLI が node20 ターゲット)。CLI は bundle 済みの `dist/cli.js` を同梱しているため、ユーザー環境での npm install は不要です。

## 使い方

| 呼び出し | モード | 動作 |
|---|---|---|
| `/show-me:diff` | staged | `git diff --cached` をレビュー対象にする |
| `/show-me:diff 123` | pr | PR #123 の diff をレビュー対象にする |

ブラウザに UI が開き、group 単位の Approve / Request Changes、group / ファイル / 行単位のコメント、スレッド返信 (Claude が返信して再起動する comment-reply ループ)、context+ (表示範囲の拡張要求) が使えます。

## 生成物

```
.claude/show-me/diffs/{YYYYMMDD-HHMMSS}-{slug}/
├── summary.json     ← AI が組んだ group / panel ナラティブ
├── diff.patch       ← レビュー対象の diff
├── pr-meta.json     ← PR モードのみ
├── result.json      ← レビュー結果 (decision / groupDecisions / threads)
├── restore.json     ← regen / comment-reply の close-relaunch 用 state
└── trusted-config.json ← PR モードのみ (base ref から抽出した config)
```

## config (任意)

`.claude/show-me/diff.config.json` をリポジトリに置くと、起動前スクリプトゲート (test / typecheck をレビュー UI を開く前に強制) とエディタリンク (toBe 行の hover からエディタで開く) が使えます。設定例は [`skills/diff/example.diff.config.json`](skills/diff/example.diff.config.json) を参照。

config を作らない場合は初回起動時に誘導が出ます。`.claude/show-me/diff.no-config` を置くと誘導を永続的にスキップします。

## CLI 開発 (dogfooding)

claude-plugins リポジトリ内では、ローカルでビルドした `scripts/diff/dist/cli.js` が marketplace キャッシュより優先されます:

```bash
pnpm --filter @show-me/diff build   # client → cli の順にビルドして dist/cli.js を再生成
```

`src/` を変更したら rebuild + `dist/cli.js` の commit が必須です (リポジトリルートの CLAUDE.md 参照)。
