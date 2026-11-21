/**
 * Session lifecycle, event-driven only.
 *
 * There is exactly ONE automatic start trigger: a bridge event ("stream online" or
 * "session stopped"). No polling timer, no React effect, no repeated health round trips. This is
 * deliberately small so the behaviour can be pinned by tests and reasoned about in one glance.
 */

export type SessionTrigger = 'stream-online' | 'session-stopped';

export interface SessionSnapshot {
  /** Onboarding finished. */
  onboardingDone: boolean;
  autoStart: boolean;
  engine: 'system-live' | 'bridge-asr';
  /** True only after OUR OWN successful start() call. Never inferred from replayed events. */
  localActive: boolean;
  starting: boolean;
}

/**
 * True when the trigger should cause exactly one start attempt.
 * We intentionally ignore the trigger's payload: /health inside ensureSession is the authority on
 * whether a session already exists (replayed session_started frames are stale and must not count).
 */
export function shouldStartForTrigger(trigger: SessionTrigger, s: SessionSnapshot): boolean {
  if (!s.onboardingDone || !s.autoStart) return false;
  if (s.engine !== 'bridge-asr') return false;
  if (s.starting || s.localActive) return false;
  return trigger === 'stream-online' || trigger === 'session-stopped';
}
