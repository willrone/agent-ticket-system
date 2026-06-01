#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

API_BASE_URL="${TICKET_API_HEALTHCHECK_BASE_URL:-${TICKET_API_LOCAL_BASE_URL:-http://127.0.0.1:8790}}"
LAUNCH_LABEL="${TICKET_LAUNCHAGENT_LABEL:-ai.openclaw.ticket-platform-api-v2}"
PLIST_PATH="${TICKET_LAUNCHAGENT_PLIST_PATH:-$HOME/Library/LaunchAgents/${LAUNCH_LABEL}.plist}"
OUT_LOG="${TICKET_API_OUT_LOG:-/Users/ronghui/Projects/agent-ticket-system-v2/logs/api.out.log}"
ERR_LOG="${TICKET_API_ERR_LOG:-/Users/ronghui/Projects/agent-ticket-system-v2/logs/api.err.log}"
PORT="${TICKET_API_PORT:-8790}"
DB_PATH="${TICKETS_DB_PATH:-/Users/ronghui/Projects/agent-ticket-system-v2/data/tickets-v2.db}"
FAIL=0
WARN=0

echo "== ticket-platform v2 healthcheck =="
echo "repo=$REPO_DIR"
echo "api_base_url=$API_BASE_URL"
echo "launch_label=$LAUNCH_LABEL"
echo "db_path=$DB_PATH"

if [[ -f "$PLIST_PATH" ]]; then
  echo "PASS plist exists: $PLIST_PATH"
else
  echo "WARN plist missing: $PLIST_PATH"
  WARN=1
fi

if launchctl print "gui/$(id -u)/$LAUNCH_LABEL" >/tmp/ticket-v2-launch.$$ 2>/tmp/ticket-v2-launch.err.$$; then
  echo "PASS launchctl loaded: $LAUNCH_LABEL"
  if rg -q 'state = running' /tmp/ticket-v2-launch.$$; then
    echo "PASS launchctl state=running"
  else
    echo "WARN launchctl loaded but state not running"
    WARN=1
  fi
else
  ERR_MSG="$(cat /tmp/ticket-v2-launch.err.$$ 2>/dev/null || true)"
  echo "WARN launchctl not loaded: $LAUNCH_LABEL${ERR_MSG:+ ; $ERR_MSG}"
  WARN=1
fi
rm -f /tmp/ticket-v2-launch.$$ /tmp/ticket-v2-launch.err.$$

if VERSION_JSON="$(curl -fsS --max-time 8 "$API_BASE_URL/api/version")"; then
  echo "PASS /api/version reachable"
  echo "$VERSION_JSON" | python3 -m json.tool | sed -n '1,20p'
else
  echo "FAIL /api/version unreachable"
  FAIL=1
fi

if curl -fsS --max-time 8 "$API_BASE_URL/api/v1/agent/runtime/context" >/tmp/ticket-v2-runtime.$$; then
  echo "PASS runtime context reachable"
else
  echo "FAIL runtime context unreachable"
  FAIL=1
fi
rm -f /tmp/ticket-v2-runtime.$$

if [[ -f "$DB_PATH" ]]; then
  echo "PASS db exists: $DB_PATH"
else
  echo "WARN db not created yet: $DB_PATH"
  WARN=1
fi

if [[ -f "$OUT_LOG" ]]; then
  echo "PASS out log exists: $OUT_LOG"
else
  echo "WARN out log missing: $OUT_LOG"
  WARN=1
fi

if [[ -f "$ERR_LOG" ]]; then
  echo "PASS err log exists: $ERR_LOG"
else
  echo "WARN err log missing: $ERR_LOG"
  WARN=1
fi

if command -v lsof >/dev/null 2>&1; then
  PORT_LINES="$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN | tail -n +2 || true)"
  if [[ -n "$PORT_LINES" ]]; then
    echo "PASS port ${PORT} listener detected"
    echo "$PORT_LINES"
  else
    echo "FAIL no listener on port ${PORT}"
    FAIL=1
  fi
fi

if [[ "$FAIL" -ne 0 ]]; then
  exit 2
fi
if [[ "$WARN" -ne 0 ]]; then
  exit 1
fi
exit 0
