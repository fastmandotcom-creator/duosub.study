/**
 * The DuoSub wire contract — the single source of truth shared by the bridge, the desktop app
 * and (via npm) the LiveCode extension.
 *
 * This module deliberately has ZERO runtime dependencies: the bridge publishes JSON, and both
 * TypeScript clients parse it defensively. Every parser returns `null` on an unknown shape so a
 * future bridge field can never crash an old client.
 *
 * Golden bytes are pinned by the Rust bridge's `contract.rs` tests; the TypeScript side pins the
 * same shapes in `index.test.ts`.
 */

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type SystemAudioState = 'granted' | 'denied' | 'not-required';

export interface SessionStatus {
  active: boolean;
  session_id: string | null;
  language: string | null;
  segment_count: number;
  /** Stable codes, e.g. `microphone-unavailable`. */
  warnings: string[];
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  family: string;
  model_id: string;
  model_ready: boolean;
  sources: string[];
  /** Languages the ACTIVE model can transcribe, including `auto`. */
  supported_languages: string[];
  system_audio: SystemAudioState | string;
  /** macOS 26+ SpeechAnalyzer availability. Older bridges omit it → false. */
  apple_speech_available: boolean;
  session: SessionStatus | null;
}

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asBool = (v: unknown): boolean => v === true;
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : [];

export function parseSessionStatus(v: unknown): SessionStatus | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const active = asBool(o.active);
  return {
    active,
    session_id: asString(o.session_id),
    language: asString(o.language),
    segment_count: asNumber(o.segment_count) ?? 0,
    warnings: asStringArray(o.warnings),
  };
}

/** Defensive health parser: missing new fields get honest defaults, garbage gets `null`. */
export function parseHealth(v: unknown): HealthResponse | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const family = asString(o.family);
  const modelId = asString(o.model_id);
  if (family === null || modelId === null) return null;
  return {
    ok: asBool(o.ok),
    version: asString(o.version) ?? 'unknown',
    family,
    model_id: modelId,
    model_ready: asBool(o.model_ready),
    sources: asStringArray(o.sources),
    supported_languages: asStringArray(o.supported_languages),
    system_audio: asString(o.system_audio) ?? 'denied',
    apple_speech_available: asBool(o.apple_speech_available),
    session: parseSessionStatus(o.session),
  };
}

// ---------------------------------------------------------------------------
// Session / model / permission results
// ---------------------------------------------------------------------------

export interface StartResult {
  started: boolean;
  sessionId: string;
  warnings: string[];
}

export function parseStartResult(v: unknown): StartResult | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const sessionId = asString(o.sessionId) ?? asString(o.session_id);
  if (!asBool(o.started) || sessionId === null) return null;
  return { started: true, sessionId, warnings: asStringArray(o.warnings) };
}

export interface ModelSelectResult {
  selected: boolean;
  family: string;
  model_id: string;
  supported_languages: string[];
}

export function parseModelSelectResult(v: unknown): ModelSelectResult | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!asBool(o.selected)) return null;
  const family = asString(o.family);
  const modelId = asString(o.model_id);
  if (family === null || modelId === null) return null;
  return {
    selected: true,
    family,
    model_id: modelId,
    supported_languages: asStringArray(o.supported_languages),
  };
}

export interface ErrorEnvelope {
  error: string;
}

export function parseErrorEnvelope(v: unknown): ErrorEnvelope | null {
  if (typeof v !== 'object' || v === null) return null;
  const error = asString((v as Record<string, unknown>).error);
  return error === null ? null : { error };
}

// ---------------------------------------------------------------------------
// Events (SSE `data:` payload AND poll fallback share these exact bytes)
// ---------------------------------------------------------------------------

export interface SegmentPayload {
  session_id: string;
  /** Stable per-utterance id: partial and final share it, so consumers update one row in place. */
  segment_id: number;
  text: string;
  /** Committed (`true`) or still revising (`false`). Wire key stays `final`. */
  final: boolean;
  speaker?: number;
  source: 'microphone' | 'system' | 'file' | string;
  confidence?: number;
  language: string;
  t0_ms: number;
  t1_ms: number;
}

export interface PcmFramePayload {
  session_id: string;
  /** PCM16 LE mono, base64. */
  audio_base64: string;
  sample_rate: number;
  byte_count: number;
}

export interface SessionStartedPayload {
  session_id: string;
  language: string;
  sources: string[];
}

export interface SessionStoppedPayload {
  session_id: string;
  segment_count: number;
}

interface EventMeta {
  seq: number;
  ts: number;
}

export type BridgeEvent = EventMeta &
  (
    | ({ kind: 'segment' } & SegmentPayload)
    | ({ kind: 'pcm_frame' } & PcmFramePayload)
    | ({ kind: 'session_started' } & SessionStartedPayload)
    | ({ kind: 'session_stopped' } & SessionStoppedPayload)
    | { kind: 'error'; message: string }
  );

function parseSegment(v: Record<string, unknown>): SegmentPayload | null {
  const sessionId = asString(v.session_id);
  const segmentId = asNumber(v.segment_id);
  const text = asString(v.text);
  const source = asString(v.source);
  const language = asString(v.language);
  if (
    sessionId === null ||
    segmentId === null ||
    text === null ||
    source === null ||
    language === null ||
    typeof v.final !== 'boolean'
  ) {
    return null;
  }
  const result: SegmentPayload = {
    session_id: sessionId,
    segment_id: segmentId,
    text,
    final: v.final,
    source,
    language,
    t0_ms: asNumber(v.t0_ms) ?? 0,
    t1_ms: asNumber(v.t1_ms) ?? 0,
  };
  const speaker = asNumber(v.speaker);
  if (speaker !== null) result.speaker = speaker;
  const confidence = asNumber(v.confidence);
  if (confidence !== null) result.confidence = confidence;
  return result;
}

/** Parse one SSE `data:` payload. Returns `null` for unknown/malformed frames (never throws). */
export function parseBridgeEvent(raw: string): BridgeEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  const seq = asNumber(o.seq);
  const ts = asNumber(o.ts);
  if (seq === null || ts === null) return null;
  const meta: EventMeta = { seq, ts };

  switch (o.kind) {
    case 'segment': {
      const segment = parseSegment(o);
      return segment === null ? null : { ...meta, kind: 'segment', ...segment };
    }
    case 'pcm_frame': {
      const sessionId = asString(o.session_id);
      const audio = asString(o.audio_base64);
      const sampleRate = asNumber(o.sample_rate);
      const byteCount = asNumber(o.byte_count);
      if (sessionId === null || audio === null || sampleRate === null || byteCount === null) return null;
      return {
        ...meta,
        kind: 'pcm_frame',
        session_id: sessionId,
        audio_base64: audio,
        sample_rate: sampleRate,
        byte_count: byteCount,
      };
    }
    case 'session_started': {
      const sessionId = asString(o.session_id);
      const language = asString(o.language);
      if (sessionId === null || language === null) return null;
      return {
        ...meta,
        kind: 'session_started',
        session_id: sessionId,
        language,
        sources: asStringArray(o.sources),
      };
    }
    case 'session_stopped': {
      const sessionId = asString(o.session_id);
      if (sessionId === null) return null;
      return {
        ...meta,
        kind: 'session_stopped',
        session_id: sessionId,
        segment_count: asNumber(o.segment_count) ?? 0,
      };
    }
    case 'error': {
      const message = asString(o.message);
      return message === null ? null : { ...meta, kind: 'error', message };
    }
    default:
      return null;
  }
}

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/** Parse one blank-line-delimited SSE frame. Handles multi-line `data:` concatenation. */
export function parseSseFrame(block: string): SseFrame | null {
  const lines = block.split(/\r?\n/);
  const data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  for (const line of lines) {
    if (line.startsWith(':')) continue; // heartbeat comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    else if (field === 'event') event = value;
  }
  if (data.length === 0) return null;
  return { id, event, data: data.join('\n') };
}

/** Parse a whole raw SSE chunk into complete frames, carrying an incomplete tail forward. */
export function parseSseChunk(
  buffer: string,
  onFrame: (frame: SseFrame) => void,
): string {
  let rest = buffer;
  let boundary = rest.indexOf('\n\n');
  while (boundary !== -1) {
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const frame = parseSseFrame(block);
    if (frame !== null) onFrame(frame);
    boundary = rest.indexOf('\n\n');
  }
  return rest;
}

// ---------------------------------------------------------------------------
// Poll fallback
// ---------------------------------------------------------------------------

export interface PollResponse {
  since: number;
  events: BridgeEvent[];
  oldest_in_ring?: number;
  latest_seq: number;
}

export function parsePollResponse(v: unknown): PollResponse | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const since = asNumber(o.since);
  const latest = asNumber(o.latest_seq);
  if (since === null || latest === null || !Array.isArray(o.events)) return null;
  const events: BridgeEvent[] = [];
  for (const raw of o.events) {
    const parsed = typeof raw === 'string' ? parseBridgeEvent(raw) : parseBridgeEvent(JSON.stringify(raw));
    if (parsed !== null) events.push(parsed);
  }
  const result: PollResponse = { since, events, latest_seq: latest };
  const oldest = asNumber(o.oldest_in_ring);
  if (oldest !== null) result.oldest_in_ring = oldest;
  return result;
}
