/**
 * @vitest-environment node
 * workflow-mismatch 纯函数测试
 */
import { describe, it, expect } from 'vitest';
import { detectWorkflowMismatch } from './workflow-mismatch.js';

describe('workflow-mismatch', () => {
  it('running + 决策型评论 => pending_decision mismatch', () => {
    const ticket = {
      id: 1,
      status: 'running',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      decision_owner: '荣晖',
      assigned_agent: 'donky',
      comments: [
        { content: '需要老大拍板，是否继续推进', type: 'decision', timestamp: '2025-01-02T00:00:00Z' },
      ],
    };
    const m = detectWorkflowMismatch(ticket);
    expect(m).not.toBeNull();
    expect(m.category).toBe('decision_required');
    expect(m.recommended_status).toBe('pending_decision');
    expect(m.alert_target).toBe('荣晖');
    expect(m.reason).toBeDefined();
  });

  it('running + token/上下文不足 => review mismatch', () => {
    const ticket = {
      id: 2,
      status: 'running',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      assigned_agent: 'donky',
      comments: [
        { content: 'token 不够用了，上下文不足，需要更多信息', type: 'blocker', timestamp: '2025-01-02T00:00:00Z' },
      ],
    };
    const m = detectWorkflowMismatch(ticket);
    expect(m).not.toBeNull();
    expect(m.category).toBe('context_gap');
    expect(m.recommended_status).toBe('review');
    expect(m.alert_target).toBe('leoss');
  });

  it('running + 外部依赖阻塞 => blocked mismatch', () => {
    const ticket = {
      id: 3,
      status: 'running',
      triage_owner: 'leoss',
      assigned_agent: 'donky',
      comments: [
        { content: '等外部 API 权限，依赖 ops 审批', type: 'blocker', timestamp: '2025-01-02T00:00:00Z' },
      ],
    };
    const m = detectWorkflowMismatch(ticket);
    expect(m).not.toBeNull();
    expect(m.category).toBe('external_blocked');
    expect(m.recommended_status).toBe('blocked');
  });

  it('review 状态下不报 mismatch', () => {
    const ticket = {
      id: 4,
      status: 'review',
      comments: [{ content: '需要老大拍板', type: 'decision', timestamp: '2025-01-02T00:00:00Z' }],
    };
    expect(detectWorkflowMismatch(ticket)).toBeNull();
  });

  it('pending_decision 状态下不报 mismatch', () => {
    const ticket = {
      id: 5,
      status: 'pending_decision',
      comments: [{ content: '需要决策', type: 'decision', timestamp: '2025-01-02T00:00:00Z' }],
    };
    expect(detectWorkflowMismatch(ticket)).toBeNull();
  });

  it('blocked 状态下不报 mismatch', () => {
    const ticket = {
      id: 6,
      status: 'blocked',
      comments: [{ content: '等外部依赖', type: 'blocker', timestamp: '2025-01-02T00:00:00Z' }],
    };
    expect(detectWorkflowMismatch(ticket)).toBeNull();
  });

  it('无相关评论不报 mismatch', () => {
    const ticket = {
      id: 7,
      status: 'running',
      comments: [
        { content: '进展顺利，继续推进', type: 'progress', timestamp: '2025-01-02T00:00:00Z' },
      ],
    };
    expect(detectWorkflowMismatch(ticket)).toBeNull();
  });

  it('多个评论时取最新相关评论', () => {
    const ticket = {
      id: 8,
      status: 'running',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      comments: [
        { content: 'token 不足', type: 'blocker', timestamp: '2025-01-01T00:00:00Z' },
        { content: '需要老大拍板', type: 'decision', timestamp: '2025-01-02T00:00:00Z' },
      ],
    };
    const m = detectWorkflowMismatch(ticket);
    expect(m).not.toBeNull();
    expect(m.category).toBe('decision_required');
  });

  it('running + progress 评论“等老大确认是否继续” => decision_required', () => {
    const ticket = {
      id: 9,
      status: 'running',
      triage_owner: 'leoss',
      decision_owner: '荣晖',
      comments: [
        { content: '等老大确认是否继续', type: 'progress', timestamp: '2025-01-02T00:00:00Z' },
      ],
    };
    const m = detectWorkflowMismatch(ticket);
    expect(m).not.toBeNull();
    expect(m.category).toBe('decision_required');
    expect(m.reason).toContain('决策');
  });

  it('running + progress 评论“token 不足，需要更多上下文” => context_gap', () => {
    const ticket = {
      id: 10,
      status: 'running',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      comments: [
        { content: 'token 不足，需要更多上下文', type: 'progress', timestamp: '2025-01-02T00:00:00Z' },
      ],
    };
    const m = detectWorkflowMismatch(ticket);
    expect(m).not.toBeNull();
    expect(m.category).toBe('context_gap');
    expect(m.reason).toContain('token');
  });

  it('running + progress 评论“等上游接口权限开通” => external_blocked', () => {
    const ticket = {
      id: 11,
      status: 'running',
      triage_owner: 'leoss',
      comments: [
        { content: '等上游接口权限开通', type: 'progress', timestamp: '2025-01-02T00:00:00Z' },
      ],
    };
    const m = detectWorkflowMismatch(ticket);
    expect(m).not.toBeNull();
    expect(m.category).toBe('external_blocked');
    expect(m.reason).toContain('外部阻塞');
  });

  it('running + 最新 system 审计回写不应覆盖较早的正常 agent 评论', () => {
    const ticket = {
      id: 12,
      status: 'running',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      assigned_agent: 'beavy',
      comments: [
        { content: '已完成实现与测试，准备收口', type: 'progress', timestamp: '2025-01-02T00:00:00Z' },
        { content: '【审计回写】建议仅提醒继续推进，未见外部依赖或阻塞证据', type: 'system', timestamp: '2025-01-03T00:00:00Z' },
      ],
    };
    expect(detectWorkflowMismatch(ticket)).toBeNull();
  });

  it('running + 实现说明里的 current context/上下文 文案不应误判为 context_gap', () => {
    const ticket = {
      id: 13,
      status: 'running',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      assigned_agent: 'beavy',
      comments: [
        { content: '实现时请优先修正 current context 选择逻辑，并展示 context latest active time', type: 'progress', timestamp: '2025-01-03T00:00:00Z' },
      ],
    };
    expect(detectWorkflowMismatch(ticket)).toBeNull();
  });

  it('running + 最新评论明确已拍板并继续推进时，不应再因决策词误报 mismatch', () => {
    const ticket = {
      id: 14,
      status: 'running',
      triage_owner: 'leoss',
      review_owner: 'leoss',
      decision_owner: '荣晖',
      assigned_agent: 'cowder',
      comments: [
        { content: '需要老大拍板，是否继续推进', type: 'decision', timestamp: '2025-01-02T00:00:00Z' },
        { content: '当前阶段核实：本票已由老大明确拍板；上一条 decision 评论用于记录授权结论，不代表工单仍处于待决策。#37 现阶段应保持 running，并继续推进。', type: 'progress', timestamp: '2025-01-03T00:00:00Z' },
      ],
    };
    expect(detectWorkflowMismatch(ticket)).toBeNull();
  });
});
