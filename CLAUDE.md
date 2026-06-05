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
├── plugins/
│   └── <plugin-name>/
│       ├── .claude-plugin/
│       │   └── plugin.json     ← プラグイン本体メタデータ（version はここも更新必須）
│       ├── README.md
│       ├── skills/
│       │   └── <skill-name>/
│       │       └── SKILL.md
│       └── agents/
│           └── <agent-name>.md
└── CLAUDE.md                   ← このファイル
```

## 既存プラグイン

- `plugins/zeus/` — feature-dev 上位互換の開発フロープラグイン。spec / tech-survey / dev / review / debug の 5 スキル構成

## 関連リンク

- マーケットプレイス公式ドキュメント: https://docs.claude.com/ja/plugin-marketplaces
