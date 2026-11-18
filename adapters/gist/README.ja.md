# Gist watcher

[English](README.md) · [日本語](README.ja.md)

Gistの新規依頼だけをユーザー指定のハンドラーへ渡す、任意の参考実装です。配布するEvenHubアプリとEHPKは全利用者共通で、Gist側の中継は利用者が実装するかMuseに依頼します。このwatcherを使わず、同じファイル入出力を実装しても接続できます。

Museとの会話・Whisper・スペースの作成は利用者またはMuseがハンドラーに実装します。このwatcherだけを起動してもMuseへの接続処理は完成しません。Gist ID・トークン・実行ファイルは利用者ごとの設定です。

[設定チュートリアルとMuse依頼文](../../docs/relay-setup.ja.md) / [ファイル入出力契約](../../docs/protocol.ja.md#gist方式)

```mermaid
flowchart LR
  Phone[Muse Relay] -->|依頼ごとのJSON + 添付| Gist[自分のGist]
  Watcher[watcher.mjs] -->|ETag付き確認| Gist
  Watcher -->|新規依頼だけ / stdin JSON| Handler[利用者・Museのハンドラー]
  Handler -->|stdout JSON| Watcher
  Watcher -->|返信とスペースを更新| Gist
  Gist -->|読取| Phone
```

## この参考実装を使う場合

| 準備 | 設定 |
|---|---|
| 新しいGist | `g2muse-relay.json` が存在しない場合だけ `{"messages":[]}` で作成 |
| 既存のG2Muse Gist | メッセージ・フィールド・ファイルを残し、再初期化しない。起動前に既存の書込処理を確認 |
| 秘密設定 | [.env.example](.env.example) を `.local/gist-watcher.env` へコピーして入力 |
| 処理先 | `MUSE_HANDLER` に実行ファイルの絶対パス |
| 引数 | `MUSE_HANDLER_ARGS` に文字列配列JSON |
| 起動 | 下記コマンド |

```sh
node --env-file=.local/gist-watcher.env adapters/gist/watcher.mjs
```

Node.js 22 以降。追加のnpm依存はありません。GitHubのトークンは環境変数で受け取り、コマンド引数・ログ・ハンドラーの環境へ渡しません。実行するハンドラーは自分が用意したものだけを指定します。共有する返信ファイルの書込担当は1つにし、既存G2Museの書込処理とこのwatcherを同時に動かしません。更新前の再読込とPATCHでは、同時更新のマージはできません。

## ハンドラーの入出力

標準入力に1つのJSONを渡します。シェルは経由しません。

```json
{
  "id": "r_example",
  "kind": "chat",
  "text": "内容を教えて",
  "created_at": 1794880000,
  "audio": {"mime":"audio/wav","name":"voice.wav","data_base64":"..."}
}
```

`audio` / `image` は該当する依頼だけにあります。スペース更新は `kind:"space"` と `space_id`。返信は標準出力へJSONだけを書き、終了コード0で終了します。

```json
{
  "text": "返信の本文",
  "transcript": "音声から文字起こしした本文",
  "image": {"mime":"image/png","name":"reply.png","data_base64":"..."},
  "spaces": [{
    "id":"news","title":"ニュース",
    "items":[{"id":"today","title":"今日","text":"表示用テキスト"}]
  }]
}
```

`text` は必須（画像・スペース・プロフィールがある場合は空文字可）。他の項目は任意です。音声を受けたハンドラーは文字起こしを `transcript` へ返します。Whisper等のモデルや実行方法はMuse側で用意します。参照watcherのスペース出力はテキストと操作部品です。`layout` と `control` を保持し、操作依頼の `space_action` を検証してハンドラーへ渡します。[部品と操作例](../../docs/spaces.ja.md)。画像カードを出す独自実装は [共通形式](../../docs/protocol.ja.md) に従います。

ホームのアバターには任意の `profile:{name?,avatar:{mime,name?,data_base64},updated_at?}` を返します。Museで設定済みの元画像を使い、PNG/JPEG/WebP・デコード後250,000バイト以下にします。watcherが `muse-relay-profile.json` と画像ファイルを出力します。通常の返信で `profile` を省略すれば維持、`profile:{}` で解除します。画像を特定できなければ別のアバターで代用しません。アプリの画像設定がオンのときにホームへ表示します。[プロフィールの契約](../../docs/protocol.ja.md#museのアバター--g2ホーム)

| アプリで選んだ設定 | ハンドラーへの実装指示 |
|---|---|
| Museで文字起こし | `audio`のWAVを処理し、`transcript`を返す。watcherが`from:"You"`として保存 |
| Soniox | `text`をそのまま使用。音声や再文字起こしを必須にしない |
| 画像オフ | テキスト返信とテキストカードを生成 |
| 画像オン | 返信の`image`は利用可。参考watcherの`spaces`は画像フィールドを出力しない |
| スペース | 安定したIDと順序、短い見出し、自己完結した本文。タップでページ送り、スワイプで項目切替、ダブルタップで戻るだけで読める内容 |

マイクの選択はアプリ側です。G2・スマートフォンのどちらでもハンドラーのWAV形式は同じです。スペースの更新結果は一覧全体を置き換えるため、残すスペースも含めます。閲覧に画像の有効化・音声入力・外部リンク・操作用Webページを要求しません。

## 処理の再開

```mermaid
stateDiagram-v2
  [*] --> claimed: 実行前に保存
  claimed --> handled: 結果を保存
  handled --> done: Gistへの反映
  claimed --> uncertain: 失敗・中断
  uncertain --> claimed: 利用者が確認して再実行
```

- `handled` のまま中断した場合は、要求と所有記録の一致を確認して保存済み結果を反映します。ハンドラーを再実行せず、PATCHの応答だけが失われた場合も反映済みの返信を確認します。
- 処理中のクラッシュや10分超過は結果不明です。Muse側を確認した後に限り、明示的に再実行します。
- 同じ状態ファイルに対してwatcherは1つ。別マシンで複数起動しません。`g2muse-relay.json` を別のプロセスが同時に更新する運用も対象外です。
- 完了した要求が再出現しても自動再実行しません。要求のダイジェスト・記録した返信・入力ファイルのハッシュが一致する場合だけ整理し、確認できなければ調査用に残します。証拠のない旧記録や、別IDで返信済みの要求も保護し、その1件で他の独立した要求を止めません。

```sh
node --env-file=.local/gist-watcher.env adapters/gist/watcher.mjs --retry r_example --once
```

## 保存・削除

| 対象 | 参照実装の方針 |
|---|---|
| 返信 | watcher所有のYou/Muse行を合計で直近50件保持。所有不明・既存の行と無関係なルートフィールドは残す |
| 処理済み依頼・入力添付 | 所有と内容を確認でき、参照のない入力だけを返信と同じPATCHで削除。変更済み・共有中の入力は残す |
| 出力画像・アバター | このwatcherが作成したと記録した内容一致のファイルだけを対象に、保持中のGist文書からの参照を確認して削除。ファイル名の接頭辞だけで所有と判断しない |
| ローカル所有記録 | 新しい行に `muse_relay_owner`、状態ファイルに行・添付のハッシュを保存。印のない旧行、変更済みの行、衝突した行を削除対象へ取り込まない |
| 重複処理記録 | 完了の詳細記録は、要求ファイル消失後かつ30日経過後に圧縮。要求IDとダイジェストの記録は状態ファイルを明示削除するまで残す |
| 元Gistの履歴 | GitHub側に残り得る。現在のファイル削除は履歴の消去ではない |

再起動・移動時には状態ファイルも維持してください。削除すると重複処理と所有の証拠が失われます。整理の参照確認に使う追加取得は1回につき最大4ファイル・読取合計12 MBまでとし、共有文書が取得不能・上限超過なら削除を保留して返信を反映します。別の履歴やスペースの参照も添付を保護するため、所有不明の行・ファイルは50行の上限を超えて残る場合があります。

Gistは暗号化された私設ストレージではありません。secret GistもURLを知る人は閲覧できます。入力・返信・音声・画像をGitHubへ置く方式を選ぶ際に確認してください。

未処理時の確認は通常のHTTP通信だけで、ハンドラーやAIを起動しません。最小10秒、初期15秒。GitHubのレート制限には待機時間を適用します。

[プロトコル全体](../../docs/protocol.ja.md) / [G2Muse元仕様](https://github.com/GenomiskDiagnostik/G2Muse/blob/main/g2muse-setup.md)
