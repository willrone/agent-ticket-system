export const DEFAULT_TRIAGE_OWNER = 'leoss';
export const DEFAULT_DECISION_OWNER = '荣晖';
export const TICKET_STATUSES = ['triage', 'queued', 'running', 'review', 'blocked', 'done', 'failed', 'complete', 'pending_decision'];

const OVERRIDE_FIRST_STATUSES = new Set(['review', 'blocked', 'failed']);
const ASSIGNED_AGENT_STATUSES = new Set(['queued', 'running']);
const REVIEW_STATUSES = new Set(['done', 'review']);
const DECISION_STATUSES = new Set(['pending_decision']);

function cleanActor(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

export function resolveTicketRouting(ticket = {}) {
  const status = ticket.status || 'queued';
  const triageOwner = cleanActor(ticket.triage_owner);
  const reviewOwner = cleanActor(ticket.review_owner);
  const decisionOwner = cleanActor(ticket.decision_owner);
  const assignedAgent = cleanActor(ticket.assigned_agent);
  const nextActorOverride = cleanActor(ticket.next_actor);

  if (status === 'complete') {
    return {
      next_actor: null,
      next_actor_override: nextActorOverride,
      next_actor_source: null,
      should_notify: false,
    };
  }

  if (status === 'triage') {
    return {
      next_actor: triageOwner,
      next_actor_override: nextActorOverride,
      next_actor_source: triageOwner ? 'triage_owner' : null,
      should_notify: Boolean(triageOwner),
    };
  }

  if (ASSIGNED_AGENT_STATUSES.has(status)) {
    return {
      next_actor: assignedAgent,
      next_actor_override: nextActorOverride,
      next_actor_source: assignedAgent ? 'assigned_agent' : null,
      should_notify: Boolean(assignedAgent),
    };
  }

  if (DECISION_STATUSES.has(status)) {
    const decider = decisionOwner || '荣晖';
    return {
      next_actor: decider,
      next_actor_override: nextActorOverride,
      next_actor_source: decisionOwner ? 'decision_owner' : 'decision_owner_default',
      should_notify: true,
    };
  }

  if (REVIEW_STATUSES.has(status)) {
    if (nextActorOverride) {
      return {
        next_actor: nextActorOverride,
        next_actor_override: nextActorOverride,
        next_actor_source: 'next_actor',
        should_notify: true,
      };
    }
    const reviewer = reviewOwner || triageOwner;
    return {
      next_actor: reviewer,
      next_actor_override: nextActorOverride,
      next_actor_source: reviewer ? (reviewOwner ? 'review_owner' : 'review_owner_fallback') : null,
      should_notify: Boolean(reviewer),
    };
  }

  if (OVERRIDE_FIRST_STATUSES.has(status) && nextActorOverride) {
    return {
      next_actor: nextActorOverride,
      next_actor_override: nextActorOverride,
      next_actor_source: 'next_actor',
      should_notify: true,
    };
  }

  const fallbackActor = assignedAgent || triageOwner || nextActorOverride;
  return {
    next_actor: fallbackActor,
    next_actor_override: nextActorOverride,
    next_actor_source: fallbackActor
      ? (assignedAgent ? 'assigned_agent_fallback' : triageOwner ? 'triage_owner_fallback' : 'next_actor')
      : null,
    should_notify: Boolean(fallbackActor),
  };
}

export function enrichTicketRouting(ticket = {}) {
  const routing = resolveTicketRouting(ticket);
  return {
    ...ticket,
    triage_owner: cleanActor(ticket.triage_owner),
    review_owner: cleanActor(ticket.review_owner),
    decision_owner: cleanActor(ticket.decision_owner),
    next_actor: routing.next_actor,
    next_actor_override: routing.next_actor_override,
    next_actor_source: routing.next_actor_source,
    should_notify: routing.should_notify,
  };
}
