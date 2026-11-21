# AtomS3 と AtomS3 Lite の中継

[English](atoms3.md) · [日本語](atoms3.ja.md)

Muse Relay は、全ユーザーが同じビルドを使い、接続先を設定する共通の EvenHub
アプリです。各ユーザーが自分の中継環境を用意するか、Muse にその構築を依頼します。
公開用のアプリに、特定の利用者のサーバー・ネットワーク・資格情報は含めません。

Muse Gadget SDK を使う参考ファームウェアの対象は、AtomS3（C123）と AtomS3 Lite（C124）です。
同じ通信契約を実装した中継環境も、共通アプリから利用できます。

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

両モデルは 8 MB フラッシュ・PSRAM なしです。この実装は SDK の Wi-Fi、BLE ペアリング、
Noise 接続を使い、音声・画像・操作はスマートフォンや G2 側で扱います。Lite 用ビルドは
内蔵 RGB LED で状態を表示します。
[AtomS3 の仕様](https://docs.m5stack.com/ja/core/AtomS3) · [AtomS3 Lite の仕様](https://docs.m5stack.com/ja/core/AtomS3-Lite)

## 準備

- AtomS3 または AtomS3 Lite、データ通信可能な USB ケーブル、安定した USB 電源。
- 2.4 GHz Wi-Fi。Muse アプリでペアリング時に設定します。
- [Muse Gadget SDK トークン](https://gadgets.muse.ai/settings/sdk-tokens)。
  利用前に同サイトの [SDK Terms](https://gadgets.muse.ai/sdk-terms) を確認します。
- [Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk) が対応する
  ESP-IDF **6.0.3**、Python 3.10 以上、CMake、Ninja。
- Muse Relay の中継サーバー。家庭外から届く HTTPS の URL と、アプリ用とは別の
  機器用トークンを用意します。ルーターの ATOM 向けポート開放は不要です。

## ビルド

プロジェクトのルートで ESP-IDF を有効にします。

```sh
. /path/to/esp-idf-v6.0.3/export.sh
```

機種に合うコマンドでビルドと梱包を行います。

| 機種 | ビルド | 梱包 | ZIP |
| --- | --- | --- | --- |
| AtomS3（C123） | `firmware/tools/build.sh` | `python3 firmware/tools/package.py` | `firmware/build-atoms3/muse-relay-atoms3-0.1.7.zip` |
| AtomS3 Lite（C124） | `firmware/tools/build.sh atoms3-lite` | `python3 firmware/tools/package.py --build-dir firmware/build-atoms3-lite` | `firmware/build-atoms3-lite/muse-relay-atoms3-lite-0.1.7.zip` |

SDK の取得先は `.local/hardware/muse-gadget-sdk` です。別の場所を使う場合は
`MUSE_SDK_CHECKOUT` を指定します。使用する SDK は
`c3d58c66a02bfea44847e0345714507166656bed` に固定しています。
ZIP には各バイナリー、初回用の `flash_args`、アプリのみを更新する `flash_app_args`、
ライセンスと SHA-256 一覧が入ります。

ビルド時の SDK 設定には利用者のトークンを入れません。トークンと URL は USB から
後で機器に保存します。`firmware/sdkconfig.local` は任意の開発用上書きで、Git の
対象外です。通常は作成不要です。HTTPS 証明書の検証を無効にしないでください。
HTTP は `CONFIG_MUSE_RELAY_ALLOW_HTTP=y` の明示的なローカル試験設定でのみ使えます。

## 初回の書き込み

初回の導入や、異なるパーティション配置のファームウェアからの移行では `flash_args` を使います。
書き込む前に全フラッシュをローカルへ保存します。バックアップには資格情報が含まれる可能性があります。

1. ATOM S3 側面のリセットボタンを約 2 秒以上押し、ダウンロードモードにします。
   `/dev/cu.usbmodem*`（macOS）または `/dev/ttyACM*`（Linux）を確認します。
2. 接続先を確認します。

   ```sh
   python -m esptool --port /dev/cu.usbmodemXXXX chip-id
   python -m esptool --port /dev/cu.usbmodemXXXX flash-id
   ```

3. バックアップ後に、機種に合う ZIP を展開したディレクトリから書き込みます。

   ```sh
   python -m esptool --chip esp32s3 --port /dev/cu.usbmodemXXXX --baud 460800 \
       --before no-reset --after hard-reset write-flash @flash_args
   ```

全フラッシュ消去は行いません。Secure Boot、フラッシュ暗号化、eFuse 書き込みは
有効にしません。SDK の公開された開発署名鍵を使うビルドです。
書き込み後も `waiting for download` のままなら、ボタンを押さずに USB 電源を
入れ直します。緑 LED を点ける長押しはダウンロードモードへの操作です。

## 設定を引き継ぐ更新

同じパーティション配置の `muse-relay` からは、アプリだけを更新できます。USB で通常起動し、
115200 baud の起動ログで `Project name: muse-relay` と
`Loaded app from partition at offset 0x20000` を確認します。確認後はシリアルモニターを閉じます。
Wi-Fi、Muse のペアリングと SDK トークン、中継設定は `0x11000` の NVS に保存されています。

機種に合う ZIP を展開したディレクトリで実行します。`port` は実際の USB ポートに置き換えます。
全フラッシュは展開先と同じ階層にある非公開のフォルダーへ保存されます。バックアップのサイズ、
パーティション表、アプリ書き込み引数の照合に失敗すると停止します。自動切り替えが効かない場合は、側面ボタンで
ダウンロードモードに入り、`enter_download=no-reset` に変更して実行し直します。
[ESP32-S3 のダウンロードモード](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/advanced-topics/boot-mode-selection.html)

```sh
(
    set -eu
    port=/dev/cu.usbmodemXXXX
    enter_download=usb-reset
    flash() {
        reset_before=$1
        reset_after=$2
        shift 2
        python -m esptool --chip esp32s3 --port "$port" --baud 460800 \
            --before "$reset_before" --after "$reset_after" "$@"
    }
    umask 077
    backup=$(mktemp -d "$PWD/../muse-relay-before.XXXXXX")
    printf 'バックアップ先 %s\n' "$backup"
    flash "$enter_download" no-reset-stub read-flash 0x0 0x800000 "$backup/flash.bin"
    test "$(wc -c < "$backup/flash.bin")" -eq 8388608
    dd if="$backup/flash.bin" bs=1024 skip=64 count=3 2>/dev/null | cmp - partition-table.bin
    test "$(cat flash_app_args)" = "$(printf '%s\n' \
        '--flash-mode dio --flash-freq 80m --flash-size keep' '0x20000 muse-relay.bin')"
    dd if="$backup/flash.bin" of="$backup/nvs.bin" bs=4096 skip=17 count=6
    flash no-reset no-reset-stub write-flash @flash_app_args
    flash no-reset no-reset-stub verify-flash 0x11000 "$backup/nvs.bin"
    flash no-reset hard-reset flash-id
)
```

再起動後は新しいバージョンを確認します。`>relay_status` で中継設定の読み込みと Muse 接続を確認し、
短い依頼を送って返信を受け取ります。バックアップは手元で保管してください。

## 中継サーバーからの FW 更新

初回、または OTA 非対応版からの移行は上記の USB 手順で 0.1.7 を導入します。既に 0.1.4 以降の OTA 対応版なら、中継経由で更新できます。対応する HTTPS 中継は待機中の端末に次の版を配布できます。従来のジョブ API だけを持つ中継でも、これまでどおり会話できます。

端末はジョブ取得時に `X-Muse-Target` と `X-Muse-Version` を送ります。対象機種は `muse-relay/atoms3/8m-ab-v1` または `muse-relay/atoms3-lite/8m-ab-v1` です。管理者が配布を指定した場合、中継は `"job": null` の応答に `firmware` を追加し、対象の `target`、3つの整数をドットで結んだ版の文字列 `version`、バイト数 `size`、小文字の `sha256`、1以上の整数 `generation` を返します。ZIP 内の署名付き `muse-relay.bin` を、同じ中継の `GET /device/firmware/{sha256}` から端末認証付きで配信し、正確な Content-Length を返してください。

端末は非稼働スロットに書き込み、ハッシュ・署名・機種・プロジェクト・版を照合します。再起動後は5分以内に Muse 接続と中継ジョブ取得が成功すると新版が確定し、失敗時は旧版に戻ります。`POST /device/firmware/status` は試行識別子 `attempt`（ハッシュ.世代）、実行版 `version`、スロット `slot` と状態 `status`（検証中 `verifying`、確定 `confirmed`、旧版稼働 `previous_running`）を伝えます。転送失敗の原因を解消して同じ版を再配布するときは世代を増やします。USB 復旧では実際の起動スロットとパーティション表を必ず確認してください。ZIP のアプリ専用書き込み先は ota_0 起動時の値です。

### 参考中継で 0.1.7 を配る

Node.js 版と Cloudflare Workers 版は、運用者が選んだ1機種分のアプリを配信できます。各中継は1台の ATOM 用です。機種別 ZIP をリリースの `SHA256SUMS` と照合してから展開します。ZIP 内の `SHA256SUMS` の `muse-relay.bin` 行から SHA-256 を取得してください。

1. `FIRMWARE_IMAGE` に展開した `muse-relay.bin` のパス、`FIRMWARE_SHA256` に上記のハッシュ、`FIRMWARE_GENERATION` に `1` を指定します。Node では起動環境、Worker では **ビルド環境** に設定します。Docker 利用時はバイナリを読み取り専用でマウントし、コンテナ内のパスと環境変数を渡します。
2. `FIRMWARE_OFFER=false` で起動またはビルド・配備し、端末トークンで `GET /device/firmware/{sha256}` を取得してサイズとハッシュを照合します。
3. 同じイメージで `FIRMWARE_OFFER=true` に変更して再起動または再ビルド・配備します。待機中で機種が一致する旧版端末に指示が届きます。`GET /device/firmware/status` で試行識別子、版、スロット、`confirmed` を確認します。

## USB を使わない診断と復旧

0.1.7 の端末は、Wi-Fi が使える間、会話のジョブ取得と独立して約60秒ごと、または状態変化時に診断を中継へ送ります。旧版の端末も通常の会話を続けられます。公開用の中継を自分で設置し、次の手順で管理画面を有効にしてください。

1. この端末専用の管理者トークンを生成します。下のコマンドはローカルにトークンを保存し、設定用のハッシュを表示します。既存ファイルがある場合はハッシュの計算だけを行います。

   ```sh
   mkdir -p .local
   (umask 077; set -C; openssl rand -hex 32 > .local/maintenance-token)
   tr -d '[:space:]' < .local/maintenance-token | openssl dgst -sha256
   ```

2. ハッシュの64桁の16進数を Node の環境変数または Worker のランタイムシークレット `RECOVERY_ADMIN_SHA256` に設定します。管理者にはアプリ・端末・Muse と異なるトークンを使用します。
3. 自分の HTTPS 中継の `/maintenance` を開き、ローカルに保存したトークンを入力します。管理画面では診断の受信時刻、最後の正常なジョブ取得の推定時刻、Wi-Fi・Muse の状態、直近12件の履歴を確認できます。端末は履歴を間引いて不揮発領域に保存し、再接続後に送ります。直前の未保存分は給電断で失われることがあります。

| 管理画面での観測 | 対応 |
| --- | --- |
| 診断は届くが Muse が切断中 | 通常再接続を待つか「Muse に再接続」を選びます。Wi-Fi と診断通信が正常なら、120秒の猶予後に端末からも再接続を試みます。 |
| ジョブ取得だけが止まる | 通信エラーと処理状態を確認します。正常取得の実績がある起動で処理が約180秒進まない場合、端末は理由を記録して再起動します。 |
| 診断と取得時刻がともに古い | 中継の `/health`、現地の給電、Wi-Fi を確認します。端末が診断通信を再開すると、期限内の指示が届きます。 |

「端末を再起動」と「Muse に再接続」の指示は5分間有効です。端末は会話・OTA 中の操作を延期し、指示 ID を保存して再送時の二重実行を防ぎます。復旧後は短い依頼を送り、対応する Muse の返信を確認してください。

## AtomS3 Lite の状態 LED

| LED | 状態 |
| --- | --- |
| 赤点灯 | Wi-Fi 未接続、またはインターネットに到達できない |
| 橙点滅 | ネット接続あり、Muse に未接続・再接続中 |
| 緑点灯 | Muse に接続済み・待機中 |
| 青点滅 | 依頼の転送中、または Muse の応答待ち |
| 紫点灯 | Muse の返信を中継中 |

青は ATOM が中継から依頼を受け取ると点滅します。Wi-Fi 接続中に Muse が未接続のときや、中継との
通信に失敗したときは、SDK の TCP 到達確認を使います。HTTPS 中継との通信が成功した場合も、
ネットに到達できると判定します。

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

USB コンソールの `>relay_status` は `sdk_connected`、`configured`、`gateway_configured` と
LED の状態 `led_state` を返します。標準の AtomS3 用ビルドでは `led_state` は `off` です。

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
