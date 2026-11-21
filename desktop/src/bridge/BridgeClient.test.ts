import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeClient, BridgeCallError } from './BridgeClient';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, handler: (event: MessageEvent<string>) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
  }

  emit(name: string, data: string): void {
    for (const handler of this.listeners.get(name) ?? []) handler({ data } as MessageEvent<string>);
  }

  close(): void {
    this.closed = true;
  }
}

const HEALTH = {
  ok: true,
  version: '0.5',
  family: 'apple-speech',
  model_id: 'apple-speech',
  model_ready: true,
  sources: ['system'],
  supported_languages: ['auto', 'en', 'ja'],
  system_audio: 'granted',
  apple_speech_available: true,
  session: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BridgeClient', () => {
  it('parses health and surfaces a precise error for a 409 session conflict', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(HEALTH))
      .mockResolvedValueOnce(jsonResponse({ error: 'a session is already running' }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const client = new BridgeClient();
    expect((await client.health()).family).toBe('apple-speech');
    await expect(client.startSession({ language: 'auto' })).rejects.toMatchObject({
      name: 'BridgeCallError',
      status: 409,
    } satisfies Partial<BridgeCallError>);
  });

  it('delivers parsed segment events and resumes from the last seq after reconnect', async () => {
    vi.useFakeTimers();
    const client = new BridgeClient('http://127.0.0.1:4499', 'tok');
    let since = 0;
    const events: string[] = [];
    const states: string[] = [];
    const stop = client.subscribe({
      onEvent: (event) => events.push(event.kind),
      onState: (state) => states.push(state),
      getSince: () => since,
    });

    const first = FakeEventSource.instances[0];
    expect(first.url).toContain('since=0');
    expect(first.url).toContain('token=tok');
    first.onopen?.();
    first.emit('segment', '{"seq":9,"ts":1,"kind":"segment","session_id":"s","segment_id":1,"text":"hi","final":false,"source":"system","language":"en","t0_ms":0,"t1_ms":1}');
    expect(events).toEqual(['segment']);

    // Simulate a dropped connection: the client reconnects with the highest seq it saw.
    first.onerror?.();
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeEventSource.instances[1];
    expect(second.url).toContain('since=9');
    expect(first.closed).toBe(true);
    expect(states).toContain('reconnecting');
    stop();
    expect(second.closed).toBe(true);
  });

  it('detects a restarted bridge whose seq counter reset to zero', () => {
    vi.useFakeTimers();
    const client = new BridgeClient();
    let since = 0;
    const seen: number[] = [];
    let resets = 0;
    client.subscribe({
      onEvent: (event) => seen.push(event.seq),
      onState: () => undefined,
      getSince: () => since,
      onReset: () => { resets += 1; since = 0; },
    });

    const source = FakeEventSource.instances[0];
    const frame = (seq: number) =>
      `{"seq":${seq},"ts":1,"kind":"error","message":"m"}`;
    source.emit('error', frame(120));
    // Simulate a fresh bridge process: seq starts again at 0.
    source.emit('error', frame(0));
    source.emit('error', frame(1));

    expect(resets).toBe(1);
    expect(seen).toEqual([120, 0, 1]);
  });

  it('treats an absent bridge as an actionable error rather than a raw fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(new BridgeClient().health()).rejects.toThrow('Không kết nối được bridge');
  });
});
