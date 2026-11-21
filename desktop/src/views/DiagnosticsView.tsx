import { useAppStore } from '../store/useAppStore';
import { translate } from '../i18n';
import { buildDiagnosticReport } from '../diagnostics/diagnostics';
import { installHintFor } from '../bridge/install';
import { OS_LABEL } from '../platform/os';
import { writeTextToClipboard } from '../platform/tauri';

export function DiagnosticsView() {
  const health = useAppStore((s) => s.health);
  const connection = useAppStore((s) => s.connection);
  const frontmostApp = useAppStore((s) => s.frontmostApp);
  const activeProfileId = useAppStore((s) => s.activeProfileId);
  const rows = useAppStore((s) => s.rows);
  const lastError = useAppStore((s) => s.lastError);
  const settings = useAppStore((s) => s.settings);
  const host = useAppStore((s) => s.host);
  const version = useAppStore((s) => s.version);
  const checkForUpdates = useAppStore((s) => s.checkForUpdates);
  const t = (key: Parameters<typeof translate>[1]) => translate(settings.locale, key);

  const report = buildDiagnosticReport({
    health,
    bridgeUrl: settings.bridgeUrl,
    connection,
    frontmostApp,
    profileId: activeProfileId,
    appVersion: version,
    rowsInMemory: rows.length,
    lastError,
    host,
    captionEngine: settings.captionEngine,
  });

  return (
    <div className="view diagnostics-view">
      <header className="view-header">
        <div>
          <h1>{t('diagnosticsTitle')}</h1>
          <p className="muted">Một cú chạm để copy đủ trạng thái bridge, quyền và cấu hình.</p>
        </div>
        <div className="header-actions">
          <button className="button primary" onClick={() => void writeTextToClipboard(report)}>{t('copyReport')}</button>
          <button className="button ghost" onClick={() => void checkForUpdates()}>Check updates</button>
        </div>
      </header>

      <section className="settings-section">
        <div className="section-head"><h2>Report</h2></div>
        <div className="section-body">
          <textarea className="report" readOnly value={report} rows={24} />
        </div>
      </section>

      <section className="settings-section">
        <div className="section-head"><h2>{t('installBridge')}</h2></div>
        <div className="section-body">
          <code className="code-block">{installHintFor(host).command ?? installHintFor(host).note}</code>
          <p className="muted">
            {host === 'macos'
              ? 'Log bridge: ~/Library/Logs/duosub-bridge.log'
              : `Host: ${OS_LABEL[host]} · log do bridge ghi theo OS tương ứng.`}
          </p>
        </div>
      </section>
    </div>
  );
}
