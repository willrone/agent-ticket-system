export function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeCommentShape(comment = {}) {
  return {
    id: comment.id ?? Date.now(),
    ticket_id: comment.ticket_id ?? null,
    author: comment.author ?? 'Current User',
    timestamp: comment.timestamp ?? new Date().toISOString(),
    content: comment.content ?? '',
    type: comment.type ?? 'progress',
    visibility: comment.visibility ?? 'internal',
    thread_id: comment.thread_id ?? null,
    mentions: Array.isArray(comment.mentions) ? comment.mentions : parseJsonArray(comment.mentions_json),
    notify_targets: Array.isArray(comment.notify_targets)
      ? comment.notify_targets
      : parseJsonArray(comment.notify_targets_json),
  };
}

export function buildCommentId() {
  return Number(`${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`);
}
