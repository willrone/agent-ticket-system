/**
 * WebSocket Server for Real-time Ticket Updates
 */
import { WebSocketServer } from 'ws';
import * as store from './store.js';

let wss = null;
const clients = new Set();

export function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('[WebSocket] Client connected');
    clients.add(ws);

    ws.on('close', () => {
      console.log('[WebSocket] Client disconnected');
      clients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('[WebSocket] Error:', error);
      clients.delete(ws);
    });

    // 发送欢迎消息
    ws.send(JSON.stringify({
      type: 'connected',
      payload: { message: 'WebSocket connected' }
    }));
  });

  console.log('[WebSocket] Server initialized');
}

export function broadcast(type, payload) {
  if (!wss) return;

  const message = JSON.stringify({ type, payload });
  
  clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      try {
        client.send(message);
      } catch (err) {
        console.error('[WebSocket] Failed to send to client:', err);
      }
    }
  });
}

// 工单事件广播函数
export function broadcastTicketCreated(ticket) {
  broadcast('ticket.created', ticket);
}

export function broadcastTicketUpdated(ticket) {
  broadcast('ticket.updated', ticket);
}

export function broadcastTicketStatusChanged(ticket, oldStatus, newStatus) {
  broadcast('ticket.status_changed', {
    ticket,
    oldStatus,
    newStatus,
  });
}

export function broadcastTicketComment(ticketId, comment) {
  broadcast('ticket.comment', {
    ticketId,
    comment,
  });
}

export function broadcastTicketLocked(ticketId, lockedBy) {
  broadcast('ticket.locked', {
    ticketId,
    lockedBy,
  });
}

export function broadcastTicketUnlocked(ticketId) {
  broadcast('ticket.unlocked', {
    ticketId,
  });
}
