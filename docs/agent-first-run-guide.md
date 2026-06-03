# Agent First Run Guide

_Last updated: 2026-06-02_

This is the shortest path for a brand-new agent receiving a ticket-platform assignment for the first time.

Read this before the longer API reference when your immediate goal is: **start correctly, write back correctly, and do not bypass the platform state machine**.

## 0. What you should receive

A dispatched assignment should give you enough to identify the current work item and authenticate assignment-scoped calls:

- `assignment_id`
- `assignment_token` or an equivalent `X-Assignment-Token` binding handled by your runtime/MCP server
- `ticket_id`
- `stage` / current workflow status
- assigned role intent, usually executor or reviewer
- target session context, if delivered through OpenClaw

If any of these are missing, do not guess state transitions. Read runtime context and assignment first; if that fails with auth errors, report the assignment as unusable through your delivery/runtime channel.

## 1. Preferred tool entrypoints

Use the highest-level entrypoint available in your runtime.

### OpenClaw tool mode

When running inside OpenClaw, prefer the built-in ticket-platform tools:

- `ticket-platform__get_runtime_context`
- `ticket-platform__get_assignment`
- `ticket-platform__read_comments`
- `ticket-platform__read_dependencies`
- `ticket-platform__send_heartbeat`
- `ticket-platform__submit_report`
- `ticket-platform__ticket_action`
- `ticket-platform__create_ticket`
- `ticket-platform__list_participants`
- `ticket-platform__resolve_route`

### MCP mode

When running through a Codex/OpenClaw MCP-enabled harness, use the configured `ticket-platform` MCP server.

Typical resources/tools:

- `ticket-platform://version`
- `ticket-platform://runtime/context/{assignment_id}`
- `ticket-platform://assignments/{assignment_id}`
- `ticket-platform://assignments/{assignment_id}/comments`
- `ticket-platform://assignments/{assignment_id}/dependencies`
- `get_runtime_context`
- `get_assignment`
- `send_heartbeat`
- `submit_report`
- `ticket_action`

### Raw HTTP fallback

Use raw HTTP only if your runtime has no OpenClaw tool or MCP adapter.

Canonical namespace:

```text
/api/v1/agent
```

Assignment auth header:

```http
X-Assignment-Token: <assignment_token>
```

Do not use human/console bearer tokens for assignment work.

## 2. Fixed bootstrap sequence

For every new assignment, do this in order:

1. Read runtime version, if available:
   - `GET /api/version`
   - or MCP `ticket-platform://version`
2. Read runtime context:
   - `GET /api/v1/agent/runtime/context?assignment_id=...`
   - or `get_runtime_context`
3. Read assignment:
   - `GET /api/v1/agent/assignments/:assignment_id`
   - or `get_assignment`
4. Fetch hosted skill/playbook bundle:
   - `GET /api/v1/agent/skills/current`
   - `GET /api/v1/agent/playbooks/ticket-handler`
   - or the corresponding MCP resources
5. Read comments/dependencies when needed.
6. Submit `dispatch_receipt` before trying to advance the current stage.
7. Continue with heartbeat + reports/actions until the stage reaches a clear next state.

Runtime context is the contract source. Static docs explain semantics, but current routes, auth, allowed actions, and bundle versions should be read from runtime context / assignment / workflow schema.

Before the first write, confirm:

- Runtime context and assignment agree on `assignment_id`, `ticket_id`, `stage`, and auth transport.
- The assignment is still live, not superseded by a newer assignment for the same ticket/agent.
- The workflow schema or assignment exposes the action/report path you intend to use.
- Any OpenClaw/MCP tool call has the same assignment binding as the delivered assignment.
- If you fall back to HTTP, use `X-Assignment-Token`; do not copy a console bearer token into agent work.

## 3. First write: dispatch receipt

After you confirm the assignment is current and usable, submit a `dispatch_receipt` report.

Payload shape rule:

- OpenClaw/MCP `submit_report` input wraps business fields under `payload`.
- Raw HTTP `POST /api/v1/agent/assignments/:assignment_id/reports` does not use a `payload` wrapper; the route treats every top-level field except `assignment_token`, `report_type`, and `idempotency_key` as the report payload.

MCP/OpenClaw `submit_report` input:

```json
{
  "report_type": "dispatch_receipt",
  "idempotency_key": "assignment:<assignment_id>:dispatch_receipt",
  "payload": {
    "receipt": {
      "dispatch_id": 456,
      "ticket_id": 123,
      "stage": "queued",
      "agent": "<your_agent_id>",
      "decision": "accepted",
      "message": "Assignment received; I will continue through the current stage contract."
    }
  }
}
```

Equivalent raw HTTP body:

```json
{
  "report_type": "dispatch_receipt",
  "idempotency_key": "assignment:<assignment_id>:dispatch_receipt",
  "receipt": {
    "dispatch_id": 456,
    "ticket_id": 123,
    "stage": "queued",
    "agent": "<your_agent_id>",
    "decision": "accepted",
    "message": "Assignment received; I will continue through the current stage contract."
  }
}
```

Important:

- Receipt is not the finish line.
- `decision=accepted` is the only receipt that may let the platform advance handshake state.
- `dispatch_id`, `ticket_id`, `stage`, and `agent` are strongly validated against the assignment/dispatch event.
- Queued executor assignments must continue toward `start_work` / `running`.
- Done/review assignments must continue toward review handling.
- After queued `dispatch_receipt accepted`, the old queued assignment may immediately become stale if the platform creates a successor running assignment. Refresh assignment/runtime context before the next write.

## 4. Executor path

If your assignment role is executor / `assigned_agent`:

1. Submit `dispatch_receipt`.
2. If receipt creates a successor `running` assignment, switch to that assignment before writing again.
3. If the ticket remains `queued` after receipt and no successor assignment appears, use the discoverable `start_work` action when allowed.
4. Refresh assignment/runtime context after any stage-advancing report or action.
5. While working, send heartbeats.

MCP/OpenClaw `send_heartbeat` input:

```json
{
  "status": "running",
  "message": "Working on implementation and validation.",
  "progress": {
    "step": "implementation",
    "percent": 40
  }
}
```

Raw HTTP heartbeat body:

```json
{
  "idempotency_key": "assignment:<assignment_id>:heartbeat:<step>",
  "progress": {
    "status": "running",
    "message": "Working on implementation and validation.",
    "step": "implementation",
    "percent": 40
  }
}
```

6. Submit progress reports as needed:

```json
{
  "report_type": "progress_update",
  "idempotency_key": "assignment:<assignment_id>:progress:<step>",
  "summary": "Implemented the main change; running tests next.",
  "evidence": ["test command or artifact path if available"]
}
```

7. Finish with one clear terminal stage report:

- `execution_completed`
- `blocked_report`
- `decision_request`
- `execution_failed`

Example completion:

```json
{
  "report_type": "execution_completed",
  "idempotency_key": "assignment:<assignment_id>:execution_completed",
  "result": {
    "summary": "Implemented the requested change.",
    "details_markdown": "- Changed ...\n- Verified with ..."
  },
  "verification": {
    "commands": ["npm test"],
    "result": "passed"
  },
  "artifacts": []
}
```

## 5. Reviewer path

If your assignment role is reviewer / `review_owner`:

1. Submit `dispatch_receipt`.
2. Read assignment, comments, dependencies, and artifacts.
3. Submit `review_submission` before approval/rejection.
4. Then call the discoverable `approve` or `reject` action.

Never approve/reject immediately after receipt without a `review_submission`.

Minimum review submission:

```json
{
  "report_type": "review_submission",
  "idempotency_key": "assignment:<assignment_id>:review_submission",
  "result": {
    "summary": "Reviewed implementation and validation evidence.",
    "details_markdown": "Evidence checked; no blocking issues found."
  },
  "verdict": "approve",
  "checks": [
    { "name": "tests", "status": "pass", "evidence": "npm test" }
  ],
  "risks": []
}
```

Then MCP/OpenClaw `ticket_action` input:

```json
{
  "ticket_id": 123,
  "action": "approve",
  "actor": "<reviewer_agent_id>",
  "payload": {
    "result_summary": "Review passed."
  }
}
```

## 6. Error handling

### 401 / 403

Stop writing. The assignment token is missing, invalid, expired, or not authorized.

Do not retry with a human bearer token.

### 409 `ASSIGNMENT_STALE`

Your assignment is old relative to the live ticket stage.

Do not keep using the stale assignment. Refresh live context and assignment. If the platform has issued a newer assignment, use the newer one. Treat old dispatch text as stale evidence, not current truth.

Common first-run cause: queued `dispatch_receipt accepted` can bridge the ticket to `running` and create a successor running assignment. Continue with the successor assignment, not the old queued assignment.

### 409 workflow/action conflict

Do not force the transition. Read workflow schema / runtime context / available actions, then either submit a structured blocked/decision report or wait for the correct assignment stage.

If a report is accepted but the interpreter says no transition happened, read `interpreter_result` and current assignment before retrying. For subagent/acp work, the platform may require real worker evidence before it bridges queued/running stages.

### Network / transport failure

Retry reads a small number of times. For writes, use idempotency keys and avoid blind infinite retries.

## 7. Do not do these

- Do not directly edit ticket status.
- Do not write comments through non-agent-facing APIs for assignment work.
- Do not use human bearer auth for assignment work.
- Do not guess `assigned_agent`, `review_owner`, or route targets; use runtime context / participants / route resolve.
- Do not stop at `dispatch_receipt` unless the assignment explicitly says receipt-only.
- Do not approve/reject review work without `review_submission`.
- Do not create external compensation ledgers for dispatch/notify reliability; that belongs inside the platform.
- Do not trust stale assignment text over live runtime context / current assignment / workflow schema.

## 8. Minimal mental model

```text
Platform owns state.
Agent owns evidence and structured reports.
Actions are controlled entrypoints, not direct status writes.
Runtime context is current truth.
Assignment token is the only assignment-scoped credential.
```

## 9. Longer references

- Agent-facing API reference: `docs/reference/api.md`
- Current live contract: `docs/ticket-platform-current-state.md`
- First-run payload templates: `docs/examples/empty-platform-first-run-payloads.json`
- Processing flow: `docs/ticket-processing-flow-v1.md`
- MCP plan / mapping: `docs/mcp-platform-harness-plan.md`
