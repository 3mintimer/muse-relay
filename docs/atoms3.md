# ATOM S3 の中継

Muse Relay は、全ユーザーが同じビルドを使い、接続先を設定する共通の EvenHub
アプリです。各ユーザーが自分の中継環境を用意するか、Muse にその構築を依頼します。
公開用のアプリに、特定の利用者のサーバー・ネットワーク・資格情報は含めません。

この文書は、Muse Gadget SDK を使う中継の参考実装として ATOM S3 を選んだ場合の
手順です。ATOM S3 は全ユーザーの必須機器ではありません。Gist 方式では不要で、
同じ通信契約を実装した別の中継環境も共通アプリから利用できます。

この参考構成では、家庭の Wi-Fi につないだ ATOM S3 を Muse Gadget
としてペアリングし、ユーザーが用意した HTTPS 中継サーバーから要求を取得します。
ATOM S3 をスマートフォンと持ち歩く必要はありません。

```text
Even G2 ⇄ Even アプリ内の Muse Relay
                  ⇅ HTTPS（アプリ用トークン）
            ユーザーの中継サーバー
                  ⇅ HTTPS（機器用トークン、ATOM から接続）
              家庭の ATOM S3
                  ⇅ Muse Gadget SDK の暗号化された接続
                 Muse
```

ATOM S3 の標準モデルは 8 MB フラッシュ・PSRAM なしです。この実装は SDK の
Wi-Fi、BLE ペアリング、Noise 接続を使用し、音声処理・画像表示・操作画面は
スマートフォン/G2 側に置きます。Atomic Voice Base は不要です。ATOM S3 の画面と
マイクは使用しません。SDK の汎用家庭内ネットワークトンネルは無効です。

## 準備

- ATOM S3、データ通信可能な USB ケーブル、安定した USB 電源。
- 2.4 GHz Wi-Fi。Muse アプリでペアリング時に設定します。
- [Muse Gadget SDK トークン](https://gadgets.muse.ai/settings/sdk-tokens)。
  利用前に同サイトの [SDK Terms](https://gadgets.muse.ai/sdk-terms) を確認します。
- [Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk) が対応する
  ESP-IDF **6.0.3**、Python 3.10 以上、CMake、Ninja。
- Muse Relay の中継サーバー。家庭外から届く HTTPS の URL と、アプリ用とは別の
  機器用トークンを用意します。ルーターの ATOM 向けポート開放は不要です。

## ビルド

プロジェクトのルートから実行します。

```sh
. /path/to/esp-idf-v6.0.3/export.sh
firmware/tools/build.sh
```

SDK の取得先は `.local/hardware/muse-gadget-sdk` です。別の場所を使う場合は
`MUSE_SDK_CHECKOUT` を指定します。使用する SDK は
`c3d58c66a02bfea44847e0345714507166656bed` に固定しています。
ビルド出力は `firmware/build-atoms3/` です。

配布用のフラッシュ一式は `python3 firmware/tools/package.py` で作成できます。
`firmware/build-atoms3/muse-relay-atoms3-0.1.0.zip` に各バイナリー、正しい書き込み
オフセットを持つ `flash_args`、SHA-256 一覧が入ります。SDK トークンを埋め込んだ
ビルドはパッケージ処理が拒否します。

ビルド時の SDK 設定には利用者のトークンを入れません。トークンと URL は USB から
後で機器に保存します。`firmware/sdkconfig.local` は任意の開発用上書きで、Git の
対象外です。通常は作成不要です。HTTPS 証明書の検証を無効にしないでください。
HTTP は `CONFIG_MUSE_RELAY_ALLOW_HTTP=y` の明示的なローカル試験設定でのみ使えます。

## 接続機器の確認と書き込み

既存ファームウェアのパーティション配置とこの構成の配置は異なる場合があります。
アプリだけを旧オフセットへ書かず、ビルドが生成した `flash_args` を使います。
既存ファームを復元する必要がある場合は、先に全フラッシュをローカルへ保存します。
バックアップには資格情報が含まれる可能性があるため、公開用成果物には含めません。

1. ATOM S3 側面のリセットボタンを約 2 秒以上押し、ダウンロードモードにします。
   `/dev/cu.usbmodem*`（macOS）または `/dev/ttyACM*`（Linux）を確認します。
2. 接続先を確認します。

   ```sh
   python -m esptool --port /dev/cu.usbmodemXXXX chip-id
   python -m esptool --port /dev/cu.usbmodemXXXX flash-id
   ```

3. 必要なバックアップ後に書き込みます。

   ```sh
   firmware/tools/flash.sh /dev/cu.usbmodemXXXX
   ```

全フラッシュ消去は行いません。Secure Boot、フラッシュ暗号化、eFuse 書き込みは
有効にしません。SDK の公開された開発署名鍵を使うビルドです。
書き込み後も `waiting for download` のままなら、ボタンを押さずに USB 電源を
入れ直します。緑 LED を点ける長押しはダウンロードモードへの操作です。

## トークンと接続設定

ローカルの USB 設定画面を使えます。プロジェクトのルートから起動します。

```sh
python3 -m http.server 8789 --bind 127.0.0.1 --directory firmware/setup
```

Chrome または Edge で `http://127.0.0.1:8789` を開き、「機器を選ぶ」から USB を
選択します。HTTPS URL・機器用トークン・SDK トークンを入力して「機器に保存」を
押します。サーバーの設定画面で書き出した機器用 JSON も読み込めます。このページは
入力値をブラウザーの保存領域へ保存せず、ネットワークへ送信しません。
SDK トークンの入力は初回・変更時だけ必要です。

ホスティング側に追加認証がある場合は「追加のサーバー認証」を開き、追加の
認証トークンも設定します。半角の印字可能文字で 1,024 文字まで受理します。
空欄では既存値を変更せず、「保存済みの追加認証を解除する」で削除できます。
中継 URL を切り替えるときは、その中継先に必要な追加認証も設定または解除します。

コマンドで設定する場合は次の手順です。

Python 環境に `pyserial` を追加したうえで、次のコマンドを実行します。入力した
トークンはターミナルに表示されず、引数や通常のログにも記録しません。

```sh
python firmware/tools/configure.py --port /dev/cu.usbmodemXXXX
python firmware/tools/configure.py --port /dev/cu.usbmodemXXXX --sdk-only
```

最初のコマンドは HTTPS URL・機器用トークン・任意の追加認証、次のコマンドは Muse SDK トークンを
設定します。設定値は機器の NVS に保存します。SDK トークン変更時は自動再起動、
中継設定だけを変更したときは USB 電源を入れ直します。

設定を自動化する場合は、公開対象外の JSON ファイルを `--settings-file` に渡せます。
キーは `relay_url`、`relay_token`（中継サーバーの `device_token` も受理）、任意の
`relay_gateway_token`（`gateway_token` も受理）、`sdk_token` です。
`relay_gateway_token` を空文字にすると追加認証を解除し、省略すると既存値を保ちます。
ファイルはアクセス権を
所有者だけに制限し、Git に追加しないでください。

## Muse とペアリング

Muse アプリの Settings → Devices で Developer mode を有効にし、Add Device から
`MuseGadget-XXXXXX` を選びます。家庭の Wi-Fi を指定し、確認を求められたら
ATOM S3 前面のボタンを短く押します。SDK トークンを変更した機器は再ペアリングが
必要です。前面ボタンの 5 秒長押しは、ペアリングと Wi-Fi 設定の初期化です。

USB コンソールの `>relay_status` は `sdk_connected`、`configured`、`gateway_configured` の真偽だけを
返します。SDK トークン・Wi-Fi パスワード・中継トークンは返しません。

## 通信の契約

機器は同じ機器用 Bearer トークンで次を利用します。
追加認証を設定した場合だけ、同じ中継サーバーへの要求に
`OAI-Sites-Authorization: Bearer <追加認証トークン>` も付けます。
機器用の `Authorization` は別に維持し、この追加ヘッダーは Muse SDK 側へ送りません。
リダイレクトは追跡しません。標準構成では追加認証は不要です。

| API | 内容 |
| --- | --- |
| `GET /device/jobs` | 次の要求。`job.id`、`job.request_bytes`、`job.session_id` を取得 |
| `GET /device/jobs/:id/request` | Muse の `/chat/stream` に渡す JSON 本文。`Content-Length` 必須 |
| `POST /device/events` | Muse の ACK、応答の断片、heartbeat、エラーを送信 |

POST イベントには `job_id`、`session_id`、再送時に変えない `event_id` を付けます。
`muse_ack` の `body` は ACK の JSON 文字列、`muse_event` の `body` は
機器が対象の要求へ絞ったイベントです。中継サーバーも同じ会話・メッセージ ID を
再照合します。`heartbeat` は応答待ち中 20 秒ごとに送信します。
サーバーが `{ "ok": true, "terminal": true }` を返すと購読を終了します。

中継サーバーごとに固定の `session_id` を持つ専用チャットで会話を継続します。
既存チャットは購読の成功を確認してから要求を送り、ACK に一致するユーザー行から
応答を受け取ります。別のユーザー行・親 ID・会話 ID は混ぜません。
初回の購読が 404 の場合だけ、送信でチャットを作り、会話 ID と `is_thread` を含む
ACK を確認してから再購読します。この場合は ACK イベントに
`subscription_fresh: true` を付けます。主チャットへ切り替える動作はしません。

本文は 1 KiB ずつ SDK へ送ります。本文上限は 2 MiB、ACK は 4 KiB、応答待ちは
120 秒です。受信バッファ不足や切断を成功として扱わず、エラーを返します。
要求を Muse に送った後に結果が不明になった場合、自動再実行しません。
ATOM S3 の可視テキストは、文字起こし・一つの応答それぞれ UTF-8 で 4 KiB までです。
これを超えると `muse_response_text_too_large` を返し、途中の内容を完了扱いにしません。
無関係な巨大な `approvals.snapshot` や履歴は全体を保存せず読み流します。
SDK のコールバックでは HTTP 通信や待機を行わず、対象の追加テキストを送信待ち領域で
まとめてから中継します。
画面なしの ATOM S3 は `CONFIG_MUSE_RELAY_COMPACT_NOISE` を使い、通常の 16 KiB
チャット断片を受け取れる 17 KiB の受信領域と、小さい送信領域を組み合わせます。
これを超える SDK フレームは `muse_response_frame_too_large` として報告します。
JSON 一行を中継サーバーで分割処理できることと、SDK フレームの受信上限は別です。
音声を HTTPS から読みながら SDK へ送る間の RAM を確保するため、Wi-Fi の固定受信
バッファは 8 個、TCP の送信領域と受信窓は公式の省メモリ構成と同じ 5,760 bytes に
制限します。SDK が要求する DMA と TLS の空き容量は変更しません。

## 機能と確認範囲

- テキストは SDK 内の `/chat/stream` と `/chat/subscribe` の方式を使用します。
- Muse 側で処理する音声は `audio/wav` のファイル添付です。16 kHz・モノラル WAV
  は SDK の実装と一致します。リアルタイム字幕はアプリ側の Soniox 経路です。
- 画像ファイルの本文は同じストリームで運べますが、Muse 側の画像入力の受理は
  SDK の音声例だけでは保証できません。中継サーバーで確認済みの場合に限り有効にします。
- Spaces を読むための専用 SDK API は確認できていません。アプリに登録した Space
  の読み出し指示を Muse に渡し、Muse が作成した連携処理から内容を返す方式です。
- ATOM S3 単体で常時インターネットの受信口を公開する仕組みではありません。
  ユーザーの HTTPS 中継サーバーと家庭の Wi-Fi・電源が必要です。

ファームウェアのコンパイル、USB 起動、Muse との通信、屋外回線からの往復は別々に
確認します。ローカルの模擬応答だけで実機接続済みとは扱いません。

SDK と、同 SDK から転用・改変した `chat_filter.c` / `chat_filter.h` は Apache-2.0、
Muse Relay のその他の新規コードはプロジェクトのライセンスに従います。
上流 SDK のアバターは別の権利条件のため、この画面なし構成では使用しません。
