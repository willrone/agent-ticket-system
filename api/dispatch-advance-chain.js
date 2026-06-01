import { getActionMeta, getAvailableActionObjects, resolveRoleActor } from '../workflow-schema.js';

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function buildResult(ticket = {}, {
  ok,
  code = null,
  message = null,
  missing_fields = [],
  required_actor = null,
  dispatch_actor = null,
  allowed_actions = [],
  allowed_next_statuses = [],
} = {}) {
  return {
    ok,
    code,
    stage: clean(ticket.status) || null,
    dispatch_actor: dispatch_actor ?? clean(ticket.next_actor) ?? clean(ticket.current_actor) ?? null,
    required_actor: required_actor ?? null,
    missing_fields: unique(missing_fields),
    allowed_actions: unique(allowed_actions),
    allowed_next_statuses: unique(allowed_next_statuses),
    message: message || null,
  };
}

export function validateDispatchAdvanceChain(ticket = {}) {
  const stage = clean(ticket.status);
  const dispatchActor = clean(ticket.next_actor) || clean(ticket.current_actor);
  const availableActions = Array.isArray(ticket.available_actions)
    ? ticket.available_actions
    : getAvailableActionObjects(ticket).map((item) => item.key);

  switch (stage) {
    case 'triage': {
      const missing = [];
      if (!clean(ticket.triage_owner)) missing.push('triage_owner');
      if (!dispatchActor) missing.push('next_actor');
      if (missing.length > 0) {
        return buildResult(ticket, {
          ok: false,
          code: 'DISPATCH_ADVANCE_CHAIN_INVALID',
          message: 'triage 阶段缺少合法推进责任人，无法派发。',
          missing_fields: missing,
          required_actor: clean(ticket.triage_owner),
          dispatch_actor: dispatchActor,
          allowed_actions: availableActions,
          allowed_next_statuses: ['queued', 'paused'],
        });
      }
      return buildResult(ticket, {
        ok: true,
        required_actor: clean(ticket.triage_owner),
        dispatch_actor: dispatchActor,
        allowed_actions: availableActions,
        allowed_next_statuses: ['queued', 'paused'],
      });
    }
    case 'queued': {
      const missing = [];
      if (!clean(ticket.assigned_agent)) missing.push('assigned_agent');
      if (!clean(ticket.review_owner)) missing.push('review_owner');
      if (!dispatchActor) missing.push('next_actor');
      const requiredActor = resolveRoleActor(ticket, getActionMeta('start_work')?.role_key || 'assigned_agent');
      if (missing.length > 0) {
        return buildResult(ticket, {
          ok: false,
          code: 'DISPATCH_ADVANCE_CHAIN_INVALID',
          message: 'queued 阶段缺少合法推进链：需要 assigned_agent、review_owner，且当前派发目标必须明确。',
          missing_fields: missing,
          required_actor: requiredActor,
          dispatch_actor: dispatchActor,
          allowed_actions: availableActions,
          allowed_next_statuses: ['running', 'done', 'blocked', 'pending_decision', 'paused'],
        });
      }
      if (requiredActor && dispatchActor && requiredActor !== dispatchActor) {
        return buildResult(ticket, {
          ok: false,
          code: 'DISPATCH_ADVANCE_CHAIN_INVALID',
          message: `queued 阶段派发目标不合法：应派给 ${requiredActor}，实际为 ${dispatchActor}`,
          required_actor: requiredActor,
          dispatch_actor: dispatchActor,
          allowed_actions: availableActions,
          allowed_next_statuses: ['running', 'done', 'blocked', 'pending_decision', 'paused'],
        });
      }
      return buildResult(ticket, {
        ok: true,
        required_actor: requiredActor,
        dispatch_actor: dispatchActor,
        allowed_actions: availableActions,
        allowed_next_statuses: ['running', 'done', 'blocked', 'pending_decision', 'paused'],
      });
    }
    case 'running': {
      const missing = [];
      if (!clean(ticket.assigned_agent)) missing.push('assigned_agent');
      if (!dispatchActor) missing.push('next_actor');
      const requiredActor = resolveRoleActor(ticket, 'assigned_agent');
      if (missing.length > 0) {
        return buildResult(ticket, {
          ok: false,
          code: 'DISPATCH_ADVANCE_CHAIN_INVALID',
          message: 'running 阶段缺少合法推进责任人，无法继续派发。',
          missing_fields: missing,
          required_actor: requiredActor,
          dispatch_actor: dispatchActor,
          allowed_actions: availableActions,
          allowed_next_statuses: ['done', 'blocked', 'pending_decision', 'failed', 'paused'],
        });
      }
      if (requiredActor && dispatchActor && requiredActor !== dispatchActor) {
        return buildResult(ticket, {
          ok: false,
          code: 'DISPATCH_ADVANCE_CHAIN_INVALID',
          message: `running 阶段派发目标不合法：应派给 ${requiredActor}，实际为 ${dispatchActor}`,
          required_actor: requiredActor,
          dispatch_actor: dispatchActor,
          allowed_actions: availableActions,
          allowed_next_statuses: ['done', 'blocked', 'pending_decision', 'failed', 'paused'],
        });
      }
      return buildResult(ticket, {
        ok: true,
        required_actor: requiredActor,
        dispatch_actor: dispatchActor,
        allowed_actions: availableActions,
        allowed_next_statuses: ['done', 'blocked', 'pending_decision', 'failed', 'paused'],
      });
    }
    case 'done':
    case 'review': {
      const missing = [];
      if (!clean(ticket.review_owner)) missing.push('review_owner');
      if (!dispatchActor) missing.push('next_actor');
      const requiredActor = resolveRoleActor(ticket, 'review_owner');
      const nextStatuses = stage === 'done'
        ? ['review', 'pending_decision', 'paused']
        : ['complete', 'queued', 'pending_decision', 'paused'];
      if (missing.length > 0) {
        return buildResult(ticket, {
          ok: false,
          code: 'DISPATCH_ADVANCE_CHAIN_INVALID',
          message: `${stage} 阶段缺少合法 reviewer 推进链，无法派发。`,
          missing_fields: missing,
          required_actor: requiredActor,
          dispatch_actor: dispatchActor,
          allowed_actions: availableActions,
          allowed_next_statuses: nextStatuses,
        });
      }
      if (requiredActor && dispatchActor && requiredActor !== dispatchActor) {
        return buildResult(ticket, {
          ok: false,
          code: 'DISPATCH_ADVANCE_CHAIN_INVALID',
          message: `${stage} 阶段派发目标不合法：应派给 ${requiredActor}，实际为 ${dispatchActor}`,
          required_actor: requiredActor,
          dispatch_actor: dispatchActor,
          allowed_actions: availableActions,
          allowed_next_statuses: nextStatuses,
        });
      }
      return buildResult(ticket, {
        ok: true,
        required_actor: requiredActor,
        dispatch_actor: dispatchActor,
        allowed_actions: availableActions,
        allowed_next_statuses: nextStatuses,
      });
    }
    case 'blocked':
    case 'failed': {
      const missing = [];
      if (!clean(ticket.triage_owner)) missing.push('triage_owner');
      if (!dispatchActor) missing.push('next_actor');
      const requiredActor = resolveRoleActor(ticket, 'triage_owner');
      const nextStatuses = stage === 'blocked'
        ? ['queued', 'pending_decision', 'paused']
        : [];
      if (missing.length > 0) {
        return buildResult(ticket, {
          ok: false,
          code: 'DISPATCH_ADVANCE_CHAIN_INVALID',
          message: `${stage} 阶段缺少 triage 责任链，无法派发。`,
          missing_fields: missing,
          required_actor: requiredActor,
          dispatch_actor: dispatchActor,
          allowed_actions: availableActions,
          allowed_next_statuses: nextStatuses,
        });
      }
      if (requiredActor && dispatchActor && requiredActor !== dispatchActor) {
        return buildResult(ticket, {
          ok: false,
          code: 'DISPATCH_ADVANCE_CHAIN_INVALID',
          message: `${stage} 阶段派发目标不合法：应派给 ${requiredActor}，实际为 ${dispatchActor}`,
          required_actor: requiredActor,
          dispatch_actor: dispatchActor,
          allowed_actions: availableActions,
          allowed_next_statuses: nextStatuses,
        });
      }
      return buildResult(ticket, {
        ok: true,
        required_actor: requiredActor,
        dispatch_actor: dispatchActor,
        allowed_actions: availableActions,
        allowed_next_statuses: nextStatuses,
      });
    }
    default:
      return buildResult(ticket, {
        ok: true,
        dispatch_actor: dispatchActor,
        allowed_actions: availableActions,
      });
  }
}
