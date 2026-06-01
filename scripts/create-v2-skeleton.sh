#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="${1:-${REPO_DIR}-v2}"

mkdir -p "$TARGET_DIR"
/usr/bin/rsync -a \
  --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'data' \
  --exclude 'logs' \
  --exclude '.DS_Store' \
  "$REPO_DIR/" "$TARGET_DIR/"

mkdir -p "$TARGET_DIR/data" "$TARGET_DIR/logs" "$TARGET_DIR/tmp"
setopt NULL_GLOB
rm -f "$TARGET_DIR/data"/*.db "$TARGET_DIR/data"/*.db-shm "$TARGET_DIR/data"/*.db-wal 2>/dev/null || true
rm -f "$TARGET_DIR/logs"/*.log 2>/dev/null || true
unsetopt NULL_GLOB

if [[ ! -e "$TARGET_DIR/node_modules" ]]; then
  ln -s "$REPO_DIR/node_modules" "$TARGET_DIR/node_modules"
fi

cat > "$TARGET_DIR/scripts/run-api-v2.sh" <<'EOF'
#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
export TICKET_API_PORT="${TICKET_API_PORT:-8790}"
export TICKET_API_BIND_HOST="${TICKET_API_BIND_HOST:-127.0.0.1}"
export TICKETS_DB_PATH="${TICKETS_DB_PATH:-$REPO_DIR/data/tickets-v2.db}"
export TICKET_API_LOCAL_BASE_URL="${TICKET_API_LOCAL_BASE_URL:-http://127.0.0.1:${TICKET_API_PORT}}"
export TICKET_API_HEALTHCHECK_BASE_URL="${TICKET_API_HEALTHCHECK_BASE_URL:-http://127.0.0.1:${TICKET_API_PORT}}"
export TICKET_LAUNCHAGENT_LABEL="${TICKET_LAUNCHAGENT_LABEL:-ai.openclaw.ticket-platform-api-v2}"
export TICKET_API_LOG_DIR="${TICKET_API_LOG_DIR:-$REPO_DIR/logs}"
export TICKET_BACKUP_BEFORE_START="${TICKET_BACKUP_BEFORE_START:-false}"
export TICKET_INTERNAL_POLLERS_ENABLED="${TICKET_INTERNAL_POLLERS_ENABLED:-false}"
exec "$REPO_DIR/scripts/run-api.sh"
EOF
chmod +x "$TARGET_DIR/scripts/run-api-v2.sh"

cat > "$TARGET_DIR/scripts/install-launchagent-v2.sh" <<'EOF'
#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
export TICKET_LAUNCHAGENT_LABEL="${TICKET_LAUNCHAGENT_LABEL:-ai.openclaw.ticket-platform-api-v2}"
export TICKET_LAUNCHAGENT_PLIST_PATH="${TICKET_LAUNCHAGENT_PLIST_PATH:-$HOME/Library/LaunchAgents/${TICKET_LAUNCHAGENT_LABEL}.plist}"
export TICKET_API_PORT="${TICKET_API_PORT:-8790}"
export TICKET_API_BIND_HOST="${TICKET_API_BIND_HOST:-127.0.0.1}"
export TICKETS_DB_PATH="${TICKETS_DB_PATH:-$REPO_DIR/data/tickets-v2.db}"
export TICKET_API_LOCAL_BASE_URL="${TICKET_API_LOCAL_BASE_URL:-http://127.0.0.1:${TICKET_API_PORT}}"
export TICKET_API_HEALTHCHECK_BASE_URL="${TICKET_API_HEALTHCHECK_BASE_URL:-http://127.0.0.1:${TICKET_API_PORT}}"
export TICKET_API_LOG_DIR="${TICKET_API_LOG_DIR:-$REPO_DIR/logs}"
export TICKET_RUN_API_SCRIPT="${TICKET_RUN_API_SCRIPT:-$REPO_DIR/scripts/run-api-v2.sh}"
export TICKET_BACKUP_BEFORE_START="${TICKET_BACKUP_BEFORE_START:-false}"
export TICKET_INTERNAL_POLLERS_ENABLED="${TICKET_INTERNAL_POLLERS_ENABLED:-false}"
exec "$REPO_DIR/scripts/install-launchagent.sh"
EOF
chmod +x "$TARGET_DIR/scripts/install-launchagent-v2.sh"

cat > "$TARGET_DIR/scripts/uninstall-launchagent-v2.sh" <<'EOF'
#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
export TICKET_LAUNCHAGENT_LABEL="${TICKET_LAUNCHAGENT_LABEL:-ai.openclaw.ticket-platform-api-v2}"
export TICKET_LAUNCHAGENT_PLIST_PATH="${TICKET_LAUNCHAGENT_PLIST_PATH:-$HOME/Library/LaunchAgents/${TICKET_LAUNCHAGENT_LABEL}.plist}"
exec "$REPO_DIR/scripts/uninstall-launchagent.sh"
EOF
chmod +x "$TARGET_DIR/scripts/uninstall-launchagent-v2.sh"

cat > "$TARGET_DIR/README-v2.md" <<'EOF'
# ticket-platform v2 并行骨架

## 运行隔离
- 目录：`agent-ticket-system-v2`
- 端口：默认 `8790`
- DB：`data/tickets-v2.db`
- 日志：`logs/api.out.log` / `logs/api.err.log`
- LaunchAgent：`ai.openclaw.ticket-platform-api-v2`
- Poller：默认关闭（`TICKET_INTERNAL_POLLERS_ENABLED=false`），避免影响现网 8788

## 启动
```bash
cd /Users/ronghui/Projects/agent-ticket-system-v2
./scripts/run-api-v2.sh
```

## LaunchAgent 安装
```bash
cd /Users/ronghui/Projects/agent-ticket-system-v2
./scripts/install-launchagent-v2.sh
```

## 停止/卸载
```bash
cd /Users/ronghui/Projects/agent-ticket-system-v2
./scripts/uninstall-launchagent-v2.sh
```
EOF

echo "Created v2 skeleton at: $TARGET_DIR"
echo "node_modules -> $(readlink "$TARGET_DIR/node_modules")"
