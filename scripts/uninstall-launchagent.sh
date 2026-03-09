#!/bin/zsh
set -euo pipefail
PLIST_PATH="$HOME/Library/LaunchAgents/ai.openclaw.ticket-platform-api.plist"
launchctl bootout gui/$(id -u) "$PLIST_PATH" 2>/dev/null || true
rm -f "$PLIST_PATH"
echo "Removed $PLIST_PATH"
