import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { translate } from '../i18n';
import { StatusPill } from '../components/StatusPill';
import { formatTimestamp } from '../history/export';
import { DUOSUB_INSTALL_COMMAND, DUOSUB_RELEASES_URL } from '../bridge/install';
import { writeTextToClipboard } from '../platform/tauri';

export function LiveView() {
  const rows = useAppStore((s) => s.rows);
  const sessionActive = useAppStore((s) => s.sessionActive);
  const connection = useAppStore((s) => s.connection);
  const health = useAppStore((s) => s.health);
  const lastError = useAppStore((s) => s.lastError);
  const warnings = useAppStore((s) => s.warnings);
  const overlayVisible = useAppStore((s) => s.overlayVisible);
  const settings = useAppStore((s) => s.settings);
  const start = useAppStore((s) => s.start);
  const stop = useAppStore((s) => s.stop);
  const toggleOverlay = useAppStore((s) => s.toggleOverlay);
  const copyTranscript = useAppStore((s) => s.copyTranscript);
  const openPermissions = useAppStore((s) => s.openPermissionSettings);
  const setView = useAppStore((s) => s.setView);
  const listRef = useRef<HTMLDivElement>(null);
  const t = (key: Parameters<typeof translate>[1]) => translate(settings.locale, key);

  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [rows.length]);

  const visible = rows.slice(-60);
  const permissionDenied = health?.system_audio === 'denied';

  return (
    <div className="view live-view">
      <header className="view-header">
        <div>
          <h1>{t('tabLive')}</h1>
          <p className="muted">{health?.model_id ?? t('bridgeMissing')}</p>
        </div>
        <div className="header-actions">
          <StatusPill />
          <button className="button ghost" onClick={() => void toggleOverlay()}>
            {overlayVisible ? t('hideOverlay') : t('showOverlay')}
          </button>
          <button className="button ghost" onClick={() => void copyTranscript()} disabled={rows.length === 0}>
            {t('copyTranscript')}
          </button>
          <button
            className={`button ${sessionActive ? 'danger' : 'primary'}`}
            onClick={() => void (sessionActive ? stop() : start())}
          >
            {sessionActive ? `■ ${t('stop')}` : `▶ ${t('start')}`}
          </button>
        </div>
      </header>

      {connection === 'offline' && (
        <div className="alert warning">
          <div>
            <strong>{t('bridgeMissing')}</strong>
            <p>{t('bridgeMissingHint')}</p>
            <code>{DUOSUB_INSTALL_COMMAND}</code>
          </div>
          <div className="alert-actions">
            <button className="button ghost" onClick={() => void writeTextToClipboard(DUOSUB_INSTALL_COMMAND)}>
              Copy
            </button>
            <a className="button ghost" href={DUOSUB_RELEASES_URL} target="_blank" rel="noreferrer">
              {t('installBridge')}
            </a>
          </div>
        </div>
      )}

      {permissionDenied && (
        <div className="alert warning">
          <div>
            <strong>{t('permissionNeeded')}</strong>
            <p>System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording → DuoSub Bridge</p>
          </div>
          <button className="button primary" onClick={() => void openPermissions()}>{t('openSettings')}</button>
        </div>
      )}

      {lastError !== '' && (
        <div className="alert error">
          <strong>{t('error')}</strong> {lastError}
        </div>
      )}

      {warnings.map((warning, index) => (
        <div className="alert info" key={`${warning}-${index}`}>{warning}</div>
      ))}

      <div className="caption-list" ref={listRef}>
        {visible.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">◉</div>
            <h2>{t('captionEmpty')}</h2>
            <p>{t('captionPlaceholder')}</p>
            <button className="button ghost" onClick={() => setView('settings')}>{t('settingsTitle')}</button>
          </div>
        ) : (
          visible.map((row) => (
            <article className={`caption-row ${row.final ? 'final' : 'partial'}`} key={row.id}>
              <div className="caption-meta">
                <span className="caption-time">{formatTimestamp(row.t0Ms, '.')}</span>
                <span className="badge">{row.source}</span>
                {row.speaker !== undefined && <span className="badge">spk {row.speaker}</span>}
                {!row.final && <span className="badge live">partial</span>}
              </div>
              {settings.showSource && <div className="caption-source">{row.sourceText}</div>}
              <div className="caption-translated">
                {row.translatedText !== '' ? (
                  <>
                    {settings.showSource && <span className="arrow">→ </span>}
                    {row.translatedText}
                  </>
                ) : row.translationState === 'pending' ? (
                  <span className="muted">…</span>
                ) : row.translationState === 'error' ? (
                  <span className="muted small">{t('error')}</span>
                ) : null}
                {row.translationState === 'streaming' && <span className="typing-dot" />}
              </div>
            </article>
          ))
        )}
      </div>
      <footer className="view-footer">
        <span>{rows.length} utterances · {health?.family ?? '—'}</span>
        <span>{health?.session?.segment_count ?? 0} segments reported by bridge</span>
      </footer>
    </div>
  );
}
