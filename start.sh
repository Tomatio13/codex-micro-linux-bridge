#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SOCK="${CODEX_MICRO_SOCKET:-/tmp/codex-micro-vhid.sock}"
if [ ! -S "$SOCK" ]; then
  echo "Codex Micro bridge is not running: $SOCK" >&2
  echo "Start it with: systemctl --user start codex-micro-bridge.service" >&2
  exit 1
fi

CHATGPT_APP=/usr/bin/chatgpt "$DIR/shim/launch-chatgpt-linux-forced.sh" "$@"
