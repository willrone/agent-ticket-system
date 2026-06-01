#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

: "${TICKET_BACKUP_BEFORE_START:=true}"
: "${NODE_BIN:=/opt/homebrew/bin/node}"

if [[ "$TICKET_BACKUP_BEFORE_START" == "true" ]] && [[ -x "$SCRIPT_DIR/backup-tickets-db.sh" ]]; then
  "$SCRIPT_DIR/backup-tickets-db.sh" || true
fi

exec "$NODE_BIN" api/server.js
