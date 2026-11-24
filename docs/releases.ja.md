# リリース運用

[English](releases.md) · 日本語

| 更新内容 | 反映先 | 配布 |
| --- | --- | --- |
| 試験中のアプリ | GitHub の `beta` | Even Hub Beta と `vX.Y.Z-beta.1` の GitHub Pre-release |
| Even Hub ストアで一般公開したアプリ | GitHub の `main` | `vX.Y.Z` の GitHub Release と同一の EHPK |
| ガイド、翻訳、投稿フォーム、運用ファイル | GitHub の `main` | アプリの公開を待たず更新 |

Muse Relay 0.4.1 は Even Hub で一般公開されています。GitHub の正式版タグは、その版のアプリをビルドしたコミットを指します。公開後もガイドなどの更新で `main` が進むことがあります。[Even Hub の掲載ページ](https://hub.evenrealities.com/catalogue/com.threemintimer.muserelay) · [GitHub Releases](https://github.com/3mintimer/muse-relay/releases)

### 0.4.0 返信候補の本人用Private

1. 本人用中継を従来のURLに候補オフで配備し、0.3.36から自由入力でMuseと一往復する。その後、中継でVMの候補投稿を有効にする。
2. 検査済みのEHPKを `preview build` でPrivate登録する。本人のG2で「毎回候補を依頼」を選び、回答から2回続けて候補で返信する。選んだ発言がスマホ履歴に各1件なら実機確認は完了。操作感を確認してから、Beta配布とGist・Gadget・カスタムHTTPS別の更新案内に進む。

問題が出たら中継の `REPLY_SUGGESTIONS_WRITER_SHA256` を外して同じ版を再配備する。既存URLと履歴で通常の会話を続けられる。

### Beta を作る

`npm run pack` は、全言語のコンテクストメニューを操作ごとの確認済み訳と照合し、SDK の上限（UTF-8 で32バイト）と表示幅を検査します。文言を変えるときは、その画面で操作の意味が伝わることを確認してから `tests/context-menu.test.ts` を更新します。検査を通ったソースをビルドしてパッケージを作成します。

1. アプリ変更の PR は `beta`、資料や運用の PR は `main` へ送ります。候補を作る前に `main` の更新を `beta` へ統合します。個人の作業場所からは[許可リストで書き出し](public-source.ja.md)、公開リポジトリの最新の履歴に変更を重ねます。第三者の PR を上書きしないよう差分を確認します。
2. 未使用のバージョンを `app.json`、`package.json`、ルートの lockfile に設定します。`changelog/X.Y.Z.md` に英語の変更点と任意の日本語訳を書き、`beta` に push します。
3. **Check** の成功後、対象 SHA の成果物 `muse-relay-ehpk-<コミットSHA>` を取得します。中の EHPK を Even Hub へアップロードして Beta に割り当てます。ダウンロードとアップロードのコマンドは[英語版](releases.md)にあります。
4. 認証済みの `gh` と Even Hub CLI がある手元の環境で次を実行します。`npm ci` でこのプロジェクトの CLI を導入できます。

```sh
node scripts/record-release.mjs --channel beta --commit COMMIT_SHA
node scripts/record-release.mjs --channel beta --commit COMMIT_SHA --publish
```

1行目は照合だけです。2行目は、Even Hub から取得した実物と CI の EHPK が一致した場合に GitHub Pre-release を作ります。`--commit` 省略時は公開 `beta` の先頭を使います。CI 成果物の保存期限が切れた場合は同じコミットの **Check** を再実行します。

### 一般公開版を記録する

Even Hub ポータルの **Public build** で **Published**、CLI で `public` の割り当てを確認します。Beta 終了後に CLI の状態が **Approved** と表示される場合は、一般向けカタログのパッケージ ID、公開チャンネル、版、サイズ、作成日時も照合します。

同じ確認・公開コマンドに `--channel public` と対象のコミットを指定します。正式版の案内は手元の `changelog/X.Y.Z.md` に記載します。Beta の案内には候補コミットの文面を使います。GitHub に添付するのはストアから取得した EHPK です。0.4.1 では CI 版とストア版で本体 198,226 バイトが一致し、パッケージ ID を含むヘッダーと末尾 64 バイトが異なります。[照合済みの SHA-256](../changelog/0.4.1.store.json) で両ファイルの全体をビルド 158450 とソースコミットに対応付けています。未確認の差分があれば処理は停止します。

照合後に `main` を早送りし、正式版タグと Release を作成します。`main` が資料更新だけ先行している場合も CI の EHPK を候補と照合します。履歴が分岐していれば、`main` の更新を候補へ取り込み、そのコミットを再確認します。既存タグや添付内容が競合する場合は停止します。

旧ビルドの削除は別操作です。新しいチャンネルを実地で確認し、対象バージョンとビルド ID を選びます。審査中や配布中のビルドを残します。
