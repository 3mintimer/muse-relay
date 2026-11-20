# AtomS3 and AtomS3 Lite relay

[English](atoms3.md) · [日本語](atoms3.ja.md)

Muse Relay is a shared EvenHub app. Every user runs the same build and configures their own relay, either built themselves or set up by their Muse. The distributed app contains no user's server, network, or credentials.

This guide covers the AtomS3 (C123) and AtomS3 Lite (C124) reference firmware for the Muse Gadget SDK. Both are optional. Any relay implementing the same protocol can use the shared app.

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

Both models have 8 MB of flash and no PSRAM. This implementation uses SDK Wi-Fi, BLE pairing, and the Noise connection. The phone or G2 handles audio, images, and controls. The Lite build uses its built-in RGB LED for status. [AtomS3 specifications](https://docs.m5stack.com/en/core/AtomS3) · [AtomS3 Lite specifications](https://docs.m5stack.com/en/core/AtomS3-Lite)

## Requirements

- AtomS3 or AtomS3 Lite, a USB data cable, and stable USB power.
- 2.4 GHz Wi-Fi, configured during pairing in the Muse app.
- A [Muse Gadget SDK token](https://gadgets.muse.ai/settings/sdk-tokens). Review the site's [SDK Terms](https://gadgets.muse.ai/sdk-terms) before use.
- ESP-IDF **6.0.3**, Python 3.10 or later, CMake, and Ninja, as supported by the [Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk).
- Your Muse Relay server: an HTTPS URL reachable outside your home and a device token separate from the app token. No router port forwarding to ATOM is required.

## Build

Activate ESP-IDF from the project root.

```sh
. /path/to/esp-idf-v6.0.3/export.sh
```

Choose the build and package commands for your board.

| Board | Build | Package | ZIP |
| --- | --- | --- | --- |
| AtomS3 (C123) | `firmware/tools/build.sh` | `python3 firmware/tools/package.py` | `firmware/build-atoms3/muse-relay-atoms3-0.1.4.zip` |
| AtomS3 Lite (C124) | `firmware/tools/build.sh atoms3-lite` | `python3 firmware/tools/package.py --build-dir firmware/build-atoms3-lite` | `firmware/build-atoms3-lite/muse-relay-atoms3-lite-0.1.4.zip` |

The SDK checkout defaults to `.local/hardware/muse-gadget-sdk`. Set `MUSE_SDK_CHECKOUT` to use another location. The pinned SDK commit is `c3d58c66a02bfea44847e0345714507166656bed`. Each ZIP includes the binaries, `flash_args` for initial installation, `flash_app_args` for an app-only update, notices, and SHA-256 checksums.

Do not put personal tokens into build-time SDK settings. Save tokens and the URL to the device later over USB. `firmware/sdkconfig.local` is an optional, Git-ignored development override and is normally unnecessary. Keep HTTPS certificate validation enabled. HTTP is available only with the explicit local-test setting `CONFIG_MUSE_RELAY_ALLOW_HTTP=y`.

## First installation

Use this procedure for a first installation or a migration from a different firmware layout. Save a full flash backup locally before writing the package's layout. Backups may contain credentials and must stay out of public artifacts.

1. Hold the ATOM S3 side reset button for about two seconds or longer to enter download mode. Look for `/dev/cu.usbmodem*` on macOS or `/dev/ttyACM*` on Linux.
2. Identify the connected device:

   ```sh
   python -m esptool --port /dev/cu.usbmodemXXXX chip-id
   python -m esptool --port /dev/cu.usbmodemXXXX flash-id
   ```

3. After the backup, run the following from the extracted ZIP directory for your board.

   ```sh
   python -m esptool --chip esp32s3 --port /dev/cu.usbmodemXXXX --baud 460800 \
       --before no-reset --after hard-reset write-flash @flash_args
   ```

This does not erase all flash. Secure Boot, flash encryption, and eFuse writes are not enabled. The build uses the SDK's published development signing key. If it remains at `waiting for download`, reconnect USB power without holding a button. A long press that lights the green LED enters download mode.

## Update and retain settings

Use the app-only update for an existing `muse-relay` installation with the same partition layout. Start the device normally and check its 115200-baud boot log for `Project name: muse-relay` and `Loaded app from partition at offset 0x20000`. Close the serial monitor before updating. The Wi-Fi, pairing, SDK token, and relay settings are held in NVS at `0x11000`.

Run the following from the extracted ZIP for your board, replacing `port` with its USB port. The backup goes into a private directory alongside the extracted ZIP. The commands stop if the backup size, partition table, or app-only flash arguments differ. If USB cannot enter download mode automatically, use the side button to enter it and set `enter_download=no-reset` before rerunning. [ESP32-S3 download mode](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/advanced-topics/boot-mode-selection.html)

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
    printf 'Backup saved in %s\n' "$backup"
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

After reboot, check the new version and run `>relay_status`. Confirm the device connects to Muse and send a short request to verify delivery and reply. Keep the backup private.

## Firmware updates from your relay

Install 0.1.4 over USB once using the instructions above. A compatible HTTPS relay can then offer a newer application while the device is idle. A relay that only implements the original job API continues to work.

The device sends `X-Muse-Target` and `X-Muse-Version` with its authenticated job poll. The board targets are `muse-relay/atoms3/8m-ab-v1` and `muse-relay/atoms3-lite/8m-ab-v1`. An operator can include a `firmware` object alongside `"job": null` containing `target`, numeric three-part `version` (string), `size` in bytes, lowercase `sha256`, and a positive integer `generation`. Restrict release selection to the relay administrator. Serve the ZIP's signed `muse-relay.bin` at `GET /device/firmware/{sha256}` with device authentication and an exact Content-Length.

The device downloads to the inactive slot and checks the binary hash, signature, board marker, project and version. On first boot it must reach Muse and successfully poll the relay within five minutes to confirm the image. The previous slot remains available for rollback. A confirmed version or a failed attempt is reported to `POST /device/firmware/status` with `attempt` (hash.generation), running `version`, `slot` and `status` (`verifying`, `confirmed`, or `previous_running`). After diagnosing a failed transfer, increment the generation to authorize another attempt. For USB recovery, inspect the active slot and partition table before selecting the write address. The ZIP's fixed app-only address applies to a device running from ota_0.

## AtomS3 Lite status LED

| LED | State |
| --- | --- |
| Steady red | Wi-Fi disconnected or internet unreachable |
| Blinking amber | Internet reachable, Muse disconnected or reconnecting |
| Steady green | Connected to Muse and idle |
| Blinking blue | Forwarding a request or waiting for Muse to reply |
| Steady purple | Relaying Muse's reply |

The blue blink starts when the ATOM takes the request from the relay. When Wi-Fi has an IP address and either Muse is disconnected or the HTTPS transport fails, the device uses the SDK's TCP reachability check. A successful HTTPS exchange also confirms reachability.

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

The USB console command `>relay_status` returns `sdk_connected`, `configured`, `gateway_configured`, and `led_state`. On the standard AtomS3 build, `led_state` reports `off`.

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
