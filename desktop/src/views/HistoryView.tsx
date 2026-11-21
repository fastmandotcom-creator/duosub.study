import { useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { translate } from '../i18n';
import { exportCaptions, formatTimestamp, type ExportFormat } from '../history/export';
import { saveTextFile } from '../platform/tauri';
import type { CaptionRow } from '../caption/captionEngine';

const EXPORT_KEYS: Record<ExportFormat, 'exportSrt' | 'exportVtt' | 'exportTxt'> = {
  srt: 'exportSrt',
  vtt: 'exportVtt',
  txt: 'exportTxt',
};

function ExportButtons({ rows, locale }: { rows: readonly CaptionRow[]; locale: 'en' | 'vi' }) {
  const includeSource = useAppStore((s) => s.settings.includeSourceInExport);
  const formats: ExportFormat[] = ['srt', 'vtt', 'txt'];
  return (
    <div className="export-buttons">
      {formats.map((format) => (
        <button
          key={format}
          className="button tiny ghost"
          disabled={rows.length === 0}
          onClick={() => {
            const content = exportCaptions(rows, format, includeSource);
            void saveTextFile(`duosub-${Date.now()}.${format}`, content, format === 'txt' ? 'text/plain' : 'text/plain');
          }}
        >
          {translate(locale, EXPORT_KEYS[format])}
        </button>
      ))}
    </div>
  );
}

export function HistoryView() {
  const sessions = useAppStore((s) => s.sessions);
  const rows = useAppStore((s) => s.rows);
  const locale = useAppStore((s) => s.settings.locale);
  const clearHistory = useAppStore((s) => s.clearHistory);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return sessions;
    return sessions.filter((session) =>
      session.rows.some(
        (row) => row.sourceText.toLowerCase().includes(needle) || row.translatedText.toLowerCase().includes(needle),
      ),
    );
  }, [sessions, query]);

  return (
    <div className="view history-view">
      <header className="view-header">
        <div>
          <h1>{t('historyTitle')}</h1>
          <p className="muted">{sessions.length} phiên đã lưu trên máy này.</p>
        </div>
        <div className="header-actions">
          <input className="search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="button ghost" onClick={clearHistory} disabled={sessions.length === 0}>{t('clearData')}</button>
        </div>
      </header>

      <section className="settings-section">
        <div className="section-head">
          <h2>Phiên hiện tại</h2>
          <p className="muted">{rows.length} utterances</p>
        </div>
        <div className="section-body">
          <ExportButtons rows={rows} locale={locale} />
          {rows.slice(0, 5).map((row) => (
            <div className="history-line" key={row.id}>
              <span>{formatTimestamp(row.t0Ms, '.')}</span>
              <span>{row.sourceText}</span>
              <span className="accent">→ {row.translatedText || '…'}</span>
            </div>
          ))}
        </div>
      </section>

      {filtered.length === 0 ? (
        <div className="empty-state"><h2>{t('noHistory')}</h2></div>
      ) : (
        filtered.map((session) => {
          const isOpen = expanded === session.id;
          const matchingRows = query.trim() === ''
            ? session.rows
            : session.rows.filter(
                (row) =>
                  row.sourceText.toLowerCase().includes(query.toLowerCase()) ||
                  row.translatedText.toLowerCase().includes(query.toLowerCase()),
              );
          return (
            <section className="settings-section" key={session.id}>
              <div className="section-head row-between">
                <div>
                  <h2>{new Date(session.startedAt).toLocaleString()} · {session.language}</h2>
                  <p className="muted">{session.family} · {session.rows.length} utterances</p>
                </div>
                <div className="header-actions">
                  <ExportButtons rows={matchingRows} locale={locale} />
                  <button className="button ghost" onClick={() => setExpanded(isOpen ? null : session.id)}>
                    {isOpen ? '▴' : '▾'}
                  </button>
                </div>
              </div>
              {isOpen && (
                <div className="section-body transcript">
                  {matchingRows.map((row) => (
                    <div className="history-line" key={row.id}>
                      <span>{formatTimestamp(row.t0Ms, '.')}</span>
                      <span>{row.sourceText}</span>
                      <span className="accent">→ {row.translatedText}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
