/**
 * Single source of truth for "should the app start / restart the bridge session?".
 *
 * Pure so the lifecycle rules can be tested without a webview, a bridge, or macOS permissions.
 * Everything that can trigger a start goes through `decideSessionAction` — there must be no other
 * place calling `start()` implicitly.
 */

export interface SessionSnapshot {
  /** Onboarding finished. */
  onboardingDone: boolean;
  /** User wants the session warmed at launch and kept alive. */
  autoStart: boolean;
  /** Selected caption source. */
  engine: 'system-live' | 'bridge-asr';
  /** App's own view of whether a session is running. */
  localActive: boolean;
  /** App is already inside a start() call. */
  starting: boolean;
  /** What `/health` reports right now. */
  healthReachable: boolean;
  healthSessionActive: boolean;
  /** Milliseconds since the previous automatic attempt. */
  sinceLastAttemptMs: number;
}

export type SessionAction = 'start' | 'wait';

export const RETRY_INTERVAL_MS = 15_000;

export function decideSessionAction(s: SessionSnapshot): SessionAction {
  if (!s.onboardingDone || !s.autoStart) return 'wait';
  if (s.engine !== 'bridge-asr') return 'wait';
  if (!s.healthReachable) return 'wait';
  if (s.starting || s.localActive || s.healthSessionActive) return 'wait';
  // Throttle, but never give up: the bridge's orphan reaper can stop the session at any time.
  if (s.sinceLastAttemptMs < RETRY_INTERVAL_MS) return 'wait';
  return 'start';
}
