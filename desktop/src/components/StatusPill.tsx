import { useAppStore } from '../store/useAppStore';
import { translate } from '../i18n';

export function StatusPill({ compact = false }: { compact?: boolean }) {
  const connection = useAppStore((s) => s.connection);
  const sessionActive = useAppStore((s) => s.sessionActive);
  const health = useAppStore((s) => s.health);
  const locale = useAppStore((s) => s.settings.locale);

  const state = sessionActive && connection === 'online' ? 'live' : connection;
  const label =
    state === 'live'
      ? translate(locale, 'online')
      : state === 'online'
        ? 'Ready'
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
