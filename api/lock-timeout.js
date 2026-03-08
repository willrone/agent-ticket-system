/**
 * 工单锁定超时自动解锁
 * 
 * 每 5 分钟检查一次，超过 2 小时的锁定自动解锁
 */

import * as store from './store.js';

const LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 小时
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟

let intervalTimer = null;

export function startLockTimeoutChecker() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
  }

  intervalTimer = setInterval(() => {
    checkAndUnlockExpiredTickets();
  }, CHECK_INTERVAL_MS);

  console.log('[LockTimeout] Checker started (interval: 5min, timeout: 2h)');
}

export function stopLockTimeoutChecker() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
    console.log('[LockTimeout] Checker stopped');
  }
}

function checkAndUnlockExpiredTickets() {
  const tickets = store.getAllTickets();
  const now = Date.now();
  let unlockedCount = 0;

  tickets.forEach((ticket) => {
    if (!ticket.locked_by || !ticket.locked_at) {
      return;
    }

    const lockedAt = new Date(ticket.locked_at).getTime();
    const elapsed = now - lockedAt;

    if (elapsed > LOCK_TIMEOUT_MS) {
      console.log(`[LockTimeout] Unlocking ticket #${ticket.id} (locked by ${ticket.locked_by} for ${Math.round(elapsed / 1000 / 60)} minutes)`);
      
      store.updateTicket(ticket.id, {
        locked_by: null,
        locked_at: null,
        last_update: new Date().toISOString(),
      });

      // 添加系统评论
      const comment = {
        id: `comment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        author: 'System',
        timestamp: new Date().toISOString(),
        content: `工单锁定超时（超过 2 小时），已自动解锁。原锁定人: ${ticket.locked_by}`,
        type: 'system',
        visibility: 'internal',
        thread_id: null,
        mentions: [],
      };

      const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
      store.updateTicket(ticket.id, {
        comments: [...comments, comment],
      });

      unlockedCount++;
    }
  });

  if (unlockedCount > 0) {
    console.log(`[LockTimeout] Unlocked ${unlockedCount} expired tickets`);
  }
}

// 手动触发检查（用于测试）
export function checkNow() {
  checkAndUnlockExpiredTickets();
}
