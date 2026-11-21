import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { BridgeEvent, HealthResponse, StartResult } from '@duosub/caption-contract';
import { BridgeClient, BridgeCallError, type BridgeConnectionState } from '../bridge/BridgeClient';
import { shouldStartForTrigger } from '../session/lifecycle';
import { newLines } from '../caption/systemCaptions';
import {
  appendSystemLine,
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
  /** Pre-warm the ASR session at launch instead of waiting for the first button press. */
  autoStartCaptions: boolean;
  /** Off by default: large saved transcripts were the main source of UI lag. */
  keepHistory: boolean;
  /** Prefer the OS's own captions (no second ASR engine) on macOS. */
  captionEngine: 'system-live' | 'bridge-asr';
  /** Include your own voice. Off by default: this system listens to the meeting/system audio. */
  includeMicrophone: boolean;
  /** Fall back to microphone-only when system audio is temporarily unavailable. Opt-in. */
  fallbackToMicrophone: boolean;
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
  systemLines: string[];
  sessionId: string;
  sessionActive: boolean;
  starting: boolean;
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
  pollSystemCaptions: () => Promise<void>;
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
  autoStartCaptions: true,
  keepHistory: false,
  captionEngine: 'bridge-asr',
  includeMicrophone: false,
  fallbackToMicrophone: false,
};

const APP_VERSION = '1.0.0';
const STREAM_KEY = 'duosub.desktop.v1';

/** Before the native shell answers, the UA is the only host hint available. */
const INITIAL_HOST = detectHostOS(null, typeof navigator === 'undefined' ? '' : navigator.userAgent);
const BASE_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  family: defaultFamilyFor(INITIAL_HOST),
  // Default: the bridge listens to the meeting/system audio. Microphone is opt-in.
  captionEngine: 'bridge-asr',
};

let client = new BridgeClient(DEFAULT_SETTINGS.bridgeUrl, DEFAULT_SETTINGS.bridgeToken);
let unsubscribeStream: (() => void) | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let frontmostTimer: ReturnType<typeof setInterval> | null = null;
let systemCaptionTimer: ReturnType<typeof setInterval> | null = null;
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

      /** The only automatic way to start/restart a bridge session. */
      const ensureSession = (trigger: 'stream-online' | 'session-stopped') => {
        const state = get();
        const wantsStart = shouldStartForTrigger(trigger, {
          onboardingDone: state.onboardingDone,
          autoStart: state.settings.autoStartCaptions,
          engine: state.settings.captionEngine,
          localActive: state.sessionActive,
          starting: state.starting,
        });
        if (!wantsStart) return;
        void client.health().then((health) => {
          // /health is the authority: a session may already be running (started by another client).
          if (health.session?.active === true) {
            set({ sessionActive: true, sessionId: health.session.session_id ?? '' });
            return;
          }
          void get().start();
        }).catch(() => undefined);
      };

      const restartStream = () => {
        unsubscribeStream?.();
        unsubscribeStream = null;
        const state = get();
        client = new BridgeClient(state.settings.bridgeUrl, state.settings.bridgeToken);
        unsubscribeStream = client.subscribe({
          onEvent: (event) => get().handleEvent(event),
          onState: (connection) => {
            set({ connection });
            if (connection === 'online') ensureSession('stream-online');
          },
          getSince: () => get().lastSeq,
          onReset: () => {
            // New bridge process: its seq starts at 0 and the old utterances no longer exist.
            pipeline?.cancelAll();
            set({ lastSeq: 0, rows: [], sessionId: '', sessionActive: false, warnings: [] });
          },
        });
      };

      const startSystemPolling = () => {
        if (systemCaptionTimer !== null) return;
        // Ask macOS for the Accessibility grant immediately: the system dialog is the only way
        // the user can approve it, and finding the hidden pane manually wasted a lot of time.
        void invokeSafe('open_accessibility_settings');
        systemCaptionTimer = setInterval(() => void get().pollSystemCaptions(), 500);
        void get().pollSystemCaptions();
      };
      const stopSystemPolling = () => {
        if (systemCaptionTimer !== null) clearInterval(systemCaptionTimer);
        systemCaptionTimer = null;
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
        systemLines: [],
        sessionId: '',
        sessionActive: false,
        starting: false,
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
          // Idempotent: HMR can leave module-level timers/pipeline alive while a fresh React tree
          // calls init() again. Always re-arm the session decision even if the rest is set up.
          if (pipeline !== null) {
            ensureSession('stream-online');
            return;
          }
          // Bound persisted data even if the user enabled history at some point in the past.
          set({
            sessions: get().settings.keepHistory
              ? get().sessions.slice(0, 3).map((session) => ({
                  ...session,
                  rows: session.rows.slice(-40),
                }))
              : [],
          });
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
          if (get().settings.captionEngine === 'system-live') startSystemPolling();
          // Ask once after the store is hydrated. SSE onopen is the other trigger; having both
          // covers the case where EventSource was already open before init() ran.
          ensureSession('stream-online');
          void get().refreshHealth();
          // SSE onopen already flips the pill to online; health only needs a slow safety poll.
          healthTimer = setInterval(() => void get().refreshHealth(), 10_000);
          frontmostTimer = setInterval(async () => {
            const name = await invokeSafe<string>('get_frontmost_app');
            if (typeof name === 'string' && name !== '' && name !== get().frontmostApp) {
              get().setFrontmostApp(name);
            }
          }, 5000);

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
          const sourcesChanged =
            (patch.includeMicrophone !== undefined && patch.includeMicrophone !== before.includeMicrophone) ||
            (patch.fallbackToMicrophone !== undefined && patch.fallbackToMicrophone !== before.fallbackToMicrophone);
          if (sourcesChanged && get().sessionActive) {
            // The bridge only reads `sources` at session start; restart so flipping the toggle
            // takes effect immediately instead of silently keeping the old stream.
            void get().stop().then(() => get().start());
          }
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
          if (patch.captionEngine !== undefined) {
            stopSystemPolling();
            if (patch.captionEngine === 'system-live') {
              set({ rows: [], systemLines: [], sessionId: '', sessionActive: false });
              startSystemPolling();
            } else {
              set({ systemLines: [] });
            }
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
          set({ lastError: '', warnings: [], starting: true });
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

            // Default = system audio only. The microphone is never included unless the user opts
            // in. An empty sources list means "everything available" on the bridge, so pin it.
            const requestedSources: string[] = [];
            if (!state.settings.includeMicrophone) requestedSources.push('system');
            let result: StartResult;
            try {
              result = await client.startSession({
                language: state.settings.language,
                sources: requestedSources,
                mode: 'asr',
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              // Microphone fallback is strictly opt-in: this tool's job is to caption system audio.
              if (
                state.settings.fallbackToMicrophone &&
                /system audio capture failed|no display/i.test(message)
              ) {
                result = await client.startSession({
                  language: state.settings.language,
                  sources: ['microphone'],
                  mode: 'asr',
                });
                set({ warnings: [...get().warnings, 'Chỉ dùng micro — âm thanh hệ thống chưa sẵn.'] });
              } else {
                throw error;
              }
            }
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
            // Retries are handled by the health poll's self-heal path (every 15s, no upper limit).
          } finally {
            set({ starting: false });
          }
        },

        stop: async () => {
          const state = get();
          // History is opt-in and intentionally tiny: long transcripts in localStorage were the
          // main source of UI lag on this machine.
          if (state.settings.keepHistory && state.sessionId !== '' && state.rows.length > 0) {
            const record: SessionRecord = {
              id: state.sessionId,
              startedAt: Date.now() - (state.rows.at(-1)?.t1Ms ?? 0),
              endedAt: Date.now(),
              language: state.settings.language,
              family: state.settings.family,
              profileId: state.activeProfileId,
              rows: state.rows.slice(-40),
            };
            set({ sessions: [record, ...state.sessions].slice(0, 3) });
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

        pollSystemCaptions: async () => {
          if (get().settings.captionEngine !== 'system-live') return;
          const lines = await invokeSafe<string[]>('read_system_captions');
          if (lines === null) return;
          const fresh = newLines(get().systemLines, lines);
          if (fresh.length === 0) return;
          let rows = get().rows;
          let seq = get().lastSeq;
          const now = Date.now();
          for (const line of fresh) {
            seq += 1;
            rows = appendSystemLine(rows, line, seq, now);
            pipeline?.schedule(rows[rows.length - 1]);
          }
          set({ systemLines: lines, rows, lastSeq: seq, lastError: '', connection: 'online' });
          emitCaption();
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
              // NEVER trust replayed session_started frames from the bridge's ring: they describe
              // OLD sessions and would make a stopped session look alive, disabling auto-recovery.
              // Only our own successful start() call sets sessionActive=true.
              break;
            case 'session_stopped':
              set({ sessionActive: false });
              // The bridge stopped the session on its own (orphan reaper / remote stop). This is
              // one of only two automatic restart triggers.
              ensureSession('session-stopped');
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
            // Old persisted experiments must not silently change the caption engine or startup.
            captionEngine: 'bridge-asr',
            autoStartCaptions: true,
            includeMicrophone: saved.settings?.includeMicrophone ?? false,
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
  if (systemCaptionTimer !== null) clearInterval(systemCaptionTimer);
  systemCaptionTimer = null;
  pipeline?.cancelAll();
  void client.releaseOwner();
  healthTimer = null;
  frontmostTimer = null;
}
