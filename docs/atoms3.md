# ATOM S3 relay

[English](atoms3.md) · [日本語](atoms3.ja.md)

Muse Relay is a shared EvenHub app. Every user runs the same build and configures their own relay, either built themselves or set up by their Muse. The distributed app contains no user's server, network, or credentials.

This guide describes ATOM S3 as an optional Muse Gadget SDK reference relay. Gist does not require it; other relays implementing the same protocol can use the shared app.

In this reference configuration, an ATOM S3 paired as a Muse Gadget stays on home Wi-Fi and fetches requests from your HTTPS relay. You do not need to carry it with your phone.

```text
Even G2 ⇄ Muse Relay inside the Even app
                  ⇅ HTTPS (app token)
             Your relay server
                  ⇅ HTTPS (device token; ATOM initiates)
               ATOM S3 at home
                  ⇅ Encrypted Muse Gadget SDK connection
                 Muse
```

The standard ATOM S3 has 8 MB flash and no PSRAM. This implementation uses SDK Wi-Fi, BLE pairing, and the Noise connection. Audio processing, image display, and controls remain on the phone/G2. Atomic Voice Base is unnecessary. The ATOM S3 screen and microphone are unused. The SDK's general-purpose home-network tunnel is disabled.

## Requirements

- ATOM S3, a USB data cable, and stable USB power.
- 2.4 GHz Wi-Fi, configured during pairing in the Muse app.
- A [Muse Gadget SDK token](https://gadgets.muse.ai/settings/sdk-tokens). Review the site's [SDK Terms](https://gadgets.muse.ai/sdk-terms) before use.
- ESP-IDF **6.0.3**, Python 3.10 or later, CMake, and Ninja, as supported by the [Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk).
- Your Muse Relay server: an HTTPS URL reachable outside your home and a device token separate from the app token. No router port forwarding to ATOM is required.

## Build

Run from the project root:

```sh
. /path/to/esp-idf-v6.0.3/export.sh
firmware/tools/build.sh
```

The SDK checkout defaults to `.local/hardware/muse-gadget-sdk`; set `MUSE_SDK_CHECKOUT` to use another location. The pinned SDK commit is `c3d58c66a02bfea44847e0345714507166656bed`. Build output goes to `firmware/build-atoms3/`.

Run `python3 firmware/tools/package.py` to make a flash package. `firmware/build-atoms3/muse-relay-atoms3-0.1.0.zip` contains binaries, `flash_args` with the correct offsets, and SHA-256 checksums. Packaging rejects builds with an embedded SDK token.

Do not put personal tokens into build-time SDK settings. Save tokens and the URL to the device later over USB. `firmware/sdkconfig.local` is an optional, Git-ignored development override and is normally unnecessary. Keep HTTPS certificate validation enabled. HTTP is available only with the explicit local-test setting `CONFIG_MUSE_RELAY_ALLOW_HTTP=y`.

## Identify and flash the device

The existing firmware's partition layout may differ. Use the generated `flash_args` instead of flashing just the app at an old offset. If you need to restore existing firmware, save a full flash backup locally first. Backups may contain credentials and must stay out of public artifacts.

1. Hold the ATOM S3 side reset button for about two seconds or longer to enter download mode. Look for `/dev/cu.usbmodem*` on macOS or `/dev/ttyACM*` on Linux.
2. Identify the connected device:

   ```sh
   python -m esptool --port /dev/cu.usbmodemXXXX chip-id
   python -m esptool --port /dev/cu.usbmodemXXXX flash-id
   ```

3. After any required backup, flash it:

   ```sh
   firmware/tools/flash.sh /dev/cu.usbmodemXXXX
   ```

This does not erase all flash. Secure Boot, flash encryption, and eFuse writes are not enabled. The build uses the SDK's published development signing key. If it remains at `waiting for download`, reconnect USB power without holding a button. A long press that lights the green LED enters download mode.

## Tokens and connection settings

Start the local USB setup page from the project root:

```sh
python3 -m http.server 8789 --bind 127.0.0.1 --directory firmware/setup
```

Open `http://127.0.0.1:8789` in Chrome or Edge. Use the device-selection button to select USB, enter the HTTPS URL, device token, and SDK token, then save to the device. You can also import the device JSON exported by the server setup page. This page does not persist entered values in browser storage or send them over the network. The SDK token is needed only for initial setup or a change.

If hosting requires additional authentication, expand the additional-server-authentication section and enter its token. It accepts up to 1,024 printable ASCII characters. An empty field preserves the saved value; the remove-saved-authentication option clears it. When changing the relay URL, also set or remove the additional authentication required by that relay.

For command-line setup, install `pyserial` in your Python environment, then run:

```sh
python firmware/tools/configure.py --port /dev/cu.usbmodemXXXX
python firmware/tools/configure.py --port /dev/cu.usbmodemXXXX --sdk-only
```

Entered tokens are hidden and are not recorded in arguments or normal logs. The first command sets the HTTPS URL, device token, and optional additional authentication. The second sets the Muse SDK token. Settings are saved in device NVS. Changing the SDK token restarts the device automatically; reconnect USB power after changing only relay settings.

For automated setup, pass a non-public JSON file with `--settings-file`. Keys are `relay_url`, `relay_token` (the server export's `device_token` is also accepted), optional `relay_gateway_token` (`gateway_token` is also accepted), and `sdk_token`. An empty `relay_gateway_token` clears additional authentication; omission preserves it. Restrict the file to its owner and keep it out of Git.

## Pair with Muse

In Muse, open Settings → Devices, enable Developer mode, and use Add Device to select `MuseGadget-XXXXXX`. Choose your home Wi-Fi and briefly press the ATOM S3 front button when asked to confirm. Changing the SDK token requires pairing again. Holding the front button for five seconds resets pairing and Wi-Fi.

The USB console command `>relay_status` returns only the booleans `sdk_connected`, `configured`, and `gateway_configured`. It does not return SDK tokens, Wi-Fi passwords, or relay tokens.

## Communication contract

The device uses the same device Bearer token for these routes. Only when additional authentication is configured, it also sends `OAI-Sites-Authorization: Bearer <additional-auth-token>` to the same relay. The device's `Authorization` remains separate; the additional header is never sent to the Muse SDK. Redirects are not followed. Standard deployments need no additional authentication.

| API | Purpose |
| --- | --- |
| `GET /device/jobs` | Next request, including `job.id`, `job.request_bytes`, and `job.session_id` |
| `GET /device/jobs/:id/request` | JSON body to pass to Muse `/chat/stream`; `Content-Length` is required |
| `POST /device/events` | Muse ACK, reply fragments, heartbeats, and errors |

Events include `job_id`, `session_id`, and an `event_id` that stays unchanged on retries. `muse_ack.body` is the ACK JSON string. `muse_event.body` is an event the device has filtered to the relevant request. The relay checks conversation and message IDs again. A `heartbeat` is sent every 20 seconds while awaiting a reply. The device ends its subscription when the server returns `{ "ok": true, "terminal": true }`.

Conversation continues in a dedicated chat with a stable `session_id` per relay. For an existing chat, the device subscribes successfully before sending and accepts replies after the user row matching the ACK. It excludes other user rows, parent IDs, and conversation IDs. Only when the initial subscription returns 404 does sending create the chat; the device verifies the ACK's session ID and `is_thread`, then subscribes again. That ACK envelope includes `subscription_fresh: true`. It never falls back to the main chat.

The body is sent to the SDK in 1 KiB chunks. Limits are 2 MiB for the body, 4 KiB for the ACK, and 120 seconds for a reply. Buffer exhaustion or disconnection returns an error. An unknown outcome after delivery to Muse is not retried automatically.

Visible text on ATOM S3 is limited to 4 KiB UTF-8 for each transcript and each reply. Overflow returns `muse_response_text_too_large`; partial text is not marked complete. Unrelated large `approvals.snapshot` and history events are consumed without storing them in full. SDK callbacks do not perform HTTP or wait; relevant text additions are coalesced in an outgoing buffer before forwarding.

This headless ATOM S3 uses `CONFIG_MUSE_RELAY_COMPACT_NOISE`: a 17 KiB receive buffer accepts normal 16 KiB chat fragments, paired with a smaller send buffer. Larger SDK frames produce `muse_response_frame_too_large`. Splitting an NDJSON line at the relay does not remove the SDK frame limit. To leave RAM for forwarding audio from HTTPS to the SDK, fixed Wi-Fi receive buffers are limited to eight, and TCP send buffers and receive windows to the official low-memory setting of 5,760 bytes. The SDK's DMA and TLS reserves are unchanged.

## Features and verification scope

- Text uses SDK `/chat/stream` and `/chat/subscribe`.
- Muse-processed audio is an `audio/wav` attachment. 16 kHz mono WAV matches the SDK implementation. Live captions use the app's separate Soniox path.
- Image bodies can travel on the same stream, but the SDK audio example does not establish that Muse accepts image input. Enable image input only after verifying it for your relay.
- No dedicated SDK API for reading Spaces has been verified. The app sends the configured Space-reading instruction to Muse, and a Muse-created adapter returns the content.
- ATOM S3 does not expose an always-on public internet listener. Your HTTPS relay, home Wi-Fi, and power are required.

Verify firmware compilation, USB boot, communication with Muse, and the round trip from an outside network separately. A local mock response does not establish physical connectivity.

The SDK and the adapted `chat_filter.c` / `chat_filter.h` are Apache-2.0. Other new Muse Relay code follows the project license. Upstream SDK avatars have separate rights and are unused in this headless build.
