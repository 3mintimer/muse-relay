#!/usr/bin/env python3
"""Prepare the pinned SDK's serial hook and bounded headless Noise profile."""
import argparse
from pathlib import Path
import subprocess

SDK_COMMIT = "c3d58c66a02bfea44847e0345714507166656bed"
SDK_URL = "https://github.com/facebookincubator/muse-gadget-sdk.git"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    checkout = args.directory.resolve()
    if not (checkout / ".git").exists():
        checkout.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "--no-checkout", SDK_URL, str(checkout)], check=True)
        subprocess.run(["git", "-C", str(checkout), "checkout", "--detach", SDK_COMMIT], check=True)
    revision = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
    if revision != SDK_COMMIT:
        raise SystemExit(f"SDK revision differs; expected {SDK_COMMIT}. Use a separate checkout.")
    source = checkout / "esp32/main/sdk_token_console.c"
    data = source.read_text()
    marker = "/* Muse Relay serial hook; see firmware/tools/prepare_sdk.py. */"
    if marker not in data:
        anchor = "bool sdk_token_console_command(const char *line) {\n"
        if data.count(anchor) != 1 or data.count("#define COMMAND_LINE_MAX 96") != 1:
            raise SystemExit("SDK console source changed; refusing to guess patch placement")
        data = data.replace(anchor, marker + "\nextern bool muse_relay_console_command(const char *line);\n"
                            + anchor + "    if (muse_relay_console_command(line)) return true;\n")
    # Accept a complete 1 KiB gateway token without overrunning the console
    # line, USB receive ring or task stack. Also upgrade our older local hook.
    for old in ("#define COMMAND_LINE_MAX 96", "#define COMMAND_LINE_MAX 384"):
        if data.count(old) == 1:
            data = data.replace(old, "#define COMMAND_LINE_MAX 1280")
    if data.count("#define COMMAND_LINE_MAX 1280") != 1:
        raise SystemExit("SDK console line limit changed; refusing to guess patch placement")
    for old, new in (
        ("cfg.rx_buffer_size = 256;", "cfg.rx_buffer_size = 2048;"),
        ('xTaskCreate(usj_task, "sdk_token_usj", 3072,', 'xTaskCreate(usj_task, "sdk_token_usj", 4096,'),
        ('xTaskCreate(uart_task, "sdk_token_uart", 3072,', 'xTaskCreate(uart_task, "sdk_token_uart", 4096,'),
    ):
        if data.count(old) == 1:
            data = data.replace(old, new)
        elif data.count(new) != 1:
            raise SystemExit("SDK console limits changed; refusing to guess patch placement")
    source.write_text(data)
    noise = checkout / "esp32/main/noise_control.cpp"
    data = noise.read_text()
    # Reuse the SDK's compact outbound sizes, while the headless/no-board
    # profile gets its ordinary 17 KiB inbound size. Keep the full UI disabled.
    for anchor in (
        "#if (CONFIG_MUSE_ENABLED && !CONFIG_SPIRAM && !CONFIG_HOMEHUB_TUNNEL) || \\\n"
        "    CONFIG_HOMEHUB_LED_BACKEND_CYD_ILI9341",
        "#if SMALL_CONTROL_SESSION && (CONFIG_MUSE_BOARD_M5STACK_CARDPUTER_ADV || \\\n"
        "                              CONFIG_MUSE_BOARD_AI_PASSPORT || \\\n"
        "                              CONFIG_MUSE_BOARD_M5STACK_ATOMS3)",
    ):
        patched = ("/* Muse Relay headless buffers; see firmware/tools/prepare_sdk.py. */\n"
                   "#if CONFIG_MUSE_RELAY_COMPACT_NOISE || \\\n    " + anchor.removeprefix("#if "))
        if data.count(patched) == 1:
            continue
        if data.count(anchor) != 1:
            raise SystemExit("SDK Noise buffer conditions changed; refusing to guess patch placement")
        data = data.replace(anchor, patched)
    noise.write_text(data)
    # Apply the SDK's existing four-MSS/no-PSRAM window exception to this
    # headless profile too. Keep its exact size and no-tunnel checks intact.
    validation = checkout / "esp32/cmake/validate_config.cmake"
    data = validation.read_text()
    anchor = "NOT ((CONFIG_MUSE_BOARD_M5STACK_CARDPUTER_ADV OR CONFIG_MUSE_BOARD_AI_PASSPORT) AND NOT CONFIG_SPIRAM AND"
    patched = "NOT ((CONFIG_MUSE_BOARD_M5STACK_CARDPUTER_ADV OR CONFIG_MUSE_BOARD_AI_PASSPORT OR CONFIG_MUSE_RELAY_COMPACT_NOISE) AND NOT CONFIG_SPIRAM AND"
    marker = "# Muse Relay adds its compact headless profile to the four-MSS window exception.\n"
    if patched not in data:
        if data.count(anchor) != 1:
            raise SystemExit("SDK TCP profile check changed; refusing to guess patch placement")
        data = data.replace(anchor, patched)
        data = data.replace("# Shared build-profile checks.", marker + "# Shared build-profile checks.", 1)
    elif data.count(patched) != 1 or data.count(marker) != 1:
        raise SystemExit("SDK TCP profile patch differs; refusing to guess patch placement")
    validation.write_text(data)
    print(f"Pinned Muse SDK prepared: {SDK_COMMIT}")


if __name__ == "__main__":
    main()
