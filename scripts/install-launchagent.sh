#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
LAUNCH_LABEL="${TICKET_LAUNCHAGENT_LABEL:-ai.openclaw.ticket-platform-api}"
PLIST_PATH="${TICKET_LAUNCHAGENT_PLIST_PATH:-$HOME/Library/LaunchAgents/${LAUNCH_LABEL}.plist}"
LOG_DIR="${TICKET_API_LOG_DIR:-$REPO_DIR/logs}"
RUN_API_SCRIPT="${TICKET_RUN_API_SCRIPT:-$REPO_DIR/scripts/run-api.sh}"
mkdir -p "$LOG_DIR" "$(dirname -- "$PLIST_PATH")"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCH_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$RUN_API_SCRIPT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}</string>
    <key>TICKETS_DB_PATH</key>
    <string>${TICKETS_DB_PATH:-$REPO_DIR/data/tickets.db}</string>
    <key>TICKET_INTERNAL_POLLERS_ENABLED</key>
    <string>${TICKET_INTERNAL_POLLERS_ENABLED:-true}</string>
    <key>TICKET_DISPATCH_POLL_INTERVAL_MS</key>
    <string>${TICKET_DISPATCH_POLL_INTERVAL_MS:-5000}</string>
    <key>TICKET_NOTIFY_POLL_INTERVAL_MS</key>
    <string>${TICKET_NOTIFY_POLL_INTERVAL_MS:-5000}</string>
    <key>TICKET_AUDIT_POLL_INTERVAL_MS</key>
    <string>${TICKET_AUDIT_POLL_INTERVAL_MS:-30000}</string>
    <key>TICKET_DELIVERY_TIMEOUT_MS</key>
    <string>${TICKET_DELIVERY_TIMEOUT_MS:-30000}</string>
    <key>TICKET_API_PORT</key>
    <string>${TICKET_API_PORT:-8788}</string>
    <key>TICKET_API_BIND_HOST</key>
    <string>${TICKET_API_BIND_HOST:-127.0.0.1}</string>
    <key>TICKET_API_LOCAL_BASE_URL</key>
    <string>${TICKET_API_LOCAL_BASE_URL:-http://127.0.0.1:${TICKET_API_PORT:-8788}}</string>
    <key>TICKET_API_HEALTHCHECK_BASE_URL</key>
    <string>${TICKET_API_HEALTHCHECK_BASE_URL:-http://127.0.0.1:${TICKET_API_PORT:-8788}}</string>
    <key>TICKET_BACKUP_BEFORE_START</key>
    <string>${TICKET_BACKUP_BEFORE_START:-true}</string>
    <key>NODE_BIN</key>
    <string>${NODE_BIN:-/opt/homebrew/bin/node}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/api.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/api.err.log</string>
</dict>
</plist>
PLIST
launchctl bootout gui/$(id -u) "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST_PATH"
launchctl kickstart -k gui/$(id -u)/$LAUNCH_LABEL
launchctl print gui/$(id -u)/$LAUNCH_LABEL | sed -n '1,80p'
