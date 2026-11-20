import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { BridgeEvent, HealthResponse } from '@duosub/caption-contract';
import { BridgeClient, BridgeCallError, type BridgeConnectionState } from '../bridge/BridgeClient';
import {
  applySegment,
  setTranslation,
  type CaptionRow,
  type TranslationState,
} from '../caption/captionEngine';
import { emitSafe, invokeSafe } from '../platform/tauri';
import { DEFAULT_PROFILES, matchProfile, type Profile } from '../profiles/profiles';
import { translate, type Locale } from '../i18n';
import { capabilitiesFor, defaultFamilyFor, detectHostOS, type HostCapabilities, type HostOS } from '../platform/os';
import { CloudTranslator, NoopTranslator } from '../translation/cloudTranslator';
import { TranslationPipeline } from '../translation/pipeline';
import type { Translator, TranslationProvider } from '../translation/types';
import { applyVocabulary, type VocabularyEntry } from '../vocabulary/vocabulary';

export interface Settings {
  bridgeUrl: string;
  bridgeToken: string;
  language: string;
  family: string;
  targetLanguage: string;
  translationProvider: TranslationProvider;
  apiKeys: Record<'gemini' | 'openai', string>;
  models: Record<'gemini' | 'openai', string>;
  overlayEnabled: boolean;
  autostart: boolean;
  hotkeysEnabled: boolean;
  locale: Locale;
  showSource: boolean;
  includeSourceInExport: boolean;
  fontSize: number;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  language: string;
  family: string;
  profileId: string;
  rows: CaptionRow[];
}

export type AppView = 'live' | 'history' | 'settings' | 'diagnostics';

export interface AppState {
  settings: Settings;
  onboardingDone: boolean;
  view: AppView;
  connection: BridgeConnectionState;
  health: HealthResponse | null;
  lastSeq: number;
  rows: CaptionRow[];
  sessionId: string;
  sessionActive: boolean;
  lastError: string;
  warnings: string[];
  profiles: Profile[];
  activeProfileId: string;
  frontmostApp: string;
  autoProfile: boolean;
  vocabulary: VocabularyEntry[];
  sessions: SessionRecord[];
  overlayVisible: boolean;
  version: string;
  host: HostOS;
  capabilities: HostCapabilities;

  init: () => void;
  setView: (view: AppView) => void;
  setSettings: (patch: Partial<Settings>) => void;
  finishOnboarding: () => void;
  refreshHealth: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  selectFamily: (family: string) => Promise<void>;
  handleEvent: (event: BridgeEvent) => void;
  setTranslation: (id: string, text: string, state: TranslationState) => void;
  openPermissionSettings: () => Promise<void>;
  setOverlayVisible: (visible: boolean) => Promise<void>;
  toggleOverlay: () => Promise<void>;
  setFrontmostApp: (app: string) => void;
  setAutoProfile: (enabled: boolean) => void;
  applyProfile: (id: string) => void;
  saveProfile: (profile: Profile) => void;
  deleteProfile: (id: string) => void;
  addVocabulary: (entry: Omit<VocabularyEntry, 'id'>) => void;
  updateVocabulary: (id: string, patch: Partial<VocabularyEntry>) => void;
  deleteVocabulary: (id: string) => void;
  clearSession: () => void;
  clearHistory: () => void;
  copyTranscript: () => Promise<void>;
  checkForUpdates: () => Promise<string>;
}

export const DEFAULT_SETTINGS: Settings = {
  bridgeUrl: 'http://127.0.0.1:4499',
  bridgeToken: '',
  language: 'auto',
  family: 'apple-speech',
  targetLanguage: 'vi',
  translationProvider: 'gemini',
  apiKeys: { gemini: '', openai: '' },
  models: { gemini: '', openai: '' },
  overlayEnabled: true,
  autostart: false,
  hotkeysEnabled: true,
  locale: 'vi',
  showSource: true,
  includeSourceInExport: true,
  fontSize: 18,
};

const APP_VERSION = '1.0.0';
const STREAM_KEY = 'duosub.desktop.v1';

/** Before the native shell answers, the UA is the only host hint available. */
const INITIAL_HOST = detectHostOS(null, typeof navigator === 'undefined' ? '' : navigator.userAgent);
const BASE_SETTINGS: Settings = { ...DEFAULT_SETTINGS, family: defaultFamilyFor(INITIAL_HOST) };

let client = new BridgeClient(DEFAULT_SETTINGS.bridgeUrl, DEFAULT_SETTINGS.bridgeToken);
let unsubscribeStream: (() => void) | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let frontmostTimer: ReturnType<typeof setInterval> | null = null;
let pipeline: TranslationPipeline | null = null;
let currentTranslator: Translator | null = null;
let bridgeSpawnAttempted = false;
let leaseTimer: ReturnType<typeof setInterval> | null = null;

function buildTranslator(settings: Settings): Translator | null {
  if (settings.translationProvider === 'none') return new NoopTranslator();
  const key = settings.apiKeys[settings.translationProvider].trim();
  if (key === '') return null;
  return new CloudTranslator({
    provider: settings.translationProvider,
    apiKey: key,
    model: settings.models[settings.translationProvider].trim() || undefined,
  });
}

function mapWarning(code: string, locale: Locale): string {
  switch (code) {
    case 'microphone-unavailable':
      return translate(locale, 'micUnavailable');
    default:
      return code;
  }
}

const id = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => {
      const emitCaption = () => {
        const state = get();
        void emitSafe('duosub:caption', {
          rows: state.rows.slice(-2),
          visible: state.overlayVisible,
          showSource: state.settings.showSource,
          fontSize: state.settings.fontSize,
        });
      };

      const restartStream = () => {
        unsubscribeStream?.();
        unsubscribeStream = null;
        const state = get();
        client = new BridgeClient(state.settings.bridgeUrl, state.settings.bridgeToken);
        unsubscribeStream = client.subscribe({
          onEvent: (event) => get().handleEvent(event),
          onState: (connection) => set({ connection }),
          getSince: () => get().lastSeq,
        });
      };

      const reconfigurePipeline = () => {
        const state = get();
        currentTranslator = buildTranslator(state.settings);
        pipeline?.configure(currentTranslator, state.settings.targetLanguage);
        if (currentTranslator === null) {
          set({
            rows: state.rows.map((row) =>
              row.translationState === 'pending' || row.translationState === 'streaming'
                ? { ...row, translationState: 'error' as const }
                : row,
            ),
          });
        }
      };

      return {
        settings: BASE_SETTINGS,
        onboardingDone: false,
        view: 'live',
        connection: 'offline',
        health: null,
        lastSeq: 0,
        rows: [],
        sessionId: '',
        sessionActive: false,
        lastError: '',
        warnings: [],
        profiles: DEFAULT_PROFILES,
        activeProfileId: 'default',
        frontmostApp: '',
        autoProfile: true,
        vocabulary: [],
        sessions: [],
        overlayVisible: false,
        version: APP_VERSION,
        host: INITIAL_HOST,
        capabilities: capabilitiesFor(INITIAL_HOST),

        init: () => {
          if (pipeline !== null) return;
          void invokeSafe<{ os: string }>('host_info').then((info) => {
            if (info?.os === undefined) return;
            const host = detectHostOS(info.os);
            if (host !== get().host) set({ host, capabilities: capabilitiesFor(host) });
          });
          pipeline = new TranslationPipeline(currentTranslator, get().settings.targetLanguage, {
            onUpdate: (rowId, text, state) => get().setTranslation(rowId, text, state),
            debounceMs: 350,
          });
          reconfigurePipeline();
          restartStream();
          void get().refreshHealth();
          healthTimer = setInterval(() => void get().refreshHealth(), 5000);
          frontmostTimer = setInterval(async () => {
            const name = await invokeSafe<string>('get_frontmost_app');
            if (typeof name === 'string' && name !== '' && name !== get().frontmostApp) {
              get().setFrontmostApp(name);
            }
          }, 2500);

          // Mirrored from the native side: tray / hotkeys ask the webview to change state.
          void import('../platform/tauri').then(({ listenSafe }) => {
            void listenSafe< string>('duosub:toggle-overlay', () => void get().toggleOverlay());
            void listenSafe<string>('duosub:start-stop', () => {
              if (get().sessionActive) void get().stop();
              else void get().start();
            });
            void listenSafe<string>('duosub:copy-transcript', () => void get().copyTranscript());
          });
        },

        setView: (view) => set({ view }),

        setSettings: (patch) => {
          const before = get().settings;
          const settings = { ...before, ...patch };
          set({ settings, lastError: '' });
          if (
            patch.bridgeUrl !== undefined ||
            patch.bridgeToken !== undefined
          ) {
            restartStream();
            void get().refreshHealth();
          }
          if (
            patch.translationProvider !== undefined ||
            patch.targetLanguage !== undefined ||
            patch.apiKeys !== undefined ||
            patch.models !== undefined
          ) {
            reconfigurePipeline();
          }
          if (patch.autostart !== undefined) {
            void invokeSafe('set_autostart', { enabled: patch.autostart });
          }
          if (patch.hotkeysEnabled !== undefined) {
            void invokeSafe('set_hotkeys', { enabled: patch.hotkeysEnabled });
          }
          if (patch.overlayEnabled !== undefined && patch.overlayEnabled === false) {
            void get().setOverlayVisible(false);
          }
        },

        finishOnboarding: () => {
          set({ onboardingDone: true });
          if (get().settings.autostart) void invokeSafe('set_autostart', { enabled: true });
          if (get().settings.hotkeysEnabled) void invokeSafe('set_hotkeys', { enabled: true });
        },

        refreshHealth: async () => {
          try {
            const health = await client.health();
            const host = detectHostOS(health.platform);
            set({
              health,
              connection: 'online',
              lastError: '',
              ...(host !== get().host ? { host, capabilities: capabilitiesFor(host) } : {}),
            });
            return;
          } catch (error) {
            // First offline tick: ask the native shell to spawn the bundled/local bridge once.
            if (!bridgeSpawnAttempted) {
              bridgeSpawnAttempted = true;
              const started = await invokeSafe<string>('start_bridge');
              if (started !== null) {
                await new Promise((resolve) => setTimeout(resolve, 700));
                try {
                  const health = await client.health();
                  set({ health, connection: 'online', lastError: '' });
                  return;
                } catch {
                  // fall through to the offline banner
                }
              }
            }
            set({
              health: null,
              connection: error instanceof BridgeCallError ? 'offline' : 'error',
            });
          }
        },

        start: async () => {
          const state = get();
          set({ lastError: '', warnings: [] });
          try {
            let health: HealthResponse;
            try {
              health = await client.health();
            } catch {
              throw new BridgeCallError(translate(state.settings.locale, 'bridgeMissing'));
            }
            if (health.system_audio === 'denied') {
              throw new BridgeCallError(translate(state.settings.locale, 'permissionNeeded'));
            }
            if (!(await client.claimOwner())) {
              throw new BridgeCallError('Bridge đang được điều khiển bởi client khác. Hãy dừng caption bên kia trước.');
            }
            set({ health });

            let family = state.settings.family;
            const routed =
              family === 'apple-speech' &&
              (!state.capabilities.appleSpeech ||
                health.apple_speech_available === false ||
                (state.settings.language !== 'auto' &&
                  !health.supported_languages.includes(state.settings.language)));
            if (routed) family = 'whisper-medium';

            if (health.family !== family) {
              const supported = await client.selectModel(family);
              set({
                health: { ...health, family, supported_languages: supported },
              });
            }
            if (routed) {
              set({ warnings: [translate(state.settings.locale, 'familyAutoRouted')] });
            }

            const result = await client.startSession({
              language: state.settings.language,
              sources: [],
              mode: 'asr',
            });
            set({
              rows: [],
              sessionId: result.sessionId,
              sessionActive: true,
              lastSeq: 0,
              warnings: [
                ...get().warnings,
                ...result.warnings.map((code) => mapWarning(code, state.settings.locale)),
              ],
            });
            if (leaseTimer !== null) clearInterval(leaseTimer);
            leaseTimer = setInterval(() => {
              void client.heartbeatOwner().then((alive) => {
                if (!alive) {
                  set({ lastError: 'Mất quyền điều khiển bridge — client khác đã chiếm lease.' });
                  void get().stop();
                }
              });
            }, 10_000);
            if (get().settings.overlayEnabled) await get().setOverlayVisible(true);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            set({ lastError: message, connection: 'error' });
          }
        },

        stop: async () => {
          const state = get();
          if (state.sessionId !== '' && state.rows.length > 0) {
            const record: SessionRecord = {
              id: state.sessionId,
              startedAt: Date.now() - (state.rows.at(-1)?.t1Ms ?? 0),
              endedAt: Date.now(),
              language: state.settings.language,
              family: state.settings.family,
              profileId: state.activeProfileId,
              rows: state.rows,
            };
            set({ sessions: [record, ...state.sessions].slice(0, 50) });
          }
          if (leaseTimer !== null) clearInterval(leaseTimer);
          leaseTimer = null;
          try {
            await client.stopSession();
          } catch (error) {
            set({ lastError: error instanceof Error ? error.message : String(error) });
          }
          await client.releaseOwner();
          set({ sessionActive: false, sessionId: '' });
          await get().setOverlayVisible(false);
        },

        selectFamily: async (family) => {
          try {
            const supported = await client.selectModel(family);
            const health = get().health;
            set({
              settings: { ...get().settings, family },
              health: health === null ? null : { ...health, family, supported_languages: supported },
              lastError: '',
            });
          } catch (error) {
            set({ lastError: error instanceof Error ? error.message : String(error) });
          }
        },

        handleEvent: (event) => {
          if (event.seq <= get().lastSeq) return;
          set({ lastSeq: Math.max(get().lastSeq, event.seq) });
          switch (event.kind) {
            case 'segment': {
              const state = get();
              const rows = applySegment(state.rows, event, event.seq, (text) =>
                applyVocabulary(text, state.vocabulary),
              );
              set({ rows });
              const changed = rows.find((row) => row.seq === event.seq);
              if (changed !== undefined) {
                pipeline?.schedule(changed);
                emitCaption();
              }
              break;
            }
            case 'session_started':
              set({ sessionId: event.session_id, sessionActive: true, rows: [] });
              break;
            case 'session_stopped':
              set({ sessionActive: false });
              break;
            case 'error':
              set({ lastError: event.message });
              break;
            case 'pcm_frame':
              // Cloud-live capture path is handled by the optional cloud STT stage, not by the
              // on-device caption list. Ignored here on purpose.
              break;
          }
        },

        setTranslation: (rowId, text, state) => {
          set({ rows: setTranslation(get().rows, rowId, text, state) });
          emitCaption();
        },

        openPermissionSettings: async () => {
          try {
            await client.openPermissionSettings();
          } catch (error) {
            set({ lastError: error instanceof Error ? error.message : String(error) });
          }
        },

        setOverlayVisible: async (visible) => {
          set({ overlayVisible: visible });
          await invokeSafe('show_overlay', { visible });
          void emitSafe('duosub:overlay-visibility', { visible });
        },

        toggleOverlay: async () => {
          await get().setOverlayVisible(!get().overlayVisible);
        },

        setFrontmostApp: (app) => {
          set({ frontmostApp: app });
          if (!get().autoProfile) return;
          const match = matchProfile(get().profiles, app);
          if (match !== null && match.id !== get().activeProfileId) get().applyProfile(match.id);
        },

        setAutoProfile: (enabled) => set({ autoProfile: enabled }),

        applyProfile: (profileId) => {
          const profile = get().profiles.find((item) => item.id === profileId);
          if (profile === undefined) return;
          set({ activeProfileId: profileId });
          get().setSettings({
            language: profile.language,
            family: profile.family,
            translationProvider: profile.translationProvider,
            targetLanguage: profile.targetLanguage,
            overlayEnabled: profile.overlayEnabled,
          });
        },

        saveProfile: (profile) => {
          const profiles = get().profiles;
          const index = profiles.findIndex((item) => item.id === profile.id);
          const next = index === -1 ? [...profiles, profile] : profiles.map((p) => (p.id === profile.id ? profile : p));
          set({ profiles: next });
        },

        deleteProfile: (profileId) => {
          if (profileId === 'default') return;
          set({
            profiles: get().profiles.filter((p) => p.id !== profileId),
            activeProfileId: get().activeProfileId === profileId ? 'default' : get().activeProfileId,
          });
        },

        addVocabulary: (entry) => {
          set({ vocabulary: [...get().vocabulary, { ...entry, id: id() }] });
        },

        updateVocabulary: (entryId, patch) => {
          set({ vocabulary: get().vocabulary.map((item) => (item.id === entryId ? { ...item, ...patch } : item)) });
        },

        deleteVocabulary: (entryId) => {
          set({ vocabulary: get().vocabulary.filter((item) => item.id !== entryId) });
        },

        clearSession: () => {
          pipeline?.cancelAll();
          set({ rows: [], sessionId: '', sessionActive: false });
          void get().setOverlayVisible(false);
        },

        clearHistory: () => set({ sessions: [] }),

        copyTranscript: async () => {
          const text = get()
            .rows.map((row) => (row.translatedText !== '' ? row.translatedText : row.sourceText))
            .join('\n');
          if (text === '') return;
          const { writeTextToClipboard } = await import('../platform/tauri');
          await writeTextToClipboard(text);
        },

        checkForUpdates: async () => {
          const result = await invokeSafe<string | null>('check_updates');
          return result ?? 'Không thể kiểm tra cập nhật trong chế độ dev.';
        },
      };
    },
    {
      name: STREAM_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        settings: state.settings,
        onboardingDone: state.onboardingDone,
        profiles: state.profiles,
        activeProfileId: state.activeProfileId,
        autoProfile: state.autoProfile,
        vocabulary: state.vocabulary,
        sessions: state.sessions,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          ...saved,
          settings: {
            ...BASE_SETTINGS,
            ...saved.settings,
            apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...saved.settings?.apiKeys },
            models: { ...DEFAULT_SETTINGS.models, ...saved.settings?.models },
          },
        };
      },
    },
  ),
);

/** Called once after rehydration so the pipeline sees the persisted translator/key. */
export function bootstrapApp(): void {
  useAppStore.getState().init();
}

/** Stops every background loop. Used in tests and when the webview is torn down. */
export function disposeApp(): void {
  if (healthTimer !== null) clearInterval(healthTimer);
  if (frontmostTimer !== null) clearInterval(frontmostTimer);
  unsubscribeStream?.();
  unsubscribeStream = null;
  if (leaseTimer !== null) clearInterval(leaseTimer);
  leaseTimer = null;
  pipeline?.cancelAll();
  void client.releaseOwner();
  healthTimer = null;
  frontmostTimer = null;
}
