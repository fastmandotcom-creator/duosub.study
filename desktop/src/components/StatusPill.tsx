import { useAppStore } from '../store/useAppStore';
import { translate } from '../i18n';

export function StatusPill({ compact = false }: { compact?: boolean }) {
  const connection = useAppStore((s) => s.connection);
  const sessionActive = useAppStore((s) => s.sessionActive);
  const starting = useAppStore((s) => s.starting);
  const captionEngine = useAppStore((s) => s.settings.captionEngine);
  const rowCount = useAppStore((s) => s.rows.length);
  const health = useAppStore((s) => s.health);
  const locale = useAppStore((s) => s.settings.locale);

  // /health is the source of truth: a replayed caption list or a stale local flag must never
  // claim a session is live when the bridge reports none.
  const bridgeSessionActive = health?.session?.active === true;
  const state = starting
    ? 'starting'
    : (captionEngine === 'system-live' && rowCount > 0) || (sessionActive && bridgeSessionActive)
      ? 'live'
      : connection === 'online' && bridgeSessionActive
        ? 'live'
        : connection;
  const label =
    state === 'starting'
      ? translate(locale, 'starting')
      : state === 'live'
        ? translate(locale, 'online')
        : state === 'online'
        ? translate(locale, 'readyToStart')
        : state === 'checking'
          ? 'Checking…'
          : state === 'reconnecting'
            ? translate(locale, 'reconnecting')
            : state === 'error'
              ? translate(locale, 'error')
              : translate(locale, 'offline');

  return (
    <div className={`status-pill status-${state} ${compact ? 'compact' : ''}`} title={health?.model_id ?? ''}>
      <span className="status-dot" />
      {label}
      {health !== null && !compact && <span className="status-model">{health.family}</span>}
    </div>
  );
}
