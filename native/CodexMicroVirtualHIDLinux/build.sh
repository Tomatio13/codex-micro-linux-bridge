#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/CodexMicroVirtualHIDLinux"
CC_BIN="${CC:-cc}"

if [ "$(uname -s)" != "Linux" ]; then
  echo "The uhid helper can only be built on Linux." >&2
  exit 1
fi

if ! command -v "$CC_BIN" >/dev/null 2>&1; then
  echo "C compiler not found: $CC_BIN" >&2
  echo "Ubuntu: sudo apt install build-essential" >&2
  exit 1
fi

"$CC_BIN" -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror \
  "$DIR/main.c" -o "$OUT"

echo "Built $OUT"
echo "Run: sudo $OUT /tmp/codex-micro-vhid.sock"
