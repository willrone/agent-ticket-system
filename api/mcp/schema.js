import { z } from 'zod';

const assignmentId = z.string().trim().min(1).optional();
const requiredAssignmentId = z.string().trim().min(1);
const stringId = z.union([z.string().trim().min(1), z.number().int().positive()]);
const jsonRecord = z.record(z.string(), z.unknown());

export const commonSchemas = {
  assignmentId,
  requiredAssignmentId,
  stringId,
  jsonRecord,
};

export const toolInputSchemas = {
  get_runtime_context: z.object({
    assignment_id: assignmentId.describe('Assignment id. Falls back to TICKET_ASSIGNMENT_ID when omitted.'),
  }),

  get_assignment: z.object({
    assignment_id: assignmentId.describe('Assignment id. Falls back to TICKET_ASSIGNMENT_ID when omitted.'),
  }),

  read_comments: z.object({
    assignment_id: assignmentId.describe('Assignment id. Falls back to TICKET_ASSIGNMENT_ID when omitted.'),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.union([z.string(), z.number().int().positive()]).optional(),
  }),

  read_dependencies: z.object({
    assignment_id: assignmentId.describe('Assignment id. Falls back to TICKET_ASSIGNMENT_ID when omitted.'),
  }),

  list_participants: z.object({
    platform_id: z.string().trim().min(1).optional(),
    participant_id: z.string().trim().min(1).optional(),
    role_key: z.string().trim().min(1).optional(),
  }),

  resolve_route: z.object({
    participant_id: z.string().trim().min(1).optional(),
    platform_id: z.string().trim().min(1).optional(),
    role_key: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
    intent: z.string().trim().min(1).optional(),
    capability: z.string().trim().min(1).optional(),
    session_kind: z.string().trim().min(1).optional(),
    ticket_id: stringId.optional(),
  }),

  send_heartbeat: z.object({
    assignment_id: assignmentId.describe('Assignment id. Falls back to TICKET_ASSIGNMENT_ID when omitted.'),
    status: z.string().trim().min(1),
    message: z.string().optional(),
    progress: z.unknown().optional(),
    idempotency_key: z.string().trim().min(1).optional(),
  }).passthrough(),

  submit_report: z.object({
    assignment_id: assignmentId.describe('Assignment id. Falls back to TICKET_ASSIGNMENT_ID when omitted.'),
    report_type: z.string().trim().min(1),
    payload: jsonRecord.optional(),
    idempotency_key: z.string().trim().min(1).optional(),
  }),

  create_ticket: z.object({
    actor: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1),
    description: z.string().optional(),
    platform: z.string().trim().min(1).optional(),
    triage_owner: z.string().trim().min(1).optional(),
    assigned_agent: z.string().trim().min(1).optional(),
    review_owner: z.string().trim().min(1).optional(),
    parent_ticket_id: stringId.optional().nullable(),
  }).passthrough(),

  ticket_action: z.object({
    ticket_id: stringId,
    action: z.string().trim().min(1),
    actor: z.string().trim().min(1).optional(),
    assignment_id: assignmentId,
    payload: jsonRecord.optional(),
  }).passthrough(),
};

export function parseToolInput(toolName, input) {
  const schema = toolInputSchemas[toolName];
  if (!schema) {
    throw new Error(`Unknown MCP tool schema: ${toolName}`);
  }
  return schema.parse(input || {});
}
