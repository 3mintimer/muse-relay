#!/usr/bin/env python3
"""Set SDK/relay tokens over USB without echoing values or putting them in argv."""
import argparse
import getpass
import json
from pathlib import Path
import time


def save_setting(port, key, value):
    """Retry the same NVS value while the app boots; stop on its first ACK."""
    prefix = b"@sdk_token " if key == "sdk_token" else b"@relay "
    command = ("\n>" + key + "=" + value + "\n").encode()
    deadline = time.monotonic() + 25
    next_send = 0
    partial = b""
    port.reset_input_buffer()
    while time.monotonic() < deadline:
        now = time.monotonic()
        if now >= next_send:
            if port.write(command) != len(command):
                raise SystemExit(f"Incomplete USB write for {key}; value omitted")
            next_send = now + 3
        partial += port.read(port.in_waiting or 1)
        while b"\n" in partial:
            line, partial = partial.split(b"\n", 1)
            # The SDK's other logs may contain private data. Never print them.
            _, found, answer = line.partition(prefix)
            if found and (answer == b"ok" or answer.startswith(b"ok ") or answer == b"ok\r"):
                return
            if found and answer.startswith(b"error "):
                raise SystemExit(f"Device rejected {key}; value omitted")
        if len(partial) > 4096:
            partial = b""
    raise SystemExit(f"No acknowledgement for {key}; value omitted")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    parser.add_argument("--settings-file", type=Path,
                        help="Private JSON with relay_url, relay_token and optional gateway/SDK tokens")
    parser.add_argument("--sdk-only", action="store_true")
    args = parser.parse_args()
    import serial
    if args.settings_file:
        settings = json.loads(args.settings_file.read_text())
        if "relay_token" not in settings and "device_token" in settings:
            settings["relay_token"] = settings["device_token"]
        if "relay_gateway_token" not in settings and "gateway_token" in settings:
            settings["relay_gateway_token"] = settings["gateway_token"]
    elif args.sdk_only:
        settings = {"sdk_token": getpass.getpass("Muse Gadget SDK token: ")}
    else:
        settings = {"relay_url": input("HTTPS relay base URL: ").strip(),
                    "relay_token": getpass.getpass("Device token: ")}
        gateway = getpass.getpass("Gateway token (optional; blank leaves it unchanged): ")
        if gateway:
            settings["relay_gateway_token"] = gateway
    keys = ["relay_url", "relay_token", "relay_gateway_token", "sdk_token"]
    for key in keys:
        value = settings.get(key)
        if value is None or value == "" and key != "relay_gateway_token":
            continue
        if not isinstance(value, str) or "\n" in value or "\r" in value:
            raise SystemExit("Invalid setting value")
        if key == "relay_gateway_token" and (len(value) > 1024 or any(not 33 <= ord(c) <= 126 for c in value)):
            raise SystemExit("Gateway token must contain at most 1024 printable ASCII characters; value omitted")
    # Opening a native USB port can restart the board. Keep EN/BOOT released,
    # as the upstream Muse web flasher does, and let the console start first.
    port = serial.Serial(baudrate=115200, timeout=.2, write_timeout=2, exclusive=True)
    port.port = args.port
    port.dtr = port.rts = False
    with port:
        port.rts = port.dtr = False
        time.sleep(1)
        for key in keys:
            value = settings.get(key)
            if value is None or value == "" and key != "relay_gateway_token":
                continue
            try:
                save_setting(port, key, value)
            except serial.SerialException:
                raise SystemExit(f"USB connection failed while saving {key}; value omitted") from None
            print(f"Saved {key}")
    print("Restart USB power to apply relay settings. SDK token changes restart automatically.")


if __name__ == "__main__":
    main()
