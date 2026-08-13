#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="${CHATGPT_INSTALL_DIR:-/usr/lib/chatgpt}"
WEBVIEW_ROOT="${CHATGPT_WEBVIEW_ROOT:-}"
CHATGPT_ASAR="${CHATGPT_ASAR:-$INSTALL_DIR/resources/app.asar}"
STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/codex-micro-emulator"

if [ -z "${CHATGPT_APP:-}" ]; then
  if command -v chatgpt >/dev/null 2>&1; then
    CHATGPT_APP="$(command -v chatgpt)"
  elif command -v chatgpt-desktop >/dev/null 2>&1; then
    CHATGPT_APP="$(command -v chatgpt-desktop)"
  elif [ -x "$INSTALL_DIR/ChatGPT" ]; then
    CHATGPT_APP="$INSTALL_DIR/ChatGPT"
  fi
  export CHATGPT_APP
fi

if [ -n "$WEBVIEW_ROOT" ]; then
  OVERLAY_ARGS=(--root "$WEBVIEW_ROOT")
elif [ -f "$CHATGPT_ASAR" ]; then
  OVERLAY_ARGS=(--asar "$CHATGPT_ASAR")
else
  echo "ChatGPT webview files not found." >&2
  echo "Set CHATGPT_WEBVIEW_ROOT for an extracted webview or CHATGPT_ASAR for the Official app.asar." >&2
  exit 1
fi

if [ "${1:-}" = "--dry-run" ]; then
  REPLACEMENTS="$(node "$DIR/scripts/force-codex-micro-webview.mjs" "${OVERLAY_ARGS[@]}" --check-only)"
  echo "ChatGPT Codex Micro forced launcher dry run"
  echo "  patches: $REPLACEMENTS"
  echo "This is a temporary unsupported override; /opt is not modified."
  "$DIR/shim/launch-chatgpt-linux.sh" --dry-run
  exit 0
fi

if [ "${CODEX_MICRO_ALLOW_RUNNING_APP:-0}" != "1" ]; then
  if pgrep -f "$INSTALL_DIR/ChatGPT" >/dev/null 2>&1 || pgrep -f "$INSTALL_DIR/electron" >/dev/null 2>&1; then
    echo "ChatGPT Desktop is already running." >&2
    echo "Quit it completely before using the forced Codex Micro launcher." >&2
    exit 1
  fi
fi

mkdir -p "$STATE_DIR"
TEMP_DIR="$(mktemp -d /tmp/codex-micro-force.XXXXXX)"
READY_FILE="$TEMP_DIR/ready"
SERVER_LOG="$STATE_DIR/forced-webview.log"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

node "$DIR/scripts/force-codex-micro-webview.mjs" \
  "${OVERLAY_ARGS[@]}" \
  --host 127.0.0.1 \
  --port 0 \
  --ready-file "$READY_FILE" \
  >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in {1..100}; do
  [ -s "$READY_FILE" ] && break
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Forced Codex Micro webview server failed:" >&2
    sed -n '1,120p' "$SERVER_LOG" >&2
    exit 1
  fi
  sleep 0.05
done

if [ ! -s "$READY_FILE" ]; then
  echo "Timed out waiting for the forced Codex Micro webview server." >&2
  sed -n '1,120p' "$SERVER_LOG" >&2
  exit 1
fi

mapfile -t READY < "$READY_FILE"
OVERLAY_URL="${READY[0]:-}"
REPLACEMENTS="${READY[1]:-0}"
if [[ "$OVERLAY_URL" != http://127.0.0.1:*/* ]] || [ "$REPLACEMENTS" -lt 1 ]; then
  echo "Invalid forced webview readiness data." >&2
  exit 1
fi

echo "Launching ChatGPT with the Codex Micro feature forced on"
echo "  webview: $OVERLAY_URL"
echo "  patches: $REPLACEMENTS"
echo "  log    : $SERVER_LOG"
echo "This is a temporary unsupported override; /opt is not modified."

CODEX_LINUX_ALLOW_RENDERER_URL_OVERRIDE=1 \
ELECTRON_RENDERER_URL="$OVERLAY_URL" \
CODEX_MICRO_RENDERER_URL="$OVERLAY_URL" \
  "$DIR/shim/launch-chatgpt-linux.sh" "$@"
