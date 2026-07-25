#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="codex-micro-bridge.service"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$PROJECT_ROOT/systemd/$SERVICE_NAME.in"
DRY_RUN=0

usage() {
  cat <<'EOF'
Install the Codex Micro bridge as a systemd user service.

Usage:
  scripts/install-user-service.sh [--dry-run]

Options:
  --dry-run  Render the service to stdout without installing or starting it.
  -h, --help Show this help.

Environment:
  CODEX_MICRO_NODE  Absolute path to a Node.js >=18 executable.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

node_major() {
  "$1" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true
}

select_node() {
  local candidate major
  if [ -n "${CODEX_MICRO_NODE:-}" ]; then
    candidate="$CODEX_MICRO_NODE"
    if [ "${candidate#/}" = "$candidate" ]; then
      echo "CODEX_MICRO_NODE must be an absolute path: $candidate" >&2
      return 1
    fi
    if [ ! -x "$candidate" ]; then
      echo "CODEX_MICRO_NODE is not executable: $candidate" >&2
      return 1
    fi
    major="$(node_major "$candidate")"
    if [ -z "$major" ] || [ "$major" -lt 18 ]; then
      echo "CODEX_MICRO_NODE must be Node.js 18 or later: $candidate" >&2
      return 1
    fi
    printf '%s\n' "$candidate"
    return
  fi

  for candidate in /usr/bin/node "$(command -v node 2>/dev/null || true)"; do
    [ -n "$candidate" ] || continue
    [ -x "$candidate" ] || continue
    major="$(node_major "$candidate")"
    if [ -n "$major" ] && [ "$major" -ge 18 ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  echo "Node.js 18 or later was not found." >&2
  return 1
}

escape_replacement() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

render_service() {
  local escaped_root escaped_node
  escaped_root="$(escape_replacement "$PROJECT_ROOT")"
  escaped_node="$(escape_replacement "$NODE_BIN")"
  sed \
    -e "s|@PROJECT_ROOT@|$escaped_root|g" \
    -e "s|@NODE_BIN@|$escaped_node|g" \
    "$TEMPLATE"
}

NODE_BIN="$(select_node)"

if [ "$DRY_RUN" -eq 1 ]; then
  render_service
  exit 0
fi

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_PATH="$SERVICE_DIR/$SERVICE_NAME"
TEMP_FILE="$(mktemp)"
trap 'rm -f "$TEMP_FILE"' EXIT

render_service >"$TEMP_FILE"
install -d -m 0755 "$SERVICE_DIR"
install -m 0644 "$TEMP_FILE" "$SERVICE_PATH"

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"
if ! systemctl --user is-active --quiet "$SERVICE_NAME"; then
  echo "Failed to start $SERVICE_NAME" >&2
  systemctl --user status "$SERVICE_NAME" --no-pager >&2 || true
  exit 1
fi

echo "Installed and started $SERVICE_NAME"
echo "  unit: $SERVICE_PATH"
echo "  logs: journalctl --user -u $SERVICE_NAME -f"
