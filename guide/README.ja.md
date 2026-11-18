# 公開ガイドのビルドとローカル起動

[English](README.md)

`web/` が公開ページ、`worker.mjs` がページ配信と受付APIの共通入口です。ローカル起動とSites向けビルドは同じ処理を使います。アプリのEHPKとは別にビルドします。

## 表示言語とリンク

アプリと同じ9言語に対応します。`/` の初期表示は英語で、`/en/` も使えます。言語メニューには各言語の自称と通常リンクを使い、どの言語もJavaScriptなしで翻訳済みHTMLが開きます。トップページの **日本語** の直接リンクも維持します。

| コード | メニュー表示 | 直接開くパス |
| --- | --- | --- |
| `en` | English | `/`（`/en/` も可） |
| `zh-Hans` | 简体中文 | `/zh-Hans/` |
| `zh-Hant` | 繁體中文 | `/zh-Hant/` |
| `ja` | 日本語 | `/ja/` |
| `es` | Español | `/es/` |
| `fr` | Français | `/fr/` |
| `de` | Deutsch | `/de/` |
| `it` | Italiano | `/it/` |
| `ko` | 한국어 | `/ko/` |

JavaScriptが動く場合は、同じページ内で言語を切り替えて入力を保ちます。動かない場合はリンク先へ通常遷移します。有効な `?lang=<コード>` はパスより優先され、従来の `?lang=ja`・`?lang=en` も使えます。`#setup`・`#connection`・`#voice`・`#relay`・`#feedback` は共通です。例：`/ja/#connection`、`/zh-Hant/#voice`、`/fr/#feedback`。

同じページ内での切替時は、テーマ、中継・音声・画像の選択、手順、HUDの状態、フォームの入力と公開同意を保持します。URLへ書くのは言語のパスと既存アンカーだけです。下書き・接続設定・同意を保存したりURLへ入れたりしません。翻訳の読み込みは同じサイトのアセットだけを使い、言語変更によるフォーム送信や外部サービスへの通信は行いません。初期言語はURLで決まり、保存済みの言語設定による上書きはありません。

| ファイル | 役割 |
| --- | --- |
| `web/index.html` | 英語の初期本文と明示的な翻訳対象 |
| `web/app.js` | 全言語で共有する操作・手順・依頼文・フォーム処理 |
| `web/i18n.js` | 辞書の非同期読み込み、文言取得、翻訳対象・資料リンクの切替 |
| `web/language.js` | ブラウザーとWorkerで共有する9言語の表示名・URL・ページ判定 |
| `web/messages.js` | 英語をキーとする日本語の翻訳 |
| `web/locales/<コード>.js` | 中国語・スペイン語・フランス語・ドイツ語・イタリア語・韓国語の全辞書 |
| `web/style.css` | 両テーマ・画面幅に共通のスタイル |
| `localized-html.mjs` | 同じHTML原本から各言語の配信用HTMLを生成 |
| `routes.test.mjs` | 言語契約・辞書・翻訳済みHTML・経路とキャッシュの互換性 |

`messageFor(key, code)` の使用や辞書の切替前に、`await prepareLocale(code)` を呼びます。操作側は共通の `setLocale`・`getLocale`・`t` を使います。英語以外の辞書は `messages.js` の全キー（現在504項目）を揃え、ARIA・画面例・エラー・AI依頼文も翻訳します。`{0}` 等の番号やAPI識別子を保持し、仕様のJSONを置換対象にしません。スペース作成の依頼文では、選択言語で内容を作るよう指定します。

`data-i18n` はテキストだけの要素に付けます。子要素がある場合はビルドで検出します。利用者の入力は翻訳しません。日本語資料があるGitHubリンクだけを `i18n.js` の一覧で `.ja.md` へ切り替え、他言語と日本語版がない資料は英語canonicalの `.md` を使います。各言語のHTMLは同じ原本からビルド時に生成し、別々に管理しません。

基幹の技術資料：[中継の設定](https://github.com/3mintimer/muse-relay/blob/main/docs/relay-setup.ja.md)・[プロトコル](https://github.com/3mintimer/muse-relay/blob/main/docs/protocol.ja.md)。

方式選択後の「Museに設定を頼む」から、すぐに依頼文をコピーできます。全文・API契約・参考実装は既定で閉じ、コピーできなかった場合だけ全文を開いて選択します。`/ja/#g2muse`・`/#g2muse` はGist方式と既存G2Muse用の依頼を選びます。他方式では再利用リンクを隠します。再利用の依頼は、今の書き込み処理・設定・従来ファイルを保持し、確認済みの依頼とその所有添付だけを整理する内容です。

初回確認は、使用する中継の保存・テキストの対応返信・音声の文字起こしと返信・モバイル回線の4項目です。切り分け・音声経路・画像の条件は必要なときだけ開きます。ガイドから利用者の中継へ接続したり、Museへ依頼を自動送信したりしません。

ブラウザーの確認には合成の下書きを使い、言語を往復してテーマ・選択・入力・同意を保持することを点検します。設定からコピー、G2Muse再利用の直リンク、狭い画面、翻訳されたエラーを代表例で確認します。フォーム表示はローカルの応答を使い、本番へテスト送信しません。ブラウザーのレイアウトと実機の動作確認は分けます。

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
| `/`・`/en/`・各 `/<コード>/`・従来の言語クエリ | 翻訳済みHTML、Content-Language、言語別ETag。GET / HEAD |
| `/ja`・`/ja/index.html`・`/index.html?lang=ja` | 既存の日本語リンクも維持 |
| 公開ファイル | GET / HEAD。ETagによる304応答 |
| 存在しないパス | 404 |
| 対応しないメソッド | 405、Allowヘッダー |
| `/api/feedback` | 既存の `handleFeedback` へ接続。POSTのみ |
| CSP | script / style / connectを同じOriginに限定。iframe埋込不可 |
| その他 | `Referrer-Policy: no-referrer`、`nosniff`、入力値のログなし |

経路テストは4件です。9言語のURLとアプリの言語コード、辞書の全キーと番号付き変数、JavaScriptなしの翻訳済みHTML、従来リンクと条件付き取得を確認します。アプリのリポジトリ内では `../src/core/i18n.ts` と照合し、独立したSites checkoutではアプリ側ソースを必要としません。既存の受付テストは別に実行します。

## 独立したSites checkout

Sitesの作成・同期・配備は保守担当者が行います。この公開ソースに特定のSite IDは含めません。

1. 登録済みSiteのcheckoutへ、この `guide/` の内容を置きます。checkoutの `.openai/hosting.json` は維持します。
2. manifestはWorker形式（`static` を指定しない）とし、D1 bindingを `DB` にします。未使用のR2は `null` です。
3. `FEEDBACK_RATE_SECRET` をSitesのsecretへ設定します。ランダムな32文字以上で、ブラウザー・ソース・ビルド出力へ入れません。
4. checkout内で `npm ci` → `npm test` → `npm run build`。成果物をSitesの通常手順で配備します。

ビルドは実行ディレクトリの `.openai/hosting.json` を優先し、次にビルドスクリプトと同じディレクトリのmanifestを探します。どちらもなければ `hosting.example.json` の `{d1:"DB",r2:null}` を使います。既存の `project_id` などのフィールドは保持します。例だけの成果物にはSite IDがないため、そのまま本番配備しません。

スキーマを変更する場合は `npm --prefix guide run db:generate` でmigrationを追加します。適用済みmigrationを書き換えず、schema-onlyに保ちます。Sitesは `dist/.openai/drizzle/` のmigrationを配備時に適用します。

受付の制限・同意・保管・削除・本番の動作確認票については、リポジトリの [docs/feedback.md](https://github.com/3mintimer/muse-relay/blob/main/docs/feedback.md) を参照してください。
