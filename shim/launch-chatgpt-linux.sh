#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "${CHATGPT_APP:-}" ]; then
  APP="$CHATGPT_APP"
elif command -v chatgpt >/dev/null 2>&1; then
  APP="$(command -v chatgpt)"
else
  echo "ChatGPT executable not found. Set CHATGPT_APP to the Linux executable or AppImage." >&2
  exit 1
fi

if [ ! -f "$APP" ] || [ ! -x "$APP" ]; then
  echo "ChatGPT executable is not runnable: $APP" >&2
  exit 1
fi

SOCK="${CODEX_MICRO_SOCKET:-/tmp/codex-micro-vhid.sock}"
STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/codex-micro-emulator"
mkdir -p "$STATE_DIR"

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=$DIR/shim/preload.cjs"
export CODEX_MICRO_SOCKET="$SOCK"
export CODEX_MICRO_SHIM_LOG="${CODEX_MICRO_SHIM_LOG:-$STATE_DIR/shim.log}"

echo "Launching ChatGPT with the Codex Micro shim"
echo "  app    : $APP"
echo "  socket : $CODEX_MICRO_SOCKET"
echo "  log    : $CODEX_MICRO_SHIM_LOG"
echo "Make sure the bridge is running: node bin/codex-micro-emulator.js --mode shim"
echo "If detection fails, verify Electron's EnableNodeOptionsEnvironmentVariable fuse."

if [ "${1:-}" = "--dry-run" ]; then
  exit 0
fi
APP_ARGS=()
if [ "${1:-}" = "--new-instance" ]; then
  APP_ARGS+=("--new-instance")
  shift
fi
if [ "$#" -gt 0 ]; then
  echo "Unknown argument: $1" >&2
  exit 2
fi

exec "$APP" "${APP_ARGS[@]}"
