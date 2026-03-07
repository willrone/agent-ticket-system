export const COMMENT_TYPES = ['progress', 'blocker', 'decision', 'result', 'system'];
export const COMMENT_VISIBILITY = ['internal', 'public'];

export const COMMENT_MAX_LENGTH = 10000;
export const THREAD_ID_MAX_LENGTH = 256;
export const AUTHOR_MAX_LENGTH = 64;

export function isValidCommentType(type) {
  return COMMENT_TYPES.includes(type);
}

export function isValidVisibility(visibility) {
  return COMMENT_VISIBILITY.includes(visibility);
}
