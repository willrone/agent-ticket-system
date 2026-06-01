# Ticket Platform Documentation Maintenance Policy

_Last updated: 2026-03-12_

This document defines the documentation policy for the ticket platform repository.

## Related documents
- Current state: [`docs/ticket-platform-current-state.md`](./ticket-platform-current-state.md)
- Gap analysis + plan: [`docs/ticket-platform-gap-analysis-and-plan.md`](./ticket-platform-gap-analysis-and-plan.md)
- Platform API overview: [`docs/API.md`](./API.md)
- Agent-facing API reference: [`docs/reference/api.md`](./reference/api.md)

## Core rule

Ticket-platform changes are **not complete** unless:
1. code is updated,
2. formal documentation is updated,
3. live/runtime verification is recorded,
4. reviewer confirms docs, runtime, and code still agree.

---

## 1. Why this policy exists

The platform has repeatedly hit a failure pattern:
- code changes land,
- runtime behavior changes,
- docs are not updated,
- later analysis reads stale docs,
- reviewers and triagers reason from outdated text,
- live/platform truth drifts away from the written contract.

This policy exists to stop that drift.

---

## 2. Required document updates

For ticket-platform changes, authors must update whichever formal documents are affected.

### Required document classes
- current-state document
- gap/plan document (when roadmap implications change)
- API/reference docs (when external contract changes)
- README / setup / operational docs (when operator behavior changes)
- change log / validation notes when needed

At minimum, any change that affects platform semantics must update the relevant formal documentation under `docs/`.

---

## 3. Changes that must update docs

Documentation updates are mandatory for changes involving any of the following:

### Workflow / state changes
- status semantics
- action semantics
- role ownership
- actor resolution
- review / decision routing
- pause/resume/approve/reject contract

### Agent-facing contract changes
- runtime context
- playbook bundle
- hosted skill bundle
- auth transport
- error model
- request/response shape

### Dispatch / notify / escalation changes
- ready queues
- notification routing
- dedupe policy
- escalation policy
- workflow mismatch handling

### Parent-child / dependency changes
- hierarchy semantics
- dependency model
- closeout rules
- traceability or gate logic

### Frontend behavior changes
- user-visible workflow interpretation
- review panels / inboxes
- dependency or parent aggregation displays
- any scope-promised platform behavior the UI must expose

### Live operational changes
- poller behavior
- gateway behavior
- deployment/runtime topology assumptions
- health/acceptance behavior

---

## 4. Required verification note

Any meaningful ticket-platform change should include a short verification record covering live/runtime truth, not just code or tests.

### Minimum verification expectations
- which live endpoint/page/surface was checked
- what contract/behavior was expected
- what result was actually observed
- whether docs were updated to match that result

This can live in:
- the PR description,
- the ticket review summary,
- or a dedicated validation note referenced by the ticket.

### Recommended verification examples
- workflow change → verify `/api/v1/agent/workflow/schema`
- agent-facing contract change → verify runtime context + hosted bundle + `docs/reference/api.md`
- dispatch/notify change → verify `/api/dispatch/ready` and `/api/notifications/ready`
- reviewer action change → verify live action API + current-state doc

---

## 5. Reviewer gate

Reviewers must not approve ticket-platform work on code evidence alone.

### Reviewer checklist
1. Did the code change the intended behavior?
2. Was the formal documentation updated?
3. Does the updated doc match the actual live/runtime behavior?
4. Was live verification recorded?
5. Were the correct authoritative docs updated (not just an unrelated note file)?
6. If public/agent-facing contract changed, were `docs/API.md` or `docs/reference/api.md` updated where relevant?

If the answer to any of these is “no,” the change is not fully complete.

### Default reviewer verdict
If code changed but docs did not, reviewer should treat the change as:
- incomplete delivery
- not ready for final approval

### Reviewer note template
Reviewers should prefer leaving a short structured note such as:

```md
## Documentation gate
- Formal docs updated: yes / no
- Updated files: ...
- Live surfaces checked: ...
- Docs match live/code: yes / no
- Verdict: pass / return for doc sync
```

---

## 6. Recommended author workflow

For any ticket-platform change:
1. update code
2. update affected `docs/` files
3. run/record live verification
4. mention doc changes explicitly in review submission

This should become the default engineering habit, not an exception.

### Recommended author note template
```md
## Documentation sync
- Affected docs:
  - docs/ticket-platform-current-state.md
  - docs/ticket-platform-gap-analysis-and-plan.md
  - docs/API.md / docs/reference/api.md (if contract changed)
- Live verification:
  - checked: ...
  - observed: ...
- Why docs changed:
  - ...
```

---

## 7. Relationship to current-state docs

The current-state documents are part of the platform contract surface.
They are not commentary-only notes.

That means:
- stale current-state docs are a platform correctness problem,
- not just a documentation quality problem.

---

## 8. Long-term operating rule

Future analysis should follow this sequence:
1. read formal docs first,
2. verify against live/runtime truth,
3. then inspect code when needed.

This only works if documentation is kept synchronized as a first-class deliverable.

---

## Final policy statement

> For the ticket platform, documentation is part of the deliverable. If docs were not updated, the work is not actually finished.
