#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

case "$(uname -s)" in
  Darwin) exec bash "$DIR/CodexMicroVirtualHID/build.sh" ;;
  Linux) exec bash "$DIR/CodexMicroVirtualHIDLinux/build.sh" ;;
  *)
    echo "Native virtual HID is supported on macOS and Linux only." >&2
    exit 1
    ;;
esac
