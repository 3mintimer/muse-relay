# リリース運用

[English](releases.md) · 日本語

| 更新内容 | 反映先 | 配布 |
| --- | --- | --- |
| 試験中のアプリ | GitHub の `beta` | Even Hub Beta と `vX.Y.Z-beta.1` の GitHub Pre-release |
| Even Hub ストアで一般公開したアプリ | GitHub の `main` | `vX.Y.Z` の GitHub Release と同一の EHPK |
| ガイド、翻訳、投稿フォーム、運用ファイル | GitHub の `main` | アプリの公開を待たず更新 |

最初のストア一般公開までは、`main` のアプリは公開ソースの初期版 v0.3.5 Beta です。一般公開後もガイドだけの更新で `main` が進むことがあります。ストアと対応する正確なコミットは正式版タグから参照できます。

### Beta を作る

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

Even Hub ポータルで一般公開が完了したら、同じコマンドの `--channel` を `public` にします。ビルドの **Published**、**public** チャンネル、EHPK の一致を確認したうえで、`main` を早送りし、正式版タグと Release を作成します。審査中または承認のみの段階では実行できません。

`main` が資料更新だけ先行している場合も EHPK を照合します。履歴が分岐していれば、`main` の更新を候補へ取り込み、そのコミットを再確認します。既存タグを動かしたり、別内容の添付を上書きしたりする操作はありません。

旧ビルドの削除は別操作です。新しいチャンネルを実地で確認し、対象バージョンとビルド ID を選びます。審査中や配布中のビルドを残します。
