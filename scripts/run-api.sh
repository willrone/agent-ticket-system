#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

# Optional centralized live environment. LaunchAgent normally injects this.
if [[ -n "${TICKET_ENV_FILE:-}" && -r "${TICKET_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${TICKET_ENV_FILE}"
  set +a
fi

: "${TICKET_BACKUP_BEFORE_START:=true}"
: "${NODE_BIN:=/opt/homebrew/bin/node}"
: "${TICKET_API_PORT:=8788}"

DEFAULT_DB_PATH="$REPO_DIR/data/tickets.db"
if [[ -z "${TICKETS_DB_PATH:-}" ]]; then
  if [[ "$TICKET_API_PORT" == "8788" ]]; then
    echo "fatal: TICKETS_DB_PATH is not explicitly set; refusing to run production port 8788 against default repo DB $DEFAULT_DB_PATH. Set TICKET_ENV_FILE or TICKETS_DB_PATH first." >&2
    exit 64
  fi
  export TICKETS_DB_PATH="$DEFAULT_DB_PATH"
fi

if [[ "$TICKET_BACKUP_BEFORE_START" == "true" && -x "$SCRIPT_DIR/backup-tickets-db.sh" ]]; then
  "$SCRIPT_DIR/backup-tickets-db.sh" || true
fi

echo "[run-api] repo=$REPO_DIR db_path=$TICKETS_DB_PATH port=$TICKET_API_PORT bind=${TICKET_API_BIND_HOST:-127.0.0.1}"
exec "$NODE_BIN" api/server.js
