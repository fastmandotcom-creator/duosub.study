import { describe, expect, it } from 'vitest';
import { decideSessionAction, RETRY_INTERVAL_MS, type SessionSnapshot } from './lifecycle';

const base: SessionSnapshot = {
  onboardingDone: true,
  autoStart: true,
  engine: 'bridge-asr',
  localActive: false,
  starting: false,
  healthReachable: true,
  healthSessionActive: false,
  sinceLastAttemptMs: RETRY_INTERVAL_MS + 1,
};

describe('session lifecycle', () => {
  it('starts when bridge is reachable but has no session', () => {
    expect(decideSessionAction(base)).toBe('start');
  });

  it('waits when the bridge session is already active', () => {
    expect(decideSessionAction({ ...base, healthSessionActive: true })).toBe('wait');
  });

  it('waits while a start is in flight — no duplicate sessions', () => {
    expect(decideSessionAction({ ...base, starting: true })).toBe('wait');
  });

  it('waits when the bridge is offline', () => {
    expect(decideSessionAction({ ...base, healthReachable: false })).toBe('wait');
  });

  it('never starts in system-live mode', () => {
    expect(decideSessionAction({ ...base, engine: 'system-live' })).toBe('wait');
  });

  it('throttles rapid retries', () => {
    expect(decideSessionAction({ ...base, sinceLastAttemptMs: 1000 })).toBe('wait');
  });

  it('retries forever after a failure — no attempt-count ceiling', () => {
    for (const elapsed of [1, 100, 10_000, 1_000_000]) {
      expect(decideSessionAction({ ...base, sinceLastAttemptMs: elapsed })).toBe(
        elapsed < RETRY_INTERVAL_MS ? 'wait' : 'start',
      );
    }
  });

  it('re-arms even when a replayed session_started event lies about an old session', () => {
    // The bridge ring replays session_started for a session that has since stopped. The app must
    // rely on /health (not the replay) and therefore still decide to start.
    const replayedStart = { ...base, healthSessionActive: false };
    expect(decideSessionAction(replayedStart)).toBe('start');
  });

  it('re-arms after the bridge orphan-reaper stops a previously active session', () => {
    expect(decideSessionAction({ ...base, localActive: true })).toBe('wait');
    // Simulate the stopped event arriving and the bridge now reporting no session.
    expect(decideSessionAction({ ...base, localActive: false, healthSessionActive: false })).toBe('start');
  });
});
