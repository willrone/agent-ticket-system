import { describe, expect, it } from 'vitest';
import { classifyLogIncident } from './incident-classifier.js';

describe('classifyLogIncident', () => {
  it('downgrades stale error tails when current live surface is healthy', () => {
    const result = classifyLogIncident({
      logTail: '[internal-poller:dispatch] delivery failed for dispatch_id=1740, no ack: target_session_key 缺失，无法投递',
      rootOk: true,
      rootHtmlOk: true,
      distIndexExists: true,
      errLogMtimeEpoch: 1_700_000_000,
      liveServerStartedEpoch: 1_700_100_000,
      nowEpoch: 1_700_200_000,
      staleMinutes: 60,
    });

    expect(result.verdict).toBe('pass');
    expect(result.category).toBe('stale_history');
    expect(result.signal_count).toBe(1);
    expect(result.stale_by_process).toBe(true);
  });

  it('keeps fresh error signals as warnings when live surface is healthy', () => {
    const result = classifyLogIncident({
      logTail: 'Error: fresh failure',
      rootOk: true,
      rootHtmlOk: true,
      distIndexExists: true,
      errLogMtimeEpoch: 1_700_199_900,
      liveServerStartedEpoch: 1_700_100_000,
      nowEpoch: 1_700_200_000,
      staleMinutes: 60,
    });

    expect(result.verdict).toBe('warn');
    expect(result.category).toBe('fresh_incident');
  });
});
