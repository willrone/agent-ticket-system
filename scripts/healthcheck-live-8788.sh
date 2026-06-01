#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

API_BASE_URL="${TICKET_API_HEALTHCHECK_BASE_URL:-${TICKET_API_LOCAL_BASE_URL:-http://127.0.0.1:8788}}"
LAUNCH_LABEL="${TICKET_LAUNCHAGENT_LABEL:-ai.openclaw.ticket-platform-api}"
PLIST_PATH="${TICKET_LAUNCHAGENT_PLIST_PATH:-$HOME/Library/LaunchAgents/${LAUNCH_LABEL}.plist}"
OUT_LOG="${TICKET_API_OUT_LOG:-$REPO_DIR/logs/api.out.log}"
ERR_LOG="${TICKET_API_ERR_LOG:-$REPO_DIR/logs/api.err.log}"
EXPECTED_SKILL_VERSION="${TICKET_EXPECTED_SKILL_VERSION:-}"
EXPECTED_SKILL_CHECKSUM="${TICKET_EXPECTED_SKILL_CHECKSUM:-}"
TAIL_LINES="${TICKET_HEALTHCHECK_TAIL_LINES:-80}"
ERR_STALE_MINUTES="${TICKET_HEALTHCHECK_ERR_STALE_MINUTES:-60}"
RUN_FIXTURE_VALIDATE="${TICKET_HEALTHCHECK_VALIDATE_FIXTURES:-0}"
RUN_FIXTURE_REPLAY="${TICKET_HEALTHCHECK_REPLAY_FIXTURES:-0}"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

PASS_ITEMS=()
WARN_ITEMS=()
FAIL_ITEMS=()

record_pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  PASS_ITEMS+=("$1")
}

record_warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  WARN_ITEMS+=("$1")
}

record_fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAIL_ITEMS+=("$1")
}

json_get() {
  python3 - "$1" "$2" <<'PY'
import json, sys
raw = sys.argv[1]
path = [p for p in sys.argv[2].split('.') if p]
obj = json.loads(raw)
for part in path:
    if isinstance(obj, dict):
        obj = obj.get(part)
    elif isinstance(obj, list) and part.isdigit():
        idx = int(part)
        obj = obj[idx] if 0 <= idx < len(obj) else None
    else:
        obj = None
        break
if obj is None:
    print('')
elif isinstance(obj, (dict, list)):
    print(json.dumps(obj, ensure_ascii=False))
else:
    print(obj)
PY
}

fetch_json() {
  curl -fsS --max-time 8 "$1"
}

file_mtime_epoch() {
  local file_path="$1"
  /usr/bin/stat -f '%m' "$file_path" 2>/dev/null || true
}

file_mtime_human() {
  local file_path="$1"
  /usr/bin/stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$file_path" 2>/dev/null || true
}

process_start_info() {
  python3 - "$1" <<'PY'
import datetime
import subprocess
import sys

pid = sys.argv[1]
if not pid:
    print('\t')
    raise SystemExit(0)
try:
    out = subprocess.check_output(['ps', '-p', pid, '-o', 'lstart='], text=True).strip()
except Exception:
    print('\t')
    raise SystemExit(0)
if not out:
    print('\t')
    raise SystemExit(0)
try:
    dt = datetime.datetime.strptime(out, '%a %b %d %H:%M:%S %Y')
except ValueError:
    print(f'\t{out}')
    raise SystemExit(0)
print(f'{int(dt.timestamp())}\t{out}')
PY
}

print_section() {
  echo
  echo "== $1 =="
}

print_items() {
  local label="$1"
  shift
  local -a items=("$@")
  if (( ${#items[@]} == 0 )); then
    return
  fi
  echo "$label"
  local item
  for item in "${items[@]}"; do
    echo "- $item"
  done
}

resolve_bin() {
  local name="$1"
  shift
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  local candidate
  for candidate in "$@"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

extract_launch_value() {
  local text="$1"
  local key="$2"
  printf '%s\n' "$text" | awk -F' = ' -v prefix="$key" '$1 ~ prefix { print $2; exit }'
}

extract_launch_env_value() {
  local text="$1"
  local key="$2"
  printf '%s\n' "$text" | awk -v key="$key" '
    $1 == key && $2 == "=>" {
      $1=""; $2="";
      sub(/^[[:space:]]+/, "");
      print;
      exit;
    }
  '
}

LIVE_REPO_DIR="$REPO_DIR"
LIVE_OUT_LOG="$OUT_LOG"
LIVE_ERR_LOG="$ERR_LOG"
LIVE_PORT="8788"
LIVE_INTERNAL_POLLERS_ENABLED=""
LIVE_DIST_INDEX="$LIVE_REPO_DIR/dist/index.html"
ROOT_OK=0
ROOT_HTML_OK=0

print_section "ticket-platform live 8788 healthcheck"
echo "repo=$REPO_DIR"
echo "api_base_url=$API_BASE_URL"
echo "launch_label=$LAUNCH_LABEL"

if [[ -f "$PLIST_PATH" ]]; then
  record_pass "LaunchAgent plist 存在：$PLIST_PATH"
else
  record_warn "LaunchAgent plist 不存在：$PLIST_PATH（可能尚未安装 ./scripts/install-launchagent.sh）"
fi

LAUNCH_PRINT=""
if launchctl print "gui/$(id -u)/$LAUNCH_LABEL" >/tmp/ticket-launchagent-print.$$ 2>/tmp/ticket-launchagent-print.err.$$; then
  LAUNCH_PRINT="$(cat /tmp/ticket-launchagent-print.$$)"
  record_pass "LaunchAgent 已加载：$LAUNCH_LABEL"
  if echo "$LAUNCH_PRINT" | rg -q 'state = running'; then
    record_pass "LaunchAgent state=running"
  else
    record_warn "LaunchAgent 已加载但 state 非 running；请检查 launchctl print gui/$(id -u)/$LAUNCH_LABEL"
  fi

  LAUNCH_WORKDIR="$(extract_launch_value "$LAUNCH_PRINT" '^[[:space:]]*working directory')"
  LAUNCH_OUT_LOG="$(extract_launch_value "$LAUNCH_PRINT" '^[[:space:]]*stdout path')"
  LAUNCH_ERR_LOG="$(extract_launch_value "$LAUNCH_PRINT" '^[[:space:]]*stderr path')"
  LAUNCH_PORT="$(extract_launch_env_value "$LAUNCH_PRINT" 'TICKET_API_PORT')"
  LIVE_INTERNAL_POLLERS_ENABLED="$(extract_launch_env_value "$LAUNCH_PRINT" 'TICKET_INTERNAL_POLLERS_ENABLED')"

  if [[ -n "$LAUNCH_WORKDIR" ]]; then
    LIVE_REPO_DIR="$LAUNCH_WORKDIR"
    LIVE_DIST_INDEX="$LIVE_REPO_DIR/dist/index.html"
    if [[ "$LIVE_REPO_DIR" == "$REPO_DIR" ]]; then
      record_pass "live working directory 与当前 repo 一致：$LIVE_REPO_DIR"
    else
      record_pass "live working directory 已解析：$LIVE_REPO_DIR"
    fi
  fi
  if [[ -n "$LAUNCH_OUT_LOG" ]]; then
    LIVE_OUT_LOG="$LAUNCH_OUT_LOG"
    record_pass "live stdout 日志路径：$LIVE_OUT_LOG"
  fi
  if [[ -n "$LAUNCH_ERR_LOG" ]]; then
    LIVE_ERR_LOG="$LAUNCH_ERR_LOG"
    record_pass "live stderr 日志路径：$LIVE_ERR_LOG"
  fi
  if [[ -n "$LAUNCH_PORT" ]]; then
    LIVE_PORT="$LAUNCH_PORT"
    record_pass "live 监听端口来自 LaunchAgent 环境：$LIVE_PORT"
  fi
else
  LAUNCH_ERR="$(cat /tmp/ticket-launchagent-print.err.$$ 2>/dev/null || true)"
  record_fail "LaunchAgent 未加载：$LAUNCH_LABEL${LAUNCH_ERR:+；$LAUNCH_ERR}"
fi
rm -f /tmp/ticket-launchagent-print.$$ /tmp/ticket-launchagent-print.err.$$

if ROOT_HEADERS="$(curl -fsSI --max-time 8 "$API_BASE_URL/" 2>/tmp/ticket-root.err.$$)"; then
  ROOT_OK=1
  record_pass "root page 可达：$API_BASE_URL/"
  if echo "$ROOT_HEADERS" | rg -qi '^content-type: text/html'; then
    record_pass "root page content-type=text/html"
  else
    record_warn "root page content-type 非 text/html"
  fi
else
  ROOT_ERR="$(cat /tmp/ticket-root.err.$$ 2>/dev/null || true)"
  record_fail "root page 不可达：$API_BASE_URL/${ROOT_ERR:+；$ROOT_ERR}"
fi
rm -f /tmp/ticket-root.err.$$

if ROOT_HTML="$(curl -fsS --max-time 8 "$API_BASE_URL/" 2>/tmp/ticket-root-body.err.$$)"; then
  if echo "$ROOT_HTML" | rg -q '<div id="root"></div>'; then
    ROOT_HTML_OK=1
    record_pass "root HTML 含 app mount 节点"
  else
    record_warn "root HTML 缺少预期 app mount 节点"
  fi
else
  ROOT_BODY_ERR="$(cat /tmp/ticket-root-body.err.$$ 2>/dev/null || true)"
  record_fail "root HTML 拉取失败${ROOT_BODY_ERR:+；$ROOT_BODY_ERR}"
fi
rm -f /tmp/ticket-root-body.err.$$

if [[ -f "$LIVE_DIST_INDEX" ]]; then
  record_pass "live dist/index.html 存在：$LIVE_DIST_INDEX"
else
  record_fail "live dist/index.html 不存在：$LIVE_DIST_INDEX"
fi

if VERSION_JSON="$(fetch_json "$API_BASE_URL/api/version" 2>/tmp/ticket-api-version.err.$$)"; then
  SCHEMA_VERSION="$(json_get "$VERSION_JSON" 'data.schema_version')"
  BUNDLE_VERSION="$(json_get "$VERSION_JSON" 'data.bundle_version')"
  GIT_COMMIT="$(json_get "$VERSION_JSON" 'data.git_commit')"
  record_pass "live 8788 可达：/api/version schema=$SCHEMA_VERSION bundle=$BUNDLE_VERSION commit=${GIT_COMMIT:-none}"
else
  ERR_MSG="$(cat /tmp/ticket-api-version.err.$$ 2>/dev/null || true)"
  record_fail "live 8788 不可达：$API_BASE_URL/api/version${ERR_MSG:+；$ERR_MSG}"
fi
rm -f /tmp/ticket-api-version.err.$$

if [[ -n "${VERSION_JSON:-}" ]]; then
  if SKILL_JSON="$(fetch_json "$API_BASE_URL/api/v1/agent/skills/current" 2>/tmp/ticket-skill.err.$$)"; then
    SKILL_VERSION="$(json_get "$SKILL_JSON" 'data.version')"
    SKILL_CHECKSUM="$(json_get "$SKILL_JSON" 'data.checksum_sha256')"
    record_pass "hosted skill 可读：version=$SKILL_VERSION checksum=$SKILL_CHECKSUM"
    if [[ -n "$EXPECTED_SKILL_VERSION" && "$SKILL_VERSION" != "$EXPECTED_SKILL_VERSION" ]]; then
      record_fail "skills/current version 漂移：expected=$EXPECTED_SKILL_VERSION actual=$SKILL_VERSION"
    fi
    if [[ -n "$EXPECTED_SKILL_CHECKSUM" && "$SKILL_CHECKSUM" != "$EXPECTED_SKILL_CHECKSUM" ]]; then
      record_fail "skills/current checksum 漂移：expected=$EXPECTED_SKILL_CHECKSUM actual=$SKILL_CHECKSUM"
    fi
  else
    ERR_MSG="$(cat /tmp/ticket-skill.err.$$ 2>/dev/null || true)"
    record_fail "无法读取 hosted skill：/api/v1/agent/skills/current${ERR_MSG:+；$ERR_MSG}"
  fi
  rm -f /tmp/ticket-skill.err.$$

  if PLAYBOOK_JSON="$(fetch_json "$API_BASE_URL/api/v1/agent/playbooks/ticket-handler" 2>/tmp/ticket-playbook.err.$$)"; then
    PLAYBOOK_VERSION="$(json_get "$PLAYBOOK_JSON" 'data.version')"
    PLAYBOOK_CHECKSUM="$(json_get "$PLAYBOOK_JSON" 'data.checksum_sha256')"
    record_pass "hosted playbook 可读：version=$PLAYBOOK_VERSION checksum=$PLAYBOOK_CHECKSUM"
    if [[ -n "${SKILL_CHECKSUM:-}" && "$PLAYBOOK_CHECKSUM" != "$SKILL_CHECKSUM" ]]; then
      record_fail "skills/current 与 playbook/ticket-handler checksum 不一致：skill=$SKILL_CHECKSUM playbook=$PLAYBOOK_CHECKSUM"
    fi
    if [[ -n "${SKILL_VERSION:-}" && "$PLAYBOOK_VERSION" != "$SKILL_VERSION" ]]; then
      record_warn "skills/current 与 playbook/ticket-handler version 不一致：skill=$SKILL_VERSION playbook=$PLAYBOOK_VERSION"
    fi
  else
    ERR_MSG="$(cat /tmp/ticket-playbook.err.$$ 2>/dev/null || true)"
    record_fail "无法读取 hosted playbook：/api/v1/agent/playbooks/ticket-handler${ERR_MSG:+；$ERR_MSG}"
  fi
  rm -f /tmp/ticket-playbook.err.$$

  if RUNTIME_JSON="$(fetch_json "$API_BASE_URL/api/v1/agent/runtime/context" 2>/tmp/ticket-runtime.err.$$)"; then
    RUNTIME_SKILL_CHECKSUM="$(json_get "$RUNTIME_JSON" 'data.skill_ref.checksum_sha256')"
    RUNTIME_PLAYBOOK_CHECKSUM="$(json_get "$RUNTIME_JSON" 'data.playbook_ref.checksum_sha256')"
    CANONICAL_PREFIX="$(json_get "$RUNTIME_JSON" 'data.namespace.canonical_prefix')"
    record_pass "runtime context 可读：canonical_prefix=$CANONICAL_PREFIX"
    if [[ -n "${SKILL_CHECKSUM:-}" && "$RUNTIME_SKILL_CHECKSUM" != "$SKILL_CHECKSUM" ]]; then
      record_fail "runtime context skill_ref checksum 与 hosted skill 不一致：runtime=$RUNTIME_SKILL_CHECKSUM skill=$SKILL_CHECKSUM"
    fi
    if [[ -n "${PLAYBOOK_CHECKSUM:-}" && "$RUNTIME_PLAYBOOK_CHECKSUM" != "$PLAYBOOK_CHECKSUM" ]]; then
      record_fail "runtime context playbook_ref checksum 与 hosted playbook 不一致：runtime=$RUNTIME_PLAYBOOK_CHECKSUM playbook=$PLAYBOOK_CHECKSUM"
    fi
  else
    ERR_MSG="$(cat /tmp/ticket-runtime.err.$$ 2>/dev/null || true)"
    record_fail "无法读取 runtime context：/api/v1/agent/runtime/context${ERR_MSG:+；$ERR_MSG}"
  fi
  rm -f /tmp/ticket-runtime.err.$$

  if WORKFLOW_JSON="$(fetch_json "$API_BASE_URL/api/workflow/schema" 2>/tmp/ticket-workflow.err.$$)"; then
    WORKFLOW_VERSION="$(json_get "$WORKFLOW_JSON" 'data.schema_version')"
    WORKFLOW_STATUS_0="$(json_get "$WORKFLOW_JSON" 'data.statuses.0.status')"
    if [[ -n "$WORKFLOW_VERSION" ]]; then
      record_pass "workflow schema 可读：schema_version=$WORKFLOW_VERSION"
    elif [[ -n "$WORKFLOW_STATUS_0" ]]; then
      record_pass "workflow schema 可读：statuses[0]=$WORKFLOW_STATUS_0"
    else
      record_warn "workflow schema 可达，但未读到 schema_version/statuses"
    fi
  else
    ERR_MSG="$(cat /tmp/ticket-workflow.err.$$ 2>/dev/null || true)"
    record_fail "无法读取 workflow schema：/api/workflow/schema${ERR_MSG:+；$ERR_MSG}"
  fi
  rm -f /tmp/ticket-workflow.err.$$

  if DISPATCH_JSON="$(fetch_json "$API_BASE_URL/api/dispatch/ready" 2>/tmp/ticket-dispatch.err.$$)"; then
    DISPATCH_REQUEST_ID="$(json_get "$DISPATCH_JSON" 'request_id')"
    DISPATCH_READY_0="$(json_get "$DISPATCH_JSON" 'ready.0.dispatch_id')"
    record_pass "dispatch ready 可读"
    if [[ -n "$DISPATCH_READY_0" && -z "$DISPATCH_REQUEST_ID" ]]; then
      record_warn "dispatch ready 非空但缺 request_id；需核对 request-id contract"
    fi
  else
    ERR_MSG="$(cat /tmp/ticket-dispatch.err.$$ 2>/dev/null || true)"
    record_fail "无法读取 dispatch ready：/api/dispatch/ready${ERR_MSG:+；$ERR_MSG}"
  fi
  rm -f /tmp/ticket-dispatch.err.$$

  if NOTIFY_JSON="$(fetch_json "$API_BASE_URL/api/notifications/ready" 2>/tmp/ticket-notify.err.$$)"; then
    NOTIFY_REQUEST_ID="$(json_get "$NOTIFY_JSON" 'request_id')"
    NOTIFY_READY_0="$(json_get "$NOTIFY_JSON" 'ready.0.event_id')"
    record_pass "notifications ready 可读"
    if [[ -n "$NOTIFY_READY_0" && -z "$NOTIFY_REQUEST_ID" ]]; then
      record_warn "notifications ready 非空但缺 request_id；需核对 request-id contract"
    fi
  else
    ERR_MSG="$(cat /tmp/ticket-notify.err.$$ 2>/dev/null || true)"
    record_fail "无法读取 notifications ready：/api/notifications/ready${ERR_MSG:+；$ERR_MSG}"
  fi
  rm -f /tmp/ticket-notify.err.$$
fi

LSOF_BIN="$(resolve_bin lsof /usr/sbin/lsof /usr/bin/lsof /opt/homebrew/bin/lsof || true)"
SS_BIN="$(resolve_bin ss /usr/sbin/ss /usr/bin/ss /opt/homebrew/bin/ss || true)"
NETSTAT_BIN="$(resolve_bin netstat /usr/sbin/netstat /usr/bin/netstat || true)"

PORT_COUNT=""
PORT_DESC=""
LIVE_LISTEN_PID=""
LIVE_SERVER_STARTED_EPOCH=""
LIVE_SERVER_STARTED_AT=""
if [[ -n "$LSOF_BIN" ]]; then
  if "$LSOF_BIN" -nP -iTCP:${LIVE_PORT} -sTCP:LISTEN >/tmp/ticket-port-live.$$ 2>/dev/null; then
    PORT_LINES="$(tail -n +2 /tmp/ticket-port-live.$$ || true)"
    PORT_COUNT="$(echo "$PORT_LINES" | sed '/^$/d' | wc -l | tr -d ' ')"
    PORT_DESC="$(echo "$PORT_LINES" | head -n 1 | awk '{print $1" pid=" $2" user=" $3}')"
    LIVE_LISTEN_PID="$(echo "$PORT_LINES" | head -n 1 | awk '{print $2}')"
  fi
  rm -f /tmp/ticket-port-live.$$
elif [[ -n "$SS_BIN" ]]; then
  PORT_LINES="$("$SS_BIN" -ltnp "( sport = :${LIVE_PORT} )" 2>/dev/null | tail -n +2 || true)"
  PORT_COUNT="$(echo "$PORT_LINES" | sed '/^$/d' | wc -l | tr -d ' ')"
  PORT_DESC="$(echo "$PORT_LINES" | head -n 1)"
  LIVE_LISTEN_PID="$(echo "$PORT_LINES" | head -n 1 | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p')"
elif [[ -n "$NETSTAT_BIN" ]]; then
  PORT_LINES="$("$NETSTAT_BIN" -anv -p tcp 2>/dev/null | rg "\\.${LIVE_PORT} .*LISTEN" || true)"
  PORT_COUNT="$(echo "$PORT_LINES" | sed '/^$/d' | wc -l | tr -d ' ')"
  PORT_DESC="$(echo "$PORT_LINES" | head -n 1 | sed 's/^[[:space:]]*//')"
else
  record_warn "系统缺少 lsof/ss/netstat，跳过 ${LIVE_PORT} LISTEN 精确探测"
fi
if [[ -n "$PORT_COUNT" ]]; then
  if [[ "$PORT_COUNT" == "1" ]]; then
    record_pass "${LIVE_PORT} 仅有 1 个 LISTEN 进程：$PORT_DESC"
  else
    record_fail "${LIVE_PORT} 存在多个 LISTEN 进程（疑似旧手工进程/重复接管）：count=$PORT_COUNT"
  fi
fi

NODE_SERVER_MATCHES="$(pgrep -fal 'node .*api/server\.js' || true)"
if [[ -n "$NODE_SERVER_MATCHES" ]]; then
  if [[ -n "$LIVE_LISTEN_PID" ]]; then
    LIVE_NODE_SERVER_MATCH="$(printf '%s\n' "$NODE_SERVER_MATCHES" | awk -v pid="$LIVE_LISTEN_PID" '$1 == pid { print; exit }')"
    if [[ -n "$LIVE_NODE_SERVER_MATCH" ]]; then
      IFS=$'\t' read -r LIVE_SERVER_STARTED_EPOCH LIVE_SERVER_STARTED_AT <<< "$(process_start_info "$LIVE_LISTEN_PID")"
      record_pass "live api/server.js 进程已锁定到 ${LIVE_PORT}：$LIVE_NODE_SERVER_MATCH"
      OTHER_NODE_SERVER_COUNT="$(printf '%s\n' "$NODE_SERVER_MATCHES" | awk -v pid="$LIVE_LISTEN_PID" '$1 != pid' | sed '/^$/d' | wc -l | tr -d ' ')"
      if [[ "$OTHER_NODE_SERVER_COUNT" != "0" ]]; then
        record_warn "检测到其他 api/server.js 进程，但未占用 live ${LIVE_PORT}（多半是 8790/8791 shadow 并存）"
      fi
    else
      record_fail "${LIVE_PORT} 的监听 PID=$LIVE_LISTEN_PID 不是 api/server.js；需核对 live 接管进程"
    fi
  else
    MATCH_COUNT="$(echo "$NODE_SERVER_MATCHES" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [[ "$MATCH_COUNT" == "1" ]]; then
      record_pass "api/server.js 进程唯一：$(echo "$NODE_SERVER_MATCHES" | head -n 1)"
    else
      record_fail "发现多个 api/server.js 进程（无法关联 live ${LIVE_PORT}；需人工核对是否 shadow 并存）：count=$MATCH_COUNT"
    fi
  fi
else
  record_fail "未发现 api/server.js 进程；疑似 live 未启动"
fi

if [[ -f "$LIVE_OUT_LOG" ]]; then
  OUT_TAIL="$(tail -n "$TAIL_LINES" "$LIVE_OUT_LOG" || true)"
  if printf '%s\n' "$OUT_TAIL" | rg -q '\[internal-poller\] started \(direct-drive\)'; then
    record_pass "live api.out.log 含 internal-poller started 记录"
  elif printf '%s\n' "$OUT_TAIL" | rg -q '\[(dispatch|notify|audit)/ready\]|\[internal-poller:(dispatch|notify|audit)\]'; then
    record_pass "live api.out.log 检测到 internal-poller 活动日志（started 行可能已被滚出窗口）"
  elif [[ "$LIVE_INTERNAL_POLLERS_ENABLED" == "true" ]]; then
    record_warn "live api.out.log 未见 internal-poller 启动/活动记录；需核对日志窗口或 poller 是否刚切换"
  else
    record_warn "LaunchAgent 未声明 TICKET_INTERNAL_POLLERS_ENABLED=true，跳过 poller started 严格校验"
  fi
else
  record_warn "缺少 stdout 日志：$LIVE_OUT_LOG"
fi

if [[ -f "$LIVE_ERR_LOG" ]]; then
  ERR_TAIL="$(tail -n "$TAIL_LINES" "$LIVE_ERR_LOG" || true)"
  ERR_LOG_MTIME_EPOCH="$(file_mtime_epoch "$LIVE_ERR_LOG")"
  ERR_LOG_MTIME_AT="$(file_mtime_human "$LIVE_ERR_LOG")"
  INCIDENT_JSON="$(ERR_TAIL="$ERR_TAIL" ROOT_OK="$ROOT_OK" ROOT_HTML_OK="$ROOT_HTML_OK" DIST_INDEX_EXISTS="$([[ -f "$LIVE_DIST_INDEX" ]] && echo 1 || echo 0)" LIVE_REPO_EXISTS="$([[ -e "$LIVE_REPO_DIR/.git" ]] && echo 1 || echo 0)" ERR_LOG_MTIME_EPOCH="$ERR_LOG_MTIME_EPOCH" LIVE_SERVER_STARTED_EPOCH="$LIVE_SERVER_STARTED_EPOCH" ERR_STALE_MINUTES="$ERR_STALE_MINUTES" node --input-type=module <<'NODE'
import { classifyLogIncident } from './api/incident-classifier.js';
const result = classifyLogIncident({
  logTail: process.env.ERR_TAIL || '',
  rootOk: process.env.ROOT_OK === '1',
  rootHtmlOk: process.env.ROOT_HTML_OK === '1',
  distIndexExists: process.env.DIST_INDEX_EXISTS === '1',
  liveRepoExists: process.env.LIVE_REPO_EXISTS === '1',
  errLogMtimeEpoch: process.env.ERR_LOG_MTIME_EPOCH || null,
  liveServerStartedEpoch: process.env.LIVE_SERVER_STARTED_EPOCH || null,
  staleMinutes: Number(process.env.ERR_STALE_MINUTES || 60),
});
console.log(JSON.stringify(result));
NODE
)"
  INCIDENT_VERDICT="$(printf '%s' "$INCIDENT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("verdict",""))')"
  INCIDENT_CATEGORY="$(printf '%s' "$INCIDENT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("category",""))')"
  INCIDENT_SUMMARY="$(printf '%s' "$INCIDENT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("summary",""))')"
  INCIDENT_SIGNAL_COUNT="$(printf '%s' "$INCIDENT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("signal_count",0))')"
  INCIDENT_SILENT_MINUTES="$(printf '%s' "$INCIDENT_JSON" | python3 -c 'import json,sys; v=json.load(sys.stdin).get("silent_minutes",""); print("" if v is None else v)')"

  if [[ "$INCIDENT_VERDICT" == "pass" ]]; then
    if [[ "$INCIDENT_CATEGORY" == "stale_history" ]]; then
      record_pass "live api.err.log incident classifier=$INCIDENT_CATEGORY（signals=$INCIDENT_SIGNAL_COUNT，last_write=${ERR_LOG_MTIME_AT:-unknown}，silent_minutes=${INCIDENT_SILENT_MINUTES:-n/a}）：$INCIDENT_SUMMARY"
    elif [[ "$INCIDENT_CATEGORY" == "known_noise" ]]; then
      record_pass "live api.err.log incident classifier=$INCIDENT_CATEGORY（signals=$INCIDENT_SIGNAL_COUNT）：$INCIDENT_SUMMARY"
    else
      record_pass "live api.err.log incident classifier=$INCIDENT_CATEGORY：$INCIDENT_SUMMARY"
    fi
  elif [[ "$INCIDENT_VERDICT" == "warn" ]]; then
    record_warn "live api.err.log incident classifier=$INCIDENT_CATEGORY（signals=$INCIDENT_SIGNAL_COUNT，last_write=${ERR_LOG_MTIME_AT:-unknown}）：$INCIDENT_SUMMARY"
  elif [[ "$INCIDENT_VERDICT" == "fail" ]]; then
    record_warn "live api.err.log incident classifier=$INCIDENT_CATEGORY（signals=$INCIDENT_SIGNAL_COUNT，last_write=${ERR_LOG_MTIME_AT:-unknown}）：$INCIDENT_SUMMARY；请查看 $LIVE_ERR_LOG"
  else
    record_pass "live api.err.log 最近 $TAIL_LINES 行未见明显异常信号"
  fi
else
  record_warn "缺少 stderr 日志：$LIVE_ERR_LOG"
fi

if [[ "$RUN_FIXTURE_VALIDATE" == "1" ]]; then
  if npm run validate:live-contract-fixtures >/tmp/ticket-fixture-validate.$$ 2>&1; then
    record_pass "validate:live-contract-fixtures 通过"
  else
    record_fail "validate:live-contract-fixtures 失败；见 /tmp/ticket-fixture-validate.$$"
  fi
fi

if [[ "$RUN_FIXTURE_REPLAY" == "1" ]]; then
  if npm run replay:live-contract-fixtures >/tmp/ticket-fixture-replay.$$ 2>&1; then
    record_pass "replay:live-contract-fixtures 通过"
  else
    record_fail "replay:live-contract-fixtures 失败；见 /tmp/ticket-fixture-replay.$$"
  fi
fi

print_section "summary"
echo "PASS=$PASS_COUNT WARN=$WARN_COUNT FAIL=$FAIL_COUNT"
print_items 'PASS:' "${PASS_ITEMS[@]}"
print_items 'WARN:' "${WARN_ITEMS[@]}"
print_items 'FAIL:' "${FAIL_ITEMS[@]}"

print_section "triage hints"
if (( FAIL_COUNT > 0 )); then
  echo "FAIL：优先排查 live 未接管 / 旧进程占端口 / checksum 漂移。"
  echo "- live 8788 不可达：先看 $LIVE_OUT_LOG / $LIVE_ERR_LOG，再执行 launchctl print gui/$(id -u)/$LAUNCH_LABEL"
  echo "- ${LIVE_PORT} 多进程或多 LISTEN：通常是 LaunchAgent 与手工 node api/server.js 并存；先识别再手动清理旧进程"
  echo "- checksum 不一致：大概率 repo 已更新但 live 未 reload，或旧进程仍占着 ${LIVE_PORT}"
fi
if (( WARN_COUNT > 0 )); then
  echo "WARN：多为日志窗口、request_id 缺失、近期错误放量或 live 尚未 reload，需人工复核。"
fi
if (( FAIL_COUNT == 0 && WARN_COUNT == 0 )); then
  echo "PASS：live contract / poller / LaunchAgent / 8788 接管面未见明显异常。"
fi

if (( FAIL_COUNT > 0 )); then
  exit 2
elif (( WARN_COUNT > 0 )); then
  exit 1
else
  exit 0
fi
