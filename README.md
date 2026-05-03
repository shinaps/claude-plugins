# shinaps claude-plugins marketplace

shinaps が公開する Claude Code プラグインのマーケットプレイス。

## インストール

```
/plugin marketplace add shinaps/claude-plugins
/plugin install zeus@shinaps
```

## アップデート

### インストール済みクライアントを最新化（ユーザー側）

GitHub に新バージョンが push されたあと、Claude Code 上で実行:

```
/plugin marketplace update shinaps
/plugin update zeus@shinaps
```

`/plugin marketplace update` だけだと marketplace カタログが更新されるのみで、プラグイン本体は変わりません。`/plugin update` までセットで実行してください。

> **重要**: 各プラグインの `plugin.json` の `version` フィールドが変わっていない場合、`/plugin update` しても「最新版です」と表示され実際には更新されません（後述の「リリース手順」参照）。

### リリース手順（開発者側）

```bash
cd ~/dev/claude-plugins

# 1. ファイルを編集
# 2. plugins/<name>/.claude-plugin/plugin.json の "version" をバンプ
#    例: 0.1.0 → 0.1.1
# 3. コミット・プッシュ
git add .
git commit -m "feat: ..."
git push
```

### ローカル開発中の即時テスト（push 不要）

```bash
claude --plugin-dir ~/dev/claude-plugins/plugins/zeus
```

起動後、ファイルを編集したら `/reload-plugins` で即時反映。push 前の動作確認に便利です。

## 同梱プラグイン

| 名前 | 説明 |
|---|---|
| `zeus` | ultraplan / feature-dev の上位互換となる超深掘り計画策定 + 実装プラグイン。 [詳細](./plugins/zeus/README.md) |

## ディレクトリ構成

```
.
├── .claude-plugin/
│   └── marketplace.json    # マーケットプレイス定義
└── plugins/
    └── zeus/               # zeus プラグイン本体
        ├── .claude-plugin/plugin.json
        ├── skills/
        │   ├── plan/SKILL.md   # /zeus:plan
        │   └── dev/SKILL.md    # /zeus:dev
        └── agents/             # 4体のzeus専用エージェント
            └── zeus-*.md
```
