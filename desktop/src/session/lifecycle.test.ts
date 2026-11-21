import { describe, expect, it } from 'vitest';
import { shouldStartForTrigger, type SessionSnapshot } from './lifecycle';

const base: SessionSnapshot = {
  onboardingDone: true,
  autoStart: true,
  engine: 'bridge-asr',
  localActive: false,
  starting: false,
};

describe('event-driven session lifecycle', () => {
  it('starts once when the SSE stream comes online', () => {
    expect(shouldStartForTrigger('stream-online', base)).toBe(true);
  });

  it('restarts when the bridge reports the session stopped', () => {
    expect(shouldStartForTrigger('session-stopped', base)).toBe(true);
  });

  it('never starts before onboarding', () => {
    expect(shouldStartForTrigger('stream-online', { ...base, onboardingDone: false })).toBe(false);
  });

  it('respects the auto-start preference', () => {
    expect(shouldStartForTrigger('stream-online', { ...base, autoStart: false })).toBe(false);
  });

  it('never starts in system-captions mode', () => {
    expect(shouldStartForTrigger('stream-online', { ...base, engine: 'system-live' })).toBe(false);
  });

  it('does not duplicate a session we already own', () => {
    expect(shouldStartForTrigger('stream-online', { ...base, localActive: true })).toBe(false);
  });

  it('does not start while another start is in flight', () => {
    expect(shouldStartForTrigger('session-stopped', { ...base, starting: true })).toBe(false);
  });
});
