# Platform Empty-State Onboarding

_Last updated: 2026-06-02_

This guide answers: **if this is a brand-new ticket platform with no connected agents yet, how do we register the smallest useful agent set and verify routing before real work starts?**

It is intentionally operational and template-driven. For the broader long-term design, see `docs/multi-agent-platform-design-v1.md`.

The commands below are templates for an API that is already running and reachable. This guide does not require starting or stopping the platform; if the platform is stopped, keep this as configuration material until an operator brings the API up.

## 0. Current implementation status

The platform already exposes a minimal role/domain registry surface:

- `GET /api/v1/platform/describe`
- `GET /api/v1/registry/roles`
- `GET /api/v1/registry/domains`
- `POST /api/v1/registry/domains`
- `POST /api/v1/registry/agents/register`
- `POST /api/v1/registry/agents/heartbeat`
- `POST /api/v1/registry/resolve`

It also projects registered agents into the agent-facing participant registry:

- `GET /api/v1/agent/participants`
- `GET /api/v1/agent/routing/resolve`

Important current limitation:

- `POST /api/v1/registry/agents/register` records the agent in the runtime registration map and upserts a participant projection.
- The runtime registration map is process memory; after API restart, agents should re-register or send heartbeat again before registry `/resolve` is trusted.
- The participant projection persists in SQLite, but `/api/v1/registry/resolve` currently selects from the in-memory registered-agent map.
- Domain creation currently uses `X-Platform-Token: dev-platform-token`. Treat this as development/bootstrap-only until a real platform admin auth contract replaces it.

Tool preference:

- When an agent is already running inside OpenClaw/MCP, prefer the available ticket-platform tool or MCP wrapper.
- The registry bootstrap examples use raw HTTP because an empty platform often has no agent tools wired yet.
- For first assignment writeback after the smoke ticket, switch back to OpenClaw/MCP where available; see `docs/agent-first-run-guide.md`.

## 1. Empty-state checklist

A usable empty platform needs at least:

1. One domain, e.g. `ticket-platform`.
2. One triage/manager agent.
3. One executor agent.
4. One reviewer agent.
5. Optional auditor agent.
6. A gateway/session binding for each non-human agent.
7. A route resolve smoke test for each role.
8. A first ticket smoke test only after routing is healthy.

Do not create the smoke ticket until these checks pass:

- `GET /api/v1/registry/domains` contains the target domain.
- `POST /api/v1/registry/resolve` returns a non-null `resolved_agent` for executor and reviewer.
- `GET /api/v1/agent/participants?participant_id=...` shows the registered agent projection.
- If the API restarted since registration, agents have re-registered or heartbeated again.

Minimal single-agent platform is allowed for development:

```text
agent alpha = triage + executor + reviewer
```

But production should avoid self-review:

```text
planner/triage != executor != reviewer, whenever possible
```

For a copyable machine-readable payload set, see `docs/examples/empty-platform-first-run-payloads.json`.

## 2. Discover baseline platform contract

```bash
curl -s http://127.0.0.1:8788/api/v1/platform/describe | jq .
curl -s http://127.0.0.1:8788/api/v1/registry/roles | jq .
curl -s http://127.0.0.1:8788/api/v1/registry/domains | jq .
```

Expected built-in roles:

- `triage`
- `executor`
- `reviewer`
- `audit`
- `manager`

Expected built-in domains include:

- `ticket-platform`
- `stock-platform`

## 3. Optional: create a new domain

If your platform domain does not exist, create it first.

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/registry/domains \
  -H 'Content-Type: application/json' \
  -H 'X-Platform-Token: dev-platform-token' \
  -d '{
    "key": "example-platform",
    "label": "Example Platform",
    "description": "Example empty-state onboarding domain",
    "enabled_roles": ["triage", "executor", "reviewer", "audit", "manager"]
  }' | jq .
```

Use a real admin token contract before exposing this outside trusted local/bootstrap environments.

## 4. Register minimal agents

### 4.1 Triage / manager agent

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/registry/agents/register \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id": "planner01",
    "display_name": "Planner 01",
    "roles": ["triage", "manager"],
    "domains": ["ticket-platform"],
    "gateway": "mac-main",
    "session_binding": "agent:planner01:main",
    "capacity": 1,
    "priority": 100,
    "status": "online"
  }' | jq .
```

### 4.2 Executor agent

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/registry/agents/register \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id": "executor01",
    "display_name": "Executor 01",
    "roles": ["executor"],
    "domains": ["ticket-platform"],
    "gateway": "mac-main",
    "session_binding": "agent:executor01:main",
    "capacity": 1,
    "priority": 100,
    "status": "online"
  }' | jq .
```

### 4.3 Reviewer agent

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/registry/agents/register \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id": "reviewer01",
    "display_name": "Reviewer 01",
    "roles": ["reviewer"],
    "domains": ["ticket-platform"],
    "gateway": "mac-main",
    "session_binding": "agent:reviewer01:main",
    "capacity": 1,
    "priority": 100,
    "status": "online"
  }' | jq .
```

### 4.4 Auditor agent, optional

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/registry/agents/register \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id": "auditor01",
    "display_name": "Auditor 01",
    "roles": ["audit"],
    "domains": ["ticket-platform"],
    "gateway": "mac-main",
    "session_binding": "agent:auditor01:main",
    "capacity": 1,
    "priority": 50,
    "status": "online"
  }' | jq .
```

## 5. Keep registrations fresh

Until registry persistence is promoted to full source-of-truth for `/api/v1/registry/resolve`, agents should heartbeat after startup and periodically while online.

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/registry/agents/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id": "executor01",
    "status": "online",
    "active_load": 0,
    "capacity": 1,
    "metadata": {
      "runtime": "openclaw",
      "session_binding": "agent:executor01:main"
    }
  }' | jq .
```

Recommended heartbeat timing for a simple integration:

- send once at agent runtime startup,
- send every 30-60 seconds while the agent is available,
- send `status=offline` or stop heartbeating when the agent is intentionally unavailable.

## 6. Verify route resolution

Executor:

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/registry/resolve \
  -H 'Content-Type: application/json' \
  -d '{
    "domain": "ticket-platform",
    "required_role": "executor"
  }' | jq .
```

Reviewer:

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/registry/resolve \
  -H 'Content-Type: application/json' \
  -d '{
    "domain": "ticket-platform",
    "required_role": "reviewer"
  }' | jq .
```

Triage:

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/registry/resolve \
  -H 'Content-Type: application/json' \
  -d '{
    "domain": "ticket-platform",
    "required_role": "triage"
  }' | jq .
```

Healthy result:

```json
{
  "data": {
    "resolved_agent": "executor01",
    "requested": {
      "domain": "ticket-platform",
      "required_role": "executor"
    },
    "candidates": [
      {
        "agent_id": "executor01",
        "roles": ["executor"],
        "domains": ["ticket-platform"],
        "status": "online"
      }
    ],
    "reason": "role+domain matched registered agent"
  }
}
```

Unhealthy-but-common result after a fresh API process:

```json
{
  "data": {
    "resolved_agent": null,
    "requested": {
      "domain": "ticket-platform",
      "required_role": "executor"
    },
    "candidates": [],
    "reason": "no role+domain matched registered agent"
  }
}
```

If participant projection still shows the agent but registry resolve returns no candidates, do not treat the persisted participant row as runtime-ready. Re-register the agent or send registry heartbeat again, then resolve again.

## 7. Verify participant projection

After registration, check that the agent appears in the agent-facing participant registry.

```bash
curl -s 'http://127.0.0.1:8788/api/v1/agent/participants?participant_id=executor01' | jq .
```

Check route resolution through the agent-facing bootstrap surface:

```bash
curl -s 'http://127.0.0.1:8788/api/v1/agent/routing/resolve?participant_id=executor01&platform_id=ticket-platform&role_key=executor&reason=empty-state-smoke' | jq .
```

This confirms that a future assignment can explain where the participant should be reached.

## 8. Create the first smoke ticket

Only after registration and route resolution pass, create a tiny smoke ticket.

If running inside OpenClaw, prefer the `ticket-platform__create_ticket` tool.

Raw HTTP fallback:

```bash
curl -s -X POST http://127.0.0.1:8788/api/v1/agent/tickets \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Empty-state routing smoke",
    "description": "Verify newly registered agent routing can receive and process a minimal ticket.",
    "platform": "ticket-platform",
    "triage_owner": "planner01",
    "assigned_agent": "executor01",
    "review_owner": "reviewer01"
  }' | jq .
```

Current rule: create should start at `triage`. Queue/start/review transitions should happen through controlled workflow actions/reports, not by creating directly into running/review/complete.

After the smoke ticket is created:

1. Use route/dispatch surfaces to deliver the assignment.
2. The receiving agent follows `docs/agent-first-run-guide.md`.
3. The first write should be `dispatch_receipt`, then heartbeat/report/action until the stage reaches the next clear state.

## 9. Minimal platform registration template

Use this object shape when integrating a new runtime:

```json
{
  "agent_id": "executor01",
  "display_name": "Executor 01",
  "roles": ["executor"],
  "domains": ["ticket-platform"],
  "gateway": "mac-main",
  "session_binding": "agent:executor01:main",
  "capacity": 1,
  "priority": 100,
  "status": "online"
}
```

Field notes:

| Field | Required | Meaning |
|---|---:|---|
| `agent_id` | yes | Stable lowercase id. |
| `display_name` | no | Human-readable label. |
| `roles` | yes | `triage`, `executor`, `reviewer`, `audit`, `manager`. |
| `domains` | yes | Work domains this agent accepts, e.g. `ticket-platform`. |
| `gateway` | recommended | Delivery gateway id, e.g. `mac-main`. |
| `session_binding` | recommended | Main session key/base used by delivery/router. |
| `capacity` | recommended | Max intended concurrent load. Enforcement is not complete yet. |
| `priority` | recommended | Higher priority wins route tie-breaks. |
| `status` | recommended | `online` or `offline`; offline agents are not selected by registry resolve. |

## 10. What is not enough yet

For a truly general new-platform onboarding experience, the current platform still needs improvements:

1. **Durable registration source of truth**
   - `/api/v1/registry/resolve` should be able to resolve from persisted participant registry after restart, or agents must be required to re-register on startup.
2. **Real platform-admin auth**
   - `X-Platform-Token: dev-platform-token` is a bootstrap placeholder.
3. **Documented gateway/session binding contract**
   - `gateway` and `session_binding` need a stricter schema and examples for OpenClaw local, remote gateway, ACP, and external service runtimes.
4. **First-ticket wizard**
   - A single command/API that creates a domain, registers triage/executor/reviewer, resolves routes, and creates a smoke ticket would reduce integration mistakes.
5. **UI empty state**
   - The UI should show: no agents registered -> register first agent -> verify route -> create first ticket.

Until those are implemented, this guide plus `docs/agent-first-run-guide.md` is the minimum safe operating procedure.

## 11. Related references

- New agent assignment guide: `docs/agent-first-run-guide.md`
- Machine-readable empty-state payloads: `docs/examples/empty-platform-first-run-payloads.json`
- Agent-facing API reference: `docs/reference/api.md`
- Current live contract: `docs/ticket-platform-current-state.md`
- Multi-agent platform design: `docs/multi-agent-platform-design-v1.md`
