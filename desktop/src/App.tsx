import { useEffect, useState } from 'react';
import { bootstrapApp, useAppStore, type AppView } from './store/useAppStore';
import { translate } from './i18n';
import { LiveView } from './views/LiveView';
import { SettingsView } from './views/SettingsView';
import { HistoryView } from './views/HistoryView';
import { DiagnosticsView } from './views/DiagnosticsView';
import { StatusPill } from './components/StatusPill';

const VIEWS: AppView[] = ['live', 'history', 'settings', 'diagnostics'];

function Onboarding() {
  const [step, setStep] = useState(0);
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const finish = useAppStore((s) => s.finishOnboarding);
  const openPermissions = useAppStore((s) => s.openPermissionSettings);
  const refreshHealth = useAppStore((s) => s.refreshHealth);
  const t = (key: Parameters<typeof translate>[1]) => translate(settings.locale, key);

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="brand-mark">D</div>
        <h1>{t('onboardingTitle')}</h1>
        <div className="steps">
          <span className={step >= 0 ? 'active' : ''} />
          <span className={step >= 1 ? 'active' : ''} />
          <span className={step >= 2 ? 'active' : ''} />
        </div>

        {step === 0 && (
          <div className="onboarding-step">
            <h2>{t('onboarding1')}</h2>
            <label className="field">
              <span>{t('sourceLanguage')}</span>
              <select value={settings.language} onChange={(e) => setSettings({ language: e.target.value })}>
                <option value="auto">Auto</option>
                <option value="en">English</option>
                <option value="vi">Tiếng Việt</option>
                <option value="ja">日本語</option>
                <option value="zh">中文</option>
                <option value="ko">한국어</option>
              </select>
            </label>
            <label className="field">
              <span>{t('targetLanguage')}</span>
              <select value={settings.targetLanguage} onChange={(e) => setSettings({ targetLanguage: e.target.value })}>
                <option value="vi">Tiếng Việt</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
              </select>
            </label>
            <label className="field">
              <span>{t('translator')}</span>
              <select
                value={settings.translationProvider}
                onChange={(e) => setSettings({ translationProvider: e.target.value as typeof settings.translationProvider })}
              >
                <option value="gemini">Gemini (text)</option>
                <option value="openai">OpenAI (text)</option>
                <option value="none">{t('notSupportedOffline').split('.')[0]}</option>
              </select>
            </label>
            {settings.translationProvider !== 'none' && (
              <label className="field">
                <span>{t('apiKey')}</span>
                <input
                  type="password"
                  value={settings.apiKeys[settings.translationProvider]}
                  placeholder="AIza… / sk-…"
                  onChange={(e) =>
                    setSettings({
                      apiKeys: { ...settings.apiKeys, [settings.translationProvider]: e.target.value },
                    })
                  }
                />
                <small>Audio không rời máy; chỉ câu văn bản đã nhận dạng được gửi để dịch.</small>
              </label>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="onboarding-step">
            <h2>{t('onboarding2')}</h2>
            <div className="permission-card">
              <div className="permission-icon">🔒</div>
              <p>
                macOS cần quyền <strong>Screen &amp; System Audio Recording</strong> để bridge nghe được
                âm thanh từ Zoom, Meet, Teams… Chỉ cần cấp một lần.
              </p>
              <button className="button primary" onClick={() => void openPermissions()}>
                {t('openSettings')}
              </button>
              <button className="button ghost" onClick={() => void refreshHealth()}>
                {t('retry')}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-step">
            <h2>{t('onboarding3')}</h2>
            <ul className="summary-list">
              <li>ASR: {settings.family}</li>
              <li>{t('sourceLanguage')}: {settings.language}</li>
              <li>{t('translationLabel')}: {settings.targetLanguage} ({settings.translationProvider})</li>
              <li>⌥⇧C — bật/tắt phụ đề · ⌥⇧O — overlay</li>
            </ul>
          </div>
        )}

        <div className="onboarding-actions">
          {step > 0 && (
            <button className="button ghost" onClick={() => setStep(step - 1)}>
              {t('back')}
            </button>
          )}
          {step < 2 ? (
            <button className="button primary" onClick={() => setStep(step + 1)}>
              {t('next')}
            </button>
          ) : (
            <button className="button primary" onClick={finish}>
              {t('done')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const onboardingDone = useAppStore((s) => s.onboardingDone);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const locale = useAppStore((s) => s.settings.locale);
  const version = useAppStore((s) => s.version);

  useEffect(() => {
    bootstrapApp();
  }, []);

  if (!onboardingDone) return <Onboarding />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark small">D</div>
          <div>
            <strong>{translate(locale, 'appName')}</strong>
            <small>v{version}</small>
          </div>
        </div>
        <nav>
          {VIEWS.map((item) => (
            <button
              key={item}
              className={`nav-item ${view === item ? 'active' : ''}`}
              onClick={() => setView(item)}
            >
              <span className="nav-icon">
                {item === 'live' ? '◉' : item === 'history' ? '▤' : item === 'settings' ? '⚙' : '✚'}
              </span>
              {translate(locale, `tab${item.charAt(0).toUpperCase()}${item.slice(1)}` as Parameters<typeof translate>[1])}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <StatusPill compact />
          <small>{translate(locale, 'tagline')}</small>
        </div>
      </aside>
      <main className="content">
        {view === 'live' && <LiveView />}
        {view === 'history' && <HistoryView />}
        {view === 'settings' && <SettingsView />}
        {view === 'diagnostics' && <DiagnosticsView />}
      </main>
    </div>
  );
}
