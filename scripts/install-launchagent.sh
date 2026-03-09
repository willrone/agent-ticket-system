#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/ai.openclaw.ticket-platform-api.plist"
LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.ticket-platform-api</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$REPO_DIR/scripts/run-api.sh</string>
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
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>TICKETS_DB_PATH</key>
    <string>$REPO_DIR/data/tickets.db</string>
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
launchctl kickstart -k gui/$(id -u)/ai.openclaw.ticket-platform-api
launchctl print gui/$(id -u)/ai.openclaw.ticket-platform-api | sed -n '1,80p'
