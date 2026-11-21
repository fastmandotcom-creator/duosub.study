import {
  parseBridgeEvent,
  parseErrorEnvelope,
  parseHealth,
  parseModelSelectResult,
  parsePollResponse,
  parseStartResult,
  type BridgeEvent,
  type HealthResponse,
  type PollResponse,
  type StartResult,
} from '@duosub/caption-contract';

export type BridgeConnectionState = 'offline' | 'checking' | 'online' | 'reconnecting' | 'error';

export interface StartSessionRequest {
  language: string;
  sources?: string[];
  /** `asr` = on-device transcription, `capture` = raw PCM only (cloud STT path). */
  mode?: 'asr' | 'capture';
}

export interface SubscribeHandlers {
  onEvent: (event: BridgeEvent) => void;
  onState?: (state: BridgeConnectionState) => void;
  /** Last seq already persisted by the caller, used after a reconnect. */
  getSince?: () => number;
  /** Bridge process restarted, so its monotonic seq counter started over at 0. */
  onReset?: () => void;
}

const DEFAULT_BASE = 'http://127.0.0.1:4499';

/**
 * Thin, testable HTTP/SSE client for the DuoSub bridge.
 *
 * Never throws for an expected bridge condition (offline, 409, missing model): callers get a
 * typed `BridgeCallError` so the UI can show the *exact* next action instead of a stack trace.
 */
export class BridgeCallError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'BridgeCallError';
  }
}

export class BridgeClient {
  /** Stable id for this app process in the bridge's advisory capture lease. */
  readonly ownerId = `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    readonly baseUrl: string = DEFAULT_BASE,
    readonly token: string = '',
  ) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const url = new URL(path, this.baseUrl);
    const search = new URLSearchParams(params);
    if (this.token !== '') search.set('token', this.token);
    const query = search.toString();
    return query === '' ? url.toString() : `${url.toString()}?${query}`;
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = 4000): Promise<{ status: number; body: unknown }> {
    // In the native app, route loopback HTTP through Rust: WKWebView intermittently fails fetch to
    // 127.0.0.1 ("TypeError: Load failed") even while its EventSource keeps receiving captions.
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<unknown>('bridge_request', {
        method: init.method ?? 'GET',
        path,
        body: typeof init.body === 'string' ? init.body : null,
        token: this.token === '' ? null : this.token,
        timeoutMs,
      });
      if (raw === null || raw === undefined) return { status: 200, body: null };
      if (typeof raw === 'string' && raw.startsWith('HTTP ')) {
        const [code, ...rest] = raw.split(': ');
        throw new BridgeCallError(rest.join(': '), Number(code.replace('HTTP ', '')));
      }
      return { status: 200, body: raw };
    }
    let response: Response | null = null;
    let lastError: unknown = null;
    // WebKit can fail a loopback fetch transiently ("TypeError: Load failed") while the bridge is
    // healthy. Retry a few times before declaring it offline.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await fetch(this.url(path), {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(this.token !== '' ? { Authorization: `Bearer ${this.token}` } : {}),
            ...init.headers,
          },
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    if (response === null) {
      throw new BridgeCallError(
        `Không kết nối được bridge tại ${this.baseUrl}. Cài DuoSub hoặc bật ứng dụng trước. (${String(lastError)})`,
      );
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const detail = parseErrorEnvelope(body)?.error ?? text.slice(0, 200) ?? response.statusText;
      throw new BridgeCallError(detail, response.status);
    }
    return { status: response.status, body };
  }

  async health(timeoutMs = 2500): Promise<HealthResponse> {
    const { body } = await this.request('/health', {}, timeoutMs);
    const health = parseHealth(body);
    if (health === null) throw new BridgeCallError('Bridge trả về /health không hợp lệ.');
    return health;
  }

  async startSession(req: StartSessionRequest): Promise<StartResult> {
    const { body } = await this.request('/sessions/start', {
      method: 'POST',
      body: JSON.stringify({
        language: req.language,
        sources: req.sources ?? [],
        mode: req.mode ?? 'asr',
        owner: this.ownerId,
      }),
    }, 60000); // a model build/download can take a while
    const result = parseStartResult(body);
    if (result === null) throw new BridgeCallError('Bridge không xác nhận phiên mới.');
    return result;
  }

  async stopSession(): Promise<boolean> {
    try {
      await this.request('/sessions/stop', { method: 'POST' }, 30000);
      return true;
    } catch (error) {
      if (error instanceof BridgeCallError && error.status === 409) return false;
      throw error;
    }
  }

  async selectModel(family: string): Promise<string[]> {
    const { body } = await this.request('/models/select', {
      method: 'POST',
      body: JSON.stringify({ family }),
    }, 180000); // first-time model download
    const result = parseModelSelectResult(body);
    if (result === null) throw new BridgeCallError('Bridge không xác nhận đổi model.');
    return result.supported_languages;
  }

  /** False means another fresh controller owns the bridge (HTTP 409). */
  async claimOwner(): Promise<boolean> {
    try {
      await this.request('/sessions/claim', {
        method: 'POST',
        body: JSON.stringify({ id: this.ownerId, kind: 'desktop' }),
      });
      return true;
    } catch (error) {
      return error instanceof BridgeCallError && error.status === 409 ? false : true;
    }
  }

  async heartbeatOwner(): Promise<boolean> {
    try {
      await this.request('/sessions/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ id: this.ownerId }),
      });
      return true;
    } catch (error) {
      return error instanceof BridgeCallError && error.status === 409 ? false : true;
    }
  }

  async releaseOwner(): Promise<void> {
    try {
      await this.request('/sessions/release', {
        method: 'POST',
        body: JSON.stringify({ id: this.ownerId }),
      });
    } catch {
      // Release is best-effort; the bridge expires the lease on its own TTL.
    }
  }

  async openPermissionSettings(): Promise<void> {
    await this.request('/permissions/open-settings', { method: 'POST' });
  }

  async openLiveCaptionSettings(): Promise<void> {
    await this.request('/permissions/open-live-captions', { method: 'POST' });
  }

  async poll(since: number): Promise<PollResponse | null> {
    const { body } = await this.request('/events', { headers: { Accept: 'application/json' } });
    const url = new URL(this.url('/events', { since: String(since) }));
    void url;
    return parsePollResponse(body);
  }

  /**
   * Subscribe to the SSE stream with bounded exponential reconnect.
   * Resumes from `getSince()` so a blip never duplicates or loses utterances.
   */
  subscribe(handlers: SubscribeHandlers): () => void {
    let stopped = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let lastSeq = handlers.getSince?.() ?? 0;

    const close = () => {
      source?.close();
      source = null;
    };

    const connect = () => {
      if (stopped) return;
      handlers.onState?.(failures === 0 ? 'checking' : 'reconnecting');
      try {
        source = new EventSource(this.url('/events', { since: String(lastSeq) }));
      } catch (error) {
        handlers.onState?.('error');
        console.warn('[duosub] EventSource unavailable', error);
        return;
      }
      source.onopen = () => {
        failures = 0;
        handlers.onState?.('online');
      };
      source.onerror = () => {
        if (stopped) return;
        close();
        handlers.onState?.('reconnecting');
        failures += 1;
        const delay = Math.min(1000 * 2 ** (failures - 1), 15000);
        timer = setTimeout(connect, delay);
      };
      const deliver = (event: MessageEvent<string>) => {
        const parsed = parseBridgeEvent(event.data);
        if (parsed === null) return;
        // A restarted bridge resets its seq ring to 0. Without this, a client that saw seq=500
        // drops every future event from the fresh process and shows an empty caption list forever.
        if (parsed.seq < lastSeq && parsed.seq <= 16) {
          lastSeq = 0;
          handlers.onReset?.();
        }
        lastSeq = Math.max(lastSeq, parsed.seq);
        handlers.onEvent(parsed);
      };
      for (const name of ['segment', 'pcm_frame', 'session', 'error']) {
        source.addEventListener(name, deliver as EventListener);
      }
    };

    connect();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      close();
    };
  }
}
