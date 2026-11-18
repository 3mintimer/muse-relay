#!/usr/bin/env python3
"""Package a credential-free ATOM S3 build with its exact flash offsets."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile


def license_files(build):
    """Read notices from this build's pinned sources, excluding unlinked tools."""
    firmware = Path(__file__).resolve().parents[1]
    project = firmware.parent
    description = json.loads((build / "project_description.json").read_text())
    components = {name: Path(path) for name, path in zip(
        description["build_components"], description["build_component_paths"]) if name and path}
    sdk = components["main"].parent.parent
    idf = Path(description["idf_path"])
    files = {
        "LICENSES/muse-relay.txt": project / "LICENSE",
        "LICENSES/muse-relay-NOTICE.md": project / "NOTICE.md",
        "LICENSES/muse-gadget-sdk.txt": firmware / "SDK-LICENSE",
        "LICENSES/esp-idf.txt": idf / "LICENSE",
    }
    for name in ("NOTICE", "NOTICE.txt", "NOTICE.md"):
        if (sdk / name).is_file():
            files["LICENSES/muse-gadget-sdk-" + name] = sdk / name
        if (idf / name).is_file():
            files["LICENSES/esp-idf-" + name] = idf / name
    # The first map section records archives actually pulled into the link.
    # Avoid attributing unlinked video libraries or build tools as firmware.
    linked = (build / "muse-relay.map").read_text().split("Discarded input sections", 1)[0]
    used = set(re.findall(r"esp-idf/([^/]+)/lib[^/]+\.a", linked))
    if "heap" in used:
        files["LICENSES/tlsf.txt"] = firmware / "licenses/tlsf.txt"
    for component in sorted(used & components.keys()):
        directory = components[component]
        for file in sorted(directory.iterdir()):
            if file.is_file() and file.name.lower().startswith(("license", "notice", "copying")):
                files["LICENSES/" + component + "/" + file.name] = file
    nested = {
        "bt": (
            "host/nimble/nimble/LICENSE", "host/nimble/nimble/NOTICE",
            "host/nimble/nimble/ext/tinycrypt/LICENSE",
            "common/tinycrypt/LICENSE", "controller/lib_esp32c3_family/LICENSE",
        ),
        "esp_coex": ("lib/LICENSE",),
        "esp_phy": ("lib/LICENSE",),
        "esp_wifi": ("lib/LICENSE",),
        "freertos": ("FreeRTOS-Kernel/LICENSE.md",),
        "lwip": ("lwip/COPYING",),
        "mbedtls": ("mbedtls/LICENSE", "mbedtls/tf-psa-crypto/LICENSE"),
        "wpa_supplicant": ("README",),  # COPYING points here for the full BSD text.
    }
    for component, names in nested.items():
        if component in used:
            for name in names:
                files["LICENSES/" + component + "/" + name] = components[component] / name
    # libgcc/libstdc++ runtime notices shipped with the actual compiler.
    compiler = Path(description["c_compiler"])
    gcc_licenses = compiler.parent.parent / "share/licenses/gcc"
    for name in ("COPYING3", "COPYING.RUNTIME"):
        files["LICENSES/gcc-runtime/" + name] = gcc_licenses / name
    return files


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-dir", type=Path,
                        default=Path(__file__).resolve().parents[1] / "build-atoms3")
    args = parser.parse_args()
    build = args.build_dir.resolve()
    config = (build / "sdkconfig").read_text()
    for line in config.splitlines():
        if line.startswith("CONFIG_GADGET_SDK_TOKEN=") and line != 'CONFIG_GADGET_SDK_TOKEN=""':
            raise SystemExit("Refusing to package a build with an embedded SDK token")
        if line in {"CONFIG_SECURE_BOOT=y", "CONFIG_SECURE_FLASH_ENC_ENABLED=y",
                    "CONFIG_HOMEHUB_PAIRING_EFUSE_AUTH=y"}:
            raise SystemExit("Refusing to package a hardware-locking build")
    flash = json.loads((build / "flasher_args.json").read_text())
    notices = {name: path.read_bytes() for name, path in license_files(build).items()}
    out = build / "muse-relay-atoms3-0.1.0.zip"
    lines = []
    hashes = []
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for offset, relative in flash["flash_files"].items():
            source = (build / relative).resolve()
            source.relative_to(build)  # Reject unexpected file paths.
            data = source.read_bytes()
            archive.writestr(source.name, data)
            lines.append(offset + " " + source.name)
            hashes.append(hashlib.sha256(data).hexdigest() + "  " + source.name)
        settings = flash["flash_settings"]
        switches = [
            "--flash-mode " + settings["flash_mode"],
            "--flash-freq " + settings["flash_freq"],
            "--flash-size " + settings["flash_size"],
        ]
        archive.writestr("flash_args", "\n".join(switches + lines) + "\n")
        for name, data in notices.items():
            archive.writestr(name, data)
            hashes.append(hashlib.sha256(data).hexdigest() + "  " + name)
        archive.writestr("SHA256SUMS", "\n".join(hashes) + "\n")
        archive.writestr("LICENSES/README.txt",
            "Original Muse Relay code is MIT licensed; see muse-relay.txt.\n"
            "Muse Gadget SDK c3d58c66a02bfea44847e0345714507166656bed is Apache-2.0.\n"
            "Muse Relay adds a serial hook in sdk_token_console.c, a compact headless buffer profile\n"
            "in noise_control.cpp, and a relay worker.\n"
            "validate_config.cmake allows the same bounded TCP windows on the headless profile.\n"
            "chat_filter.c/h adapt the SDK's incremental chat parser under Apache-2.0;\n"
            "see muse-relay-NOTICE.md for attribution and changes.\n"
            "Source: https://github.com/facebookincubator/muse-gadget-sdk\n"
            "The pinned SDK has no root NOTICE file. This packager includes one if supplied upstream.\n"
            "ESP-IDF 6.0.3 and notices from libraries used by this build are included here.\n"
            "Source: https://github.com/espressif/esp-idf/tree/v6.0.3\n"
            "Mbed TLS and TF-PSA-Crypto are used under their Apache-2.0 option.\n"
            "GCC runtime files carry the GCC Runtime Library Exception in COPYING.RUNTIME.\n")
        archive.writestr("README.txt",
            "Muse Relay 0.1.0 / ATOM S3 (ESP32-S3, 8 MB flash, no PSRAM)\n"
            "Built with Muse Gadget SDK c3d58c66a02bfea44847e0345714507166656bed and ESP-IDF 6.0.3.\n"
            "No user credentials are embedded. Configure SDK/relay tokens over USB after flashing.\n"
            "This build uses the SDK's public development signing key. Secure Boot is disabled.\n"
            "Inspect the attached chip and back up existing flash before replacing its partition table.\n"
            "With esptool 5.x, from this extracted directory:\n"
            "python -m esptool --chip esp32s3 --port PORT --baud 460800 "
            "--before no-reset --after hard-reset write-flash @flash_args\n"
            "Guide: docs/atoms3.md in the Muse Relay source project.\n"
            "Third-party license texts and notices are included in LICENSES/.\n"
            "Compilation does not confirm physical hardware or Muse account connectivity.\n")
    print(out)


if __name__ == "__main__":
    main()
