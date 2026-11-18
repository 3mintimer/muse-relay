# ライセンスと参照元

Muse Relay の新規コードは [MIT](LICENSE) です。Even Realities、Meta、Soniox の公式製品ではありません。

| 対象 | 使用範囲 | ライセンス / 資料 |
| --- | --- | --- |
| Even Hub SDK | グラス・マイク・画像・端末ストレージ | [MIT / npm](https://www.npmjs.com/package/@evenrealities/even_hub_sdk)。写しは `public/licenses/even-hub-sdk.txt`、EHPKにも同梱 |
| Muse Gadget SDK | ATOM S3 の接続・ペアリング・暗号化通信 | [Apache-2.0 / source](https://github.com/facebookincubator/muse-gadget-sdk)。写しは `firmware/SDK-LICENSE` |
| G2Muse | Gist リレーの着想、公開メッセージ仕様の参照 | [公開資料](https://github.com/GenomiskDiagnostik/G2Muse)。コードの転載なし |
| EvenG2-Muse-Hub-M5 | SDK 中継方式を調べる際の参照 | [MIT / source](https://github.com/GOB52/EvenG2-Muse-Hub-M5)。コードの転載なし |
| Soniox | 任意のリアルタイム文字起こし API | [公式 WebSocket 仕様](https://docs.soniox.com/api-reference/stt/websocket-api) |

Muse Gadget SDK は指定した上流コミットをビルド時に取得します。
`firmware/components/muse_relay/chat_filter.c` と `chat_filter.h` は、同 SDK の
`esp32/components/muse_apps/muse_apps_chat.c` の逐次解析を転用・改変した Apache-2.0
コードです。Copyright (c) Meta Platforms, Inc. and affiliates. 出典コミットは
`c3d58c66a02bfea44847e0345714507166656bed` です。Muse Relay は会話・親 ID の解析、
要求との照合、上限付きの送信待ち領域を追加しています。MIT の新規コードとは区別します。
同 SDK の Jollybot アバターを、この画面なし ATOM S3 ビルドでは使用しません。
取得される依存ライブラリには各自のライセンスが適用されます。
Muse / Soniox / GitHub のアカウントや利用規約への同意は、各利用者が用意します。
