#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

SOCK="${CODEX_MICRO_SOCKET:-/tmp/codex-micro-vhid.sock}"
HELPER="native/CodexMicroVirtualHIDLinux/CodexMicroVirtualHIDLinux"

if [ "$(uname -s)" != "Linux" ]; then
  echo "This launcher is for Linux only." >&2
  exit 1
fi
if [ ! -e /dev/uhid ]; then
  echo "/dev/uhid is unavailable. Run: sudo modprobe uhid" >&2
  exit 1
fi
if [ ! -x "$HELPER" ]; then
  bash native/CodexMicroVirtualHIDLinux/build.sh
fi

sudo "$HELPER" "$SOCK" &
HELPER_PID=$!
cleanup() {
  sudo kill "$HELPER_PID" 2>/dev/null || true
  wait "$HELPER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  [ -S "$SOCK" ] && break
  if ! kill -0 "$HELPER_PID" 2>/dev/null; then
    echo "Linux virtual-HID helper exited before creating $SOCK" >&2
    exit 1
  fi
  sleep 0.1
done
if [ ! -S "$SOCK" ]; then
  echo "Timed out waiting for Linux virtual-HID helper at $SOCK" >&2
  exit 1
fi

node bin/codex-micro-emulator.js --mode helper --socket "$SOCK" "$@"
