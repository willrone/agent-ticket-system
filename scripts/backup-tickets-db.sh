#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DB_PATH="${TICKETS_DB_PATH:-$REPO_DIR/data/tickets.db}"
BACKUP_DIR="${TICKET_DB_BACKUP_DIR:-$REPO_DIR/data/backups/auto}"
RETENTION="${TICKET_DB_BACKUP_RETENTION:-24}"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[backup-tickets-db] skip: db not found: $DB_PATH"
  exit 0
fi

DEST="$BACKUP_DIR/tickets-$TS.db"
TMP_DEST="$DEST.tmp"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".timeout 5000" ".backup '$TMP_DEST'"
  mv "$TMP_DEST" "$DEST"
else
  cp -p "$DB_PATH" "$DEST"
fi

if [[ "$RETENTION" =~ '^[0-9]+$' ]] && (( RETENTION > 0 )); then
  old_files=( ${(f)$(ls -1t "$BACKUP_DIR"/tickets-*.db 2>/dev/null)} )
  if (( ${#old_files[@]} > RETENTION )); then
    for f in "${old_files[@]:$RETENTION}"; do
      rm -f -- "$f"
    done
  fi
fi

echo "[backup-tickets-db] created: $DEST"
