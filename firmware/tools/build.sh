#!/bin/sh
set -eu
firmware_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project_dir=$(dirname "$firmware_dir")
sdk_dir=${MUSE_SDK_CHECKOUT:-"$project_dir/.local/hardware/muse-gadget-sdk"}
build_dir=${MUSE_RELAY_BUILD_DIR:-"$firmware_dir/build-atoms3"}
python3 "$firmware_dir/tools/prepare_sdk.py" "$sdk_dir"
if ! command -v idf.py >/dev/null 2>&1; then
    echo "Activate ESP-IDF 6.0.3 first (. /path/to/esp-idf/export.sh)." >&2
    exit 2
fi
idf.py --version | grep -q 'v6.0.3' || { echo "ESP-IDF 6.0.3 is required." >&2; exit 2; }
mkdir -p "$build_dir"
# This is the SDK's committed, public development signing key. Secure Boot is
# disabled; no per-user signing secret or eFuse operation is introduced.
printf 'CONFIG_SECURE_BOOT_SIGNING_KEY="%s/esp32/dev_signing_key.pem"\n' "$sdk_dir" > "$build_dir/sdkconfig.paths"
defaults="$sdk_dir/esp32/sdkconfig.defaults;$firmware_dir/sdkconfig.atoms3;$build_dir/sdkconfig.paths"
if [ -f "$firmware_dir/sdkconfig.local" ]; then defaults="$defaults;$firmware_dir/sdkconfig.local"; fi
# Generated sdkconfig caches old defaults. This script always regenerates it;
# serial-provisioned settings survive on the board and are not in this file.
if [ -f "$build_dir/sdkconfig" ]; then rm "$build_dir/sdkconfig"; fi
exec idf.py -C "$firmware_dir" -B "$build_dir" \
    -DIDF_TARGET=esp32s3 -DMUSE_SDK_DIR="$sdk_dir/esp32" \
    -DSDKCONFIG="$build_dir/sdkconfig" -DSDKCONFIG_DEFAULTS="$defaults" build
