#!/bin/sh
set -eu
firmware_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_dir=${MUSE_RELAY_BUILD_DIR:-"$firmware_dir/build-atoms3"}
if [ "$#" -ne 1 ]; then echo "Usage: tools/flash.sh /dev/cu.usbmodem..." >&2; exit 2; fi
if [ ! -f "$build_dir/flash_args" ]; then echo "Build the firmware first." >&2; exit 2; fi
cd "$build_dir"
# Inspect/backup first: flashing replaces the old partition table as well as
# the app. Does not erase the entire chip or burn any eFuses.
exec python -m esptool --chip esp32s3 --port "$1" --baud 460800 \
    --before no-reset --after hard-reset write-flash @flash_args
