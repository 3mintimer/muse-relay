# 公開ガイドのビルドとローカル起動

[English](README.md)

`web/` が公開ページ、`worker.mjs` がページ配信と受付APIの共通入口です。ローカル起動とSites向けビルドは同じ処理を使います。アプリのEHPKとは別にビルドします。

## 表示言語とリンク

初期表示は英語です。ヘッダーの **English / 日本語** で、ページを再読込せず切り替えます。`?lang=ja#connection` なら日本語の接続手順へ、`?lang=en#setup` なら英語の構成選択へ直接移動できます。既存の `#setup`・`#connection`・`#voice`・`#relay`・`#feedback` はそのまま使えます。

切替時も、中継・音声・画像の選択、手順、HUDの状態、フォームの入力と公開同意を保持します。URLへ書くのは言語だけです。下書き・接続設定・同意を保存したりURLへ入れたりせず、言語変更による送信も行いません。

| ファイル | 役割 |
| --- | --- |
| `web/index.html` | 英語の初期本文と明示的な翻訳対象 |
| `web/app.js` | 両言語で共有する操作・手順・依頼文・フォーム処理 |
| `web/i18n.js` | 言語・プレースホルダー・翻訳対象・資料リンクの切替 |
| `web/messages.js` | 英語をキーとする日本語の翻訳 |
| `web/style.css` | 両テーマ・画面幅に共通のスタイル |

ARIA・エラー・AI依頼文も文単位で翻訳します。`{0}` 等の番号は保持し、仕様のJSONを置換対象にしません。利用者の入力は翻訳しません。日本語資料があるGitHubリンクだけを `i18n.js` の一覧で `.ja.md` へ切り替え、他の技術資料はcanonicalの `.md` を使います。

確認には合成の下書きを使い、言語を往復して選択・入力・同意の保持、全方式の依頼文、5つのアンカー、エラー表示を点検します。フォーム表示はローカルの応答で確認し、本番へテスト送信しません。ブラウザーのレイアウトと実機の動作確認は分けます。

## ローカル

Node.js 24以降で、リポジトリのルートから実行します。

```sh
npm --prefix guide ci
npm --prefix guide run dev
```

[http://127.0.0.1:5188](http://127.0.0.1:5188) を開きます。`web/` の編集後はページを再読込します。ポートを変える場合は `GUIDE_PORT=5190 npm --prefix guide run dev` を使います。外部のインターフェースには待受しません。

| ローカルの受付 | 動作 |
|---|---|
| DB | migration適用済みのメモリDB。停止すると消える |
| 秘密値 | 起動時に乱数で生成し、表示・保存しない |
| 送信先 | ローカルの `/api/feedback` のみ |
| 接続元制限 | ループバックで共有。1時間3件を確認した後に繰り返す場合はdevを再起動 |

実際の要望・会話・秘密情報はプレビューへ入力しません。本番のD1・GitHubへは接続しません。

## 確認とビルド

```sh
npm --prefix guide test
npm --prefix guide run build
```

```text
guide/dist/
├── server/index.js
└── .openai/
    ├── hosting.json
    └── drizzle/
        ├── 0000_feedback.sql
        └── meta/
```

Worker ESMへ `web/` の公開アセットを埋め込みます。HTML・JS・CSS・画像・フォント・公開JSON等の許可した拡張子だけを扱い、隠しファイルは除外、symlinkは拒否します。個人設定・DB・秘密値は含めません。ファイルごと2MB、合計8MBのビルド上限があります。画像等を追加した場合は、配備先のWorkerサイズ上限も確認してください。

出力先を変える場合は `npm --prefix guide run build -- --outdir /absolute/path/to/dist` を使います。既存のapp用ルート `dist/` と混在させないでください。

| 配信 | 動作 |
|---|---|
| `/`・公開ファイル | GET / HEAD。ETagによる304応答 |
| 存在しないパス | 404 |
| 対応しないメソッド | 405、Allowヘッダー |
| `/api/feedback` | 既存の `handleFeedback` へ接続。POSTのみ |
| CSP | script / style / connectを同じOriginに限定。iframe埋込不可 |
| その他 | `Referrer-Policy: no-referrer`、`nosniff`、入力値のログなし |

## 独立したSites checkout

Sitesの作成・同期・配備は保守担当者が行います。この公開ソースに特定のSite IDは含めません。

1. 登録済みSiteのcheckoutへ、この `guide/` の内容を置きます。checkoutの `.openai/hosting.json` は維持します。
2. manifestはWorker形式（`static` を指定しない）とし、D1 bindingを `DB` にします。未使用のR2は `null` です。
3. `FEEDBACK_RATE_SECRET` をSitesのsecretへ設定します。ランダムな32文字以上で、ブラウザー・ソース・ビルド出力へ入れません。
4. checkout内で `npm ci` → `npm test` → `npm run build`。成果物をSitesの通常手順で配備します。

ビルドは実行ディレクトリの `.openai/hosting.json` を優先し、次にビルドスクリプトと同じディレクトリのmanifestを探します。どちらもなければ `hosting.example.json` の `{d1:"DB",r2:null}` を使います。既存の `project_id` などのフィールドは保持します。例だけの成果物にはSite IDがないため、そのまま本番配備しません。

スキーマを変更する場合は `npm --prefix guide run db:generate` でmigrationを追加します。適用済みmigrationを書き換えず、schema-onlyに保ちます。Sitesは `dist/.openai/drizzle/` のmigrationを配備時に適用します。

受付の制限・同意・保管・削除・本番の動作確認票については、リポジトリの [docs/feedback.md](https://github.com/3mintimer/muse-relay/blob/main/docs/feedback.md) を参照してください。
