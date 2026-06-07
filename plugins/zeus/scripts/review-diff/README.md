# review-diff CLI

`/zeus:review-diff` スキルが起動する Node CLI 本体。
入力 (`summary.json` + `diff.patch` + 任意の `pr-meta.json`) から
Linear 風 UI の単一 HTML を組み立て、127.0.0.1 のローカル HTTP サーバーで配信して
ブラウザで Approve / Reject / コメントを受け取り、stdout に JSON 1 行で結果を返す。

## ビルド

```bash
npm install
npm run build   # → dist/cli.js (shebang 付き、755)
```

`dist/cli.js` はリポジトリに commit される (esbuild で Shiki / parse-git-diff / marked / DOMPurify を全部 bundle 済み)。
インストール側は Node 20+ さえあれば追加 install 不要。

## テスト

```bash
npm test
```

## 使い方

```bash
node dist/cli.js \
  --summary path/to/summary.json \
  --diff    path/to/diff.patch \
  [--pr-meta path/to/pr-meta.json]
```

- 起動時に stderr に `[review-diff] URL: http://127.0.0.1:<port>/?token=...` を出力 (再アクセス用)
- macOS では自動で `open` が走る
- 9 分タイムアウト (Bash ツール 10 分制約に合わせて)
- 結果は stdout に JSON 1 行: `{"decision":"approve"|"reject"|"timeout","reviewedFiles":[...],"comments":[...]}`

## セキュリティ

- 127.0.0.1 のみ listen (`localhost` も 403)
- ランダム 32 byte token をクエリパラメータと Origin で検証
- token 失敗 20 回でプロセス終了 (brute force ガード)
- CSP `default-src 'none'`
- すべてのレスポンスに `Cache-Control: no-store`, `Referrer-Policy: no-referrer` 等を付与
