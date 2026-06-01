#!/bin/zsh
set -euo pipefail
LAUNCH_LABEL="${TICKET_LAUNCHAGENT_LABEL:-ai.openclaw.ticket-platform-api-v2}"
PLIST_PATH="${TICKET_LAUNCHAGENT_PLIST_PATH:-$HOME/Library/LaunchAgents/${LAUNCH_LABEL}.plist}"
launchctl bootout gui/$(id -u) "$PLIST_PATH" 2>/dev/null || true
rm -f "$PLIST_PATH"
echo "Removed $PLIST_PATH"
