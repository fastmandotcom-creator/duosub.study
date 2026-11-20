import { useState, type ReactNode } from 'react';
import { useAppStore } from '../store/useAppStore';
import { translate } from '../i18n';
import type { TranslationProvider } from '../translation/types';
import type { Profile } from '../profiles/profiles';
import { OS_LABEL } from '../platform/os';

const FAMILIES = [
  { id: 'apple-speech', label: 'Apple Speech (on-device)', hint: 'macOS 26+ · không tải model · en/zh/ja/ko/yue' },
  { id: 'sense-voice', label: 'SenseVoice (fast)', hint: 'Nhanh · zh/en/ja/ko/yue · không có tiếng Việt' },
  { id: 'whisper-medium', label: 'Whisper medium', hint: '~99 ngôn ngữ, có tiếng Việt · cân bằng' },
  { id: 'whisper-large-v3', label: 'Whisper large-v3', hint: 'Chính xác nhất · tải ~1.8 GB' },
  { id: 'auto', label: 'Auto (SenseVoice)', hint: 'Mặc định cũ của bridge' },
] as const;

function Section({ title, children, subtitle }: { title: string; children: ReactNode; subtitle?: string }) {
  return (
    <section className="settings-section">
      <div className="section-head">
        <h2>{title}</h2>
        {subtitle !== undefined && <p className="muted">{subtitle}</p>}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-knob" /></span>
      <span>
        <strong>{label}</strong>
        {hint !== undefined && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function SettingsView() {
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const health = useAppStore((s) => s.health);
  const host = useAppStore((s) => s.host);
  const capabilities = useAppStore((s) => s.capabilities);
  const profiles = useAppStore((s) => s.profiles);
  const activeProfileId = useAppStore((s) => s.activeProfileId);
  const autoProfile = useAppStore((s) => s.autoProfile);
  const setAutoProfile = useAppStore((s) => s.setAutoProfile);
  const applyProfile = useAppStore((s) => s.applyProfile);
  const saveProfile = useAppStore((s) => s.saveProfile);
  const deleteProfile = useAppStore((s) => s.deleteProfile);
  const vocabulary = useAppStore((s) => s.vocabulary);
  const addVocabulary = useAppStore((s) => s.addVocabulary);
  const updateVocabulary = useAppStore((s) => s.updateVocabulary);
  const deleteVocabulary = useAppStore((s) => s.deleteVocabulary);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const t = (key: Parameters<typeof translate>[1]) => translate(settings.locale, key);

  const family = FAMILIES.find((item) => item.id === settings.family) ?? FAMILIES[0];
  const appleUnsupported = settings.family === 'apple-speech' && health?.apple_speech_available === false;

  return (
    <div className="view settings-view">
      <header className="view-header">
        <div>
          <h1>{t('settingsTitle')}</h1>
          <p className="muted">Cấu hình được lưu ngay lập tức trên máy này.</p>
        </div>
      </header>

      <Section
        title="Caption source"
        subtitle={`${OS_LABEL[host]} · ${health?.capture_backend ?? 'bridge chưa kết nối'} · ${capabilities.systemAudioCapture ? 'có capture âm thanh hệ thống' : 'chưa có backend capture hệ thống'}`}
      >
        {!capabilities.systemAudioCapture && (
          <div className="alert info">
            Bản port Linux đang dùng micro (cpal); backend PulseAudio/PipeWire cho âm thanh cuộc họp
            sẽ được thêm trong bridge/src/platform.rs.
          </div>
        )}
        <div className="field-grid">
          <label className="field">
            <span>{t('sourceLanguage')}</span>
            <select value={settings.language} onChange={(e) => setSettings({ language: e.target.value })}>
              <option value="auto">Auto-detect</option>
              <option value="en">English</option>
              <option value="vi">Tiếng Việt</option>
              <option value="ja">日本語</option>
              <option value="zh">中文</option>
              <option value="ko">한국어</option>
              <option value="yue">粵語</option>
            </select>
            <small>{t('languageNote')}</small>
          </label>
          <label className="field">
            <span>{t('modelFamily')}</span>
            <select value={settings.family} onChange={(e) => void useAppStore.getState().selectFamily(e.target.value)}>
              {FAMILIES.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                  disabled={item.id === 'apple-speech' && !capabilities.appleSpeech}
                >
                  {item.label}
                </option>
              ))}
            </select>
            <small>{family.hint}</small>
          </label>
        </div>
        {appleUnsupported && <div className="alert info">Apple Speech không có trên bản macOS này — ứng dụng sẽ tự dùng Whisper medium.</div>}
        <label className="field narrow">
          <span>{t('bridgeUrl')}</span>
          <input value={settings.bridgeUrl} onChange={(e) => setSettings({ bridgeUrl: e.target.value })} />
        </label>
      </Section>

      <Section title={t('translator')} subtitle="Chỉ văn bản đã nhận dạng được gửi đi; audio không rời máy.">
        <div className="field-grid">
          <label className="field">
            <span>{t('translator')}</span>
            <select
              value={settings.translationProvider}
              onChange={(e) => setSettings({ translationProvider: e.target.value as TranslationProvider })}
            >
              <option value="gemini">Gemini · text streaming</option>
              <option value="openai">OpenAI · text streaming</option>
              <option value="none">Không dịch</option>
            </select>
          </label>
          <label className="field">
            <span>{t('targetLanguage')}</span>
            <select value={settings.targetLanguage} onChange={(e) => setSettings({ targetLanguage: e.target.value })}>
              <option value="vi">Tiếng Việt</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="zh">中文</option>
              <option value="ko">한국어</option>
            </select>
          </label>
          {settings.translationProvider !== 'none' && (
            <>
              <label className="field">
                <span>{t('apiKey')}</span>
                <input
                  type="password"
                  value={settings.apiKeys[settings.translationProvider]}
                  onChange={(e) =>
                    setSettings({ apiKeys: { ...settings.apiKeys, [settings.translationProvider]: e.target.value } })
                  }
                />
              </label>
              <label className="field">
                <span>{t('modelId')}</span>
                <input
                  placeholder={settings.translationProvider === 'gemini' ? 'gemini-2.5-flash-lite' : 'gpt-4o-mini'}
                  value={settings.models[settings.translationProvider]}
                  onChange={(e) =>
                    setSettings({ models: { ...settings.models, [settings.translationProvider]: e.target.value } })
                  }
                />
              </label>
            </>
          )}
        </div>
      </Section>

      <Section title="Output & hotkeys">
        <Toggle
          checked={settings.showSource}
          onChange={(showSource) => setSettings({ showSource })}
          label={t('showSource')}
          hint="Hiện câu gốc và bản dịch trên cùng một dòng."
        />
        <Toggle
          checked={settings.overlayEnabled}
          onChange={(overlayEnabled) => setSettings({ overlayEnabled })}
          label={t('overlay')}
          hint="Cửa sổ trong suốt, luôn nổi trên mọi ứng dụng."
        />
        <Toggle
          checked={settings.includeSourceInExport}
          onChange={(includeSourceInExport) => setSettings({ includeSourceInExport })}
          label={t('includeSource')}
        />
        <Toggle
          checked={settings.hotkeysEnabled}
          onChange={(hotkeysEnabled) => setSettings({ hotkeysEnabled })}
          label={t('globalHotkeys')}
          hint="⌥⇧C bật/tắt caption · ⌥⇧O overlay · ⌥⇧X copy"
        />
        <Toggle
          checked={settings.autostart}
          onChange={(autostart) => setSettings({ autostart })}
          label={t('autostart')}
        />
        <label className="field narrow">
          <span>{t('fontSize')}: {settings.fontSize}px</span>
          <input
            type="range"
            min={12}
            max={32}
            value={settings.fontSize}
            onChange={(e) => setSettings({ fontSize: Number(e.target.value) })}
          />
        </label>
        <label className="field narrow">
          <span>{t('locale')}</span>
          <select value={settings.locale} onChange={(e) => setSettings({ locale: e.target.value as 'en' | 'vi' })}>
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </select>
        </label>
      </Section>

      <Section title={t('frontmostProfiles')} subtitle={autoProfile ? t('profileAuto') : t('manual')}>
        <Toggle checked={autoProfile} onChange={setAutoProfile} label={t('profileAuto')} />
        <div className="profile-list">
          {profiles.map((profile) => (
            <div className={`profile-card ${profile.id === activeProfileId ? 'active' : ''}`} key={profile.id}>
              <button className="profile-select" onClick={() => applyProfile(profile.id)}>
                <strong>{profile.name}</strong>
                <small>{profile.matchApps.join(', ') || 'fallback'} · {profile.language} → {profile.targetLanguage}</small>
              </button>
              {profile.id !== 'default' && (
                <button className="button tiny ghost" onClick={() => deleteProfile(profile.id)}>{t('clear')}</button>
              )}
            </div>
          ))}
        </div>
        <button
          className="button ghost"
          onClick={() => {
            const profile: Profile = {
              id: `profile-${Date.now()}`,
              name: 'Họp Zoom',
              matchApps: ['zoom'],
              language: 'en',
              family: 'apple-speech',
              translationProvider: 'gemini',
              targetLanguage: 'vi',
              overlayEnabled: true,
            };
            saveProfile(profile);
          }}
        >
          + Thêm profile
        </button>
      </Section>

      <Section title={t('vocabulary')} subtitle="Tên riêng và thuật ngữ được thay thế trước khi dịch.">
        <div className="vocab-add">
          <input placeholder="Từ gốc (vd. Fumihiko)" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input placeholder="Thay thành (vd. Phú Hào)" value={to} onChange={(e) => setTo(e.target.value)} />
          <button
            className="button primary"
            onClick={() => {
              if (from.trim() === '' || to.trim() === '') return;
              addVocabulary({ from: from.trim(), to: to.trim(), enabled: true });
              setFrom('');
              setTo('');
            }}
          >
            + Thêm
          </button>
        </div>
        <div className="vocab-list">
          {vocabulary.length === 0 ? <p className="muted">Chưa có từ nào.</p> : vocabulary.map((entry) => (
            <div className="vocab-row" key={entry.id}>
              <input
                type="checkbox"
                checked={entry.enabled}
                onChange={(e) => updateVocabulary(entry.id, { enabled: e.target.checked })}
              />
              <span>{entry.from}</span>
              <span className="muted">→</span>
              <span>{entry.to}</span>
              <button className="button tiny ghost" onClick={() => deleteVocabulary(entry.id)}>×</button>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
