# 公開ソースの書き出しと再現

公開対象は、共通アプリ、参考中継、ATOM S3、ガイド、ダミーデータだけのテスト、ライセンスとコミュニティ設定です。範囲は [PUBLIC-SOURCE.md](../PUBLIC-SOURCE.md)、ファイル単位の許可リストは [public-source-files.json](../scripts/public-source-files.json) にあります。

## ソースを書き出す

Node.js 24 と npm を使用します。開発ディレクトリを丸ごとコピーせず、ルートで次を実行します。

```sh
node scripts/export-public.mjs --check
node scripts/export-public.mjs --out ../muse-relay-public
```

出力先の親ディレクトリは事前に用意します。出力先は未作成か、空の通常ディレクトリである必要があります。既存ファイルがある場所やシンボリックリンクには書き込みません。失敗した出力を再利用する場合も、内容を確認して別の空ディレクトリを指定してください。

| 処理 | 内容 |
| --- | --- |
| 選択 | 許可リストのファイルだけを読み取る。Git の追跡状態・履歴・未追跡ファイルを自動で取り込まない |
| 監査 | 秘密値の典型パターン、個人の絶対パス、未承認のホスト、画像メタデータ、例の認証値を確認 |
| リンク | 書き出し対象内の Markdown / HTML の相対リンク・アンカーを確認。外部サービスの稼働確認とは別 |
| 書き出し | 元ファイルを変更せず、ファイルごとに新規作成。履歴・Git 設定・開発記録・個人設定を含めない |
| ハッシュ | `PUBLIC-SOURCE-MANIFEST.json` に相対パスと SHA-256 を保存。端末名・ユーザー名・ローカルパスを記録しない |

検出時はファイル名と分類だけを表示します。未知のホストや追加ファイルを無条件に許可せず、公開してよい内容か確認してから許可リストを更新してください。自動検査だけで個人情報の不在を保証するものではありません。

## 書き出したソースをビルドする

出力先で実行します。依存関係は各ロックファイルから導入します。

```sh
npm ci
npm test
npm run build
npm run pack
```

| コマンド | 出力・確認 |
| --- | --- |
| `npm test` | アプリ状態・操作・画像・中継の既存テスト。実アカウントや実機へ送信しない |
| `npm run build` | TypeScript 検査と Vite ビルド。`dist/` を生成 |
| `npm run pack` | `app.json` のバージョンを使い `artifacts/muse-relay-<version>.ehpk` を生成 |
| `npm run dev` | 通常ブラウザーで設定と画面を確認 |

ビルドで作られる依存関係・キャッシュ・成果物は公開ソースの許可リストに含みません。最終公開用ディレクトリは、確認後に改めて空の場所へ書き出せます。出力バイナリのバイト単位一致を保証する構成ではありません。

## 任意の構成

| 対象 | 手順 |
| --- | --- |
| Node 中継 | `npm run relay:setup`、`npm run relay:start`。[HTTPS 配備](server.md) |
| Cloudflare Worker | `npm --prefix server/cloudflare ci`、`npm --prefix server/cloudflare run build`。[D1・R2 の設定](../server/cloudflare/README.md) |
| Gist watcher | 自分の環境変数とハンドラーを設定。[入力形式と起動方法](../adapters/gist/README.md) |
| ATOM S3 | ESP-IDF 6.0.3 を準備し `firmware/tools/build.sh`、`python3 firmware/tools/package.py`。[ビルド・USB 設定](atoms3.md) |
| 公開ガイド | [guide/README.md](../guide/README.md) のビルド・開発手順。ホスティングとフィードバック保存先は別途用意 |

同じアプリで任意の中継を使うには [protocol.md](protocol.md) の入出力に合わせます。SDK・サーバー・アカウント・キーは利用者ごとの設定です。ハードウェアの書き込みや外部サービスへの配備は、ソースの書き出しとは別操作です。

## 確認範囲

[CI](../.github/workflows/check.yml) はアプリ・参考中継のテスト、EHPK の作成、ガイドの受付テストとビルドを実行します。

| 構成 | 確認した範囲 |
| --- | --- |
| HTTPS 中継 ＋ 自宅の ATOM S3 | ペアリングした実機から同じ Muse チャットにテキストを続けて送り、それぞれに対応する返信を取得。合成音声の WAV でも元の依頼に対応する返信を取得 |
| Gist | 参考 watcher が依頼を読み、ハンドラーの結果を返す処理を合成データで確認。各自が接続する Muse ハンドラーは、自分の Gist で往復を確認 |
| HTTPS 中継 ＋ Linux | 公式 SDK の専用チャット送信と返信取得を仕様で確認。Linux 機と G2 を通した往復は未検証。[Linux SDK](https://github.com/facebookincubator/muse-gadget-sdk/tree/main/linux) |

自作の中継では、G2 から短いメッセージを送り、元の依頼 ID に対応する Muse の返信がアプリに戻るところまで確認します。外出時の運用はスマートフォンをモバイル回線に切り替えて試します。

公開リポジトリは [3mintimer/muse-relay](https://github.com/3mintimer/muse-relay) です。書き出しスクリプトは Git 初期化・認証・コミット・push・配備を行いません。[LICENSE](../LICENSE)、[NOTICE.md](../NOTICE.md)、SDK 由来の表示を維持してください。
