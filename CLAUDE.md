# claude-plugins リポジトリ規約

shinaps の Claude Code プラグインマーケットプレイス。
プラグイン本体は `plugins/<plugin-name>/` 配下、マーケットプレイス定義は `.claude-plugin/marketplace.json`。

## バージョン更新ルール（最重要）

プラグインのバージョンを上げる時は **2 ファイル両方** を必ず同じバージョンに揃えること。

| ファイル | 用途 |
|---|---|
| `.claude-plugin/marketplace.json` の対象プラグインの `version` | マーケットプレイス側のバージョン表示 |
| `plugins/<plugin-name>/.claude-plugin/plugin.json` の `version` | **`/plugin marketplace update` がアップデート判定に使う実体** |

### なぜこのルールが必要か

`marketplace.json` の version だけ上げて `plugin.json` の version を据え置きにすると、`/plugin marketplace update <marketplace>` を実行しても **「すでに最新です」と判定されてアップデートが配信されない**。
Claude Code はインストール済みプラグインのバージョン比較に `plugin.json` の `version` を使うため。

過去にこの漏れで `/zeus:tech-survey` スキル追加 (v0.6.0) がインストール側に届かない事故が発生した（commit 1798cfa の fix で対応）。

### 適用方法

プラグインに変更を加えてバージョンを上げる時は、以下を **必ずセットで** 実行する:

1. `.claude-plugin/marketplace.json` の対象 plugin の `version` を更新
2. `plugins/<plugin-name>/.claude-plugin/plugin.json` の `version` を **同じ値に** 更新
3. 必要なら両ファイルの `description` も整合性を取る（同梱エージェント数、スキル一覧など）
4. コミット・push 後、ユーザーは `/plugin marketplace update <marketplace>` でアップデート反映

### セマンティックバージョニング指針

- `MAJOR.MINOR.PATCH`
- スキル / エージェントの **新規追加** や破壊的変更ではない大きめの機能追加 → `MINOR` 上げ
- 軽微な修正・ドキュメント変更 → `PATCH` 上げ
- 既存スキルの引数仕様や挙動を破壊的に変える → `MAJOR` 上げ

## ディレクトリ構造

```
claude-plugins/
├── .claude-plugin/
│   └── marketplace.json        ← マーケットプレイス定義（全プラグインを列挙）
├── pnpm-workspace.yaml         ← pnpm workspace 定義（plugins/*/scripts/* を登録）
├── package.json                ← workspace ルート（private、pnpm.onlyBuiltDependencies に esbuild）
├── pnpm-lock.yaml              ← 全 workspace の依存ロック
├── plugins/
│   └── <plugin-name>/
│       ├── .claude-plugin/
│       │   └── plugin.json     ← プラグイン本体メタデータ（version はここも更新必須）
│       ├── README.md
│       ├── skills/
│       │   └── <skill-name>/
│       │       └── SKILL.md
│       ├── agents/
│       │   └── <agent-name>.md
│       └── scripts/            ← Node CLI 同梱が必要なスキル用（任意）
│           └── <skill-name>/
│               ├── package.json (workspace 内パッケージ、ESM)
│               ├── tsconfig.json
│               ├── build.mjs (esbuild バンドラ)
│               ├── .gitattributes (dist/cli.js text eol=lf)
│               ├── .gitignore (node_modules/, .tmp/, .screenshots/)
│               ├── src/
│               └── dist/cli.js ← **git commit 対象**（shebang + 755）
└── CLAUDE.md                   ← このファイル
```

## Node CLI 同梱スキルの規約

スキルが Node CLI を必要とする場合（例: `/show-me:diff`）は、以下を守る。

### バンドル成果物を commit する
- `dist/cli.js` を **git commit する**（postinstall ビルドはユーザー環境で破綻するため）
- `.gitattributes` で `dist/cli.js text eol=lf` を必須（Windows CRLF で shebang 崩壊防止）
- esbuild の `banner: { js: '#!/usr/bin/env node' }` + build script で `chmod 755`

### pnpm workspace に登録
- `pnpm-workspace.yaml` の `packages: ["plugins/*/scripts/*"]` で自動認識
- ルートで `pnpm install` すれば全 CLI の deps が入る
- `pnpm --filter <package-name> build` で個別ビルド可

### SKILL.md の CLI パス解決
`${CLAUDE_PLUGIN_ROOT}` は空のことがあるため、以下の二段解決を SKILL.md に入れる:

```bash
# Dogfooding 優先: claude-plugins リポ自身なら local dist/cli.js を使う
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
REPO_CLI="${REPO_ROOT}/plugins/<plugin>/scripts/<skill>/dist/cli.js"
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/.claude-plugin/marketplace.json" ] && [ -f "$REPO_CLI" ]; then
  CLI="$REPO_CLI"
else
  # 通常: marketplace cache 配下の最新版。owner 名は glob で抽象化して fork 対応
  PLUGIN_DIR=$(ls -td ~/.claude/plugins/cache/*/<plugin>/*/ 2>/dev/null | head -1)
  CLI="${PLUGIN_DIR}scripts/<skill>/dist/cli.js"
fi
[ -f "$CLI" ] || { echo "CLI not found at $CLI"; exit 1; }
```

これによりリポ内で開発中は `pnpm build` だけで即反映（push + marketplace update 不要）。

### Dogfooding 手順
1. `plugins/<plugin>/scripts/<skill>/src/` でコード変更
2. `pnpm --filter <package-name> build` で `dist/cli.js` 再生成
3. リポ内で `/<plugin>:<skill>` を起動 → ローカル `dist/cli.js` が使われる
4. 動作 OK ならコミット・push（dist/cli.js も含める）

### dist/cli.js の更新タイミング
- `src/` を触ったら必ず rebuild + commit（SKILL.md 変更だけなら不要）
- バージョン上げは「src/ または SKILL.md に意味のある変更があったとき」

## コミット時の規約（dogfooding）

このリポジトリ内で **Claude が `git commit` を作成する前** に、必ず `/show-me:diff` を起動して人間の承認を得ること。

### 手順
1. 変更ファイルを `git add` で staging
2. `/show-me:diff` を起動 → ブラウザでレビュー
3. **Approve** を受け取ってから `git commit` 実行
4. **Reject** ならコメントを反映 → 再度 staging → `/show-me:diff` で再 review

### 理由
- このリポジトリ自体が `/show-me:diff` の開発元なので、自分たちで使って UX のフィードバックを得る
- AI が勝手に commit を量産する事態を防ぎ、人間ゲートが入る
- レビュー UI で気付いた改善要望が即フィードバックとなり、自己強化ループになる

### 例外
- README / CLAUDE.md / docs のみの軽微な修正は省略してよい (Claude 自身の判断)
- 緊急の fix で一刻を争う場合はユーザー明示の許可で省略可

## 既存プラグイン

- `plugins/zeus/` — feature-dev 上位互換の開発フロープラグイン。spec / dev / review / debug / refactor-loop の 5 スキル構成
- `plugins/show-me/` — 人間ゲートの最終承認プラグイン。`diff` の 1 スキル構成で、Node CLI（React + Hono + Shiki）を `scripts/diff/` に同梱

## 関連リンク

- マーケットプレイス公式ドキュメント: https://docs.claude.com/ja/plugin-marketplaces
