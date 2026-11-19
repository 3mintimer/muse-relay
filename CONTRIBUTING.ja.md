# 参加方法

[English](CONTRIBUTING.md) · [日本語](CONTRIBUTING.ja.md)

コードを書かなくても、使いたい場面・困った操作・説明が足りない箇所を送れます。日本語・英語のどちらでも構いません。

| したいこと | 入口 |
|---|---|
| GitHub登録なしで要望・質問を送る | [ガイドの非公開受付](https://muse-relay-guide.spicy-cup-4319.chatgpt.site/ja/#feedback) |
| 公開で質問・不具合・改善案を扱う | [GitHubのIssueフォーム](https://github.com/3mintimer/muse-relay/issues/new/choose) |
| 既存の要望を探す | [Issues](https://github.com/3mintimer/muse-relay/issues) |
| コードや資料を改善する | 関連Issueを確認し、変更を小さくまとめてPull Requestを作る |

非公開受付には連絡先を求めません。公開への同意がある場合だけ、保守担当者が本人を特定する情報を除いて要約し、Issueへ登録します。受付番号は控えてください。フォームから個別返信・進捗照会はできません。[データの扱いと受付票の管理](docs/feedback.ja.md)

## 変更を送る

1. 大きな仕様変更は先にIssueへ、直したい操作と期待する結果を書きます。小さな誤字・明確な修正は直接PRでも構いません。
2. 自分のforkで変更します。トークン、個人の接続設定、Gistデータ、会話、音声、アバター、`.local/`、ビルド成果物を含めません。
3. アプリ変更のPRは `beta`、資料・公開ガイドだけの変更は `main` を対象にします。配布区分と正式版の判断は[リリース手順](docs/releases.ja.md)を参照してください。
4. 変更した範囲の確認を実行し、PRに実施結果と未確認点を書きます。

```sh
npm ci
npm run build
```

| 変更箇所 | 関連する確認 |
|---|---|
| アプリの処理・G2操作 | `npx tsx --test tests/core.test.ts tests/navigation.test.ts tests/images.test.ts` から関連するもの |
| 母艦端末の UI | ビルド後に Chrome で `node --test tests/phone-ui.test.mjs` を実行し、タッチスクロールと保存を確認 |
| Node中継 | `node --test tests/server.test.mjs` |
| Worker中継 | `node --test server/cloudflare/worker.test.mjs` |
| Gist watcher | `node --test adapters/gist/watcher.test.mjs` |
| ガイドの受付API | `node --test guide/feedback.test.mjs` |
| 文章だけ | リンク・手順・画面との一致を確認 |

テストは不具合の再現や公開契約の確認に絞ります。実機が必要な変更は、Simulatorや合成入力の確認を実機の結果と区別してください。実機を持っていない場合は、その旨を書けば構いません。

### 母艦端末のスクロール確認

- Even アプリで変更した画面を開き、上下にスワイプして先頭と末尾を往復します。末尾の操作ボタンが下部メニューに隠れず、タップできることを確認します。チャットでは、長い履歴の最古のメッセージから入力欄まで戻れることも確認します。
- 入力欄がある画面では、キーボードを開いたまま同じ操作を繰り返します。設定では、接続情報の入力欄から末尾まで移動して戻り、「設定を保存」をタップします。受信更新が重なっても保存でき、開き直して変更が残ることを確認します。
- 「頭上げ表示」の角度計では、図の背景を縦にスワイプすると角度を保ったままページが動き、丸いつまみをドラッグすると角度が変わることを確認します。

## 保守の流れ

```mermaid
flowchart LR
  A[要望・質問] --> B[重複と再現条件を確認]
  B --> C[Issueに目的と受入条件]
  C --> D[小さなPR]
  D --> E[関連する確認とレビュー]
  E --> F[利用者向け手順を更新]
  F --> G[Issueへ結果・未確認点]
```

保守担当者はIssueに対象範囲・次の確認・保留理由を残します。採用や対応時期は約束しません。PRのマージとEvenHubへの配布は別の操作で、配布先と対象ビルドを確認してから実施します。受付の本文や個人情報をPR・テスト・サンプルへ転記しません。
