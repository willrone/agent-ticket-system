/**
 * WebSocket 实时推送服务
 * 
 * 用于实时推送工单状态变化，替代 Sheeply 5 分钟轮询
 */

import EventEmitter from 'events';

class TicketWebSocket extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 3000;
    this.maxReconnectDelay = 30000;
  }

  connect(url = 'ws://127.0.0.1:8788/ws') {
    if (this.ws) {
      this.ws.close();
    }

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WebSocket] Connected');
      this.reconnectDelay = 3000;
      this.emit('connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (err) {
        console.error('[WebSocket] Failed to parse message:', err);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error);
      this.emit('error', error);
    };

    this.ws.onclose = () => {
      console.log('[WebSocket] Disconnected');
      this.emit('disconnected');
      this.scheduleReconnect(url);
    };
  }

  handleMessage(data) {
    const { type, payload } = data;

    switch (type) {
      case 'ticket.created':
        this.emit('ticket:created', payload);
        break;
      case 'ticket.updated':
        this.emit('ticket:updated', payload);
        break;
      case 'ticket.status_changed':
        this.emit('ticket:status_changed', payload);
        break;
      case 'ticket.comment':
        this.emit('ticket:comment', payload);
        break;
      case 'ticket.locked':
        this.emit('ticket:locked', payload);
        break;
      case 'ticket.unlocked':
        this.emit('ticket:unlocked', payload);
        break;
      default:
        console.warn('[WebSocket] Unknown message type:', type);
    }
  }

  scheduleReconnect(url) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      console.log('[WebSocket] Reconnecting...');
      this.connect(url);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }, this.reconnectDelay);
  }

  send(type, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    } else {
      console.warn('[WebSocket] Not connected, cannot send message');
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// 单例
const ticketWS = new TicketWebSocket();

export default ticketWS;
