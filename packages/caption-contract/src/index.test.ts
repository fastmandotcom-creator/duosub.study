import { describe, expect, it } from 'vitest';
import {
  parseBridgeEvent,
  parseHealth,
  parseModelSelectResult,
  parsePollResponse,
  parseSseChunk,
  parseSseFrame,
  parseStartResult,
  type BridgeEvent,
} from './index';

/** Same bytes as the Rust bridge's `GOLDEN_FINAL_SEGMENT`. */
const GOLDEN_FINAL_SEGMENT =
  '{"seq":42,"ts":1734567890123,"kind":"segment","session_id":"s1","segment_id":7,"text":"hello world","final":true,"speaker":2,"source":"system","confidence":0.91,"language":"en","t0_ms":1000,"t1_ms":3500}';

describe('bridge wire contract', () => {
  it('parses the golden final segment byte-for-byte equivalent', () => {
    const event = parseBridgeEvent(GOLDEN_FINAL_SEGMENT);
    expect(event).toEqual({
      seq: 42,
      ts: 1734567890123,
      kind: 'segment',
      session_id: 's1',
      segment_id: 7,
      text: 'hello world',
      final: true,
      speaker: 2,
      source: 'system',
      confidence: 0.91,
      language: 'en',
      t0_ms: 1000,
      t1_ms: 3500,
    });
  });

  it('keeps partials distinct from finals and omits absent optional fields', () => {
    const event = parseBridgeEvent(
      '{"seq":3,"ts":1,"kind":"segment","session_id":"s9","segment_id":1,"text":"hi","final":false,"source":"microphone","language":"auto","t0_ms":10,"t1_ms":90}',
    );
    expect(event?.kind).toBe('segment');
    if (event?.kind !== 'segment') throw new Error('expected segment');
    expect(event.final).toBe(false);
    expect(event.speaker).toBeUndefined();
    expect(event.confidence).toBeUndefined();
  });

  it('parses every other event kind', () => {
    const pcm = parseBridgeEvent(
      '{"seq":7,"ts":1,"kind":"pcm_frame","session_id":"cap-1","audio_base64":"AQID","sample_rate":48000,"byte_count":3}',
    );
    expect(pcm?.kind).toBe('pcm_frame');

    const started = parseBridgeEvent(
      '{"seq":8,"ts":1,"kind":"session_started","session_id":"s1","language":"ja","sources":["system"]}',
    );
    expect(started?.kind).toBe('session_started');

    const stopped = parseBridgeEvent(
      '{"seq":9,"ts":1,"kind":"session_stopped","session_id":"s1","segment_count":4}',
    );
    expect(stopped?.kind).toBe('session_stopped');

    const error = parseBridgeEvent('{"seq":10,"ts":1,"kind":"error","message":"boom"}');
    expect(error?.kind).toBe('error');
  });

  it('never throws on garbage, and rejects unknown kinds', () => {
    expect(parseBridgeEvent('{')).toBeNull();
    expect(parseBridgeEvent('null')).toBeNull();
    expect(parseBridgeEvent('{"seq":1,"ts":2,"kind":"future_thing"}')).toBeNull();
    expect(parseBridgeEvent('{"ts":2,"kind":"segment"}')).toBeNull();
  });

  it('parses SSE frames including multi-line data and heartbeats', () => {
    const frame = parseSseFrame(`: keep-alive\nid: 42\nevent: segment\ndata: {"seq":42}\ndata: "tail"`);
    expect(frame?.id).toBe('42');
    expect(frame?.event).toBe('segment');
    expect(frame?.data).toBe('{"seq":42}\n"tail"');
  });

  it('carries an incomplete SSE tail to the next chunk', () => {
    const frames: string[] = [];
    const chunk1 =
      'id: 1\nevent: segment\ndata: {"seq":1,"ts":1,"kind":"error","message":"a"}\n\nid: 2\nevent: segment\ndata: {"seq';
    let rest = parseSseChunk(chunk1, (f) => frames.push(f.data));
    expect(frames).toHaveLength(1);
    rest = parseSseChunk(`${rest}:2,"ts":2,"kind":"error","message":"b"}\n\n`, (f) => frames.push(f.data));
    expect(frames).toHaveLength(2);
    expect(rest).toBe('');
  });
});

describe('health + result parsers', () => {
  it('defaults fields missing from an older bridge, keeps the session status', () => {
    const health = parseHealth({
      ok: true,
      version: '0.4.0',
      family: 'auto',
      model_id: 'sense-voice',
      model_ready: true,
      sources: ['system'],
      supported_languages: ['auto', 'en'],
      system_audio: 'granted',
      session: { active: true, session_id: 's1', segment_count: 3, warnings: ['microphone-unavailable'] },
    });
    expect(health).not.toBeNull();
    expect(health?.apple_speech_available).toBe(false);
    expect(health?.session?.warnings).toEqual(['microphone-unavailable']);
    expect(health?.platform).toBe('unknown');
    expect(health?.system_audio_supported).toBe(true); // legacy bridge default
  });

  it('reads the platform capability block from a current bridge', () => {
    const health = parseHealth({
      ok: true, family: 'whisper-medium', model_id: 'whisper-medium',
      platform: 'linux', arch: 'x86_64', capture_backend: 'unavailable',
      system_audio_supported: false, system_audio: 'not-required',
    });
    expect(health?.platform).toBe('linux');
    expect(health?.system_audio_supported).toBe(false);
    expect(health?.capture_backend).toBe('unavailable');
  });

  it('rejects health without the identity fields', () => {
    expect(parseHealth({ ok: true })).toBeNull();
  });

  it('parses session start / model select / poll responses', () => {
    expect(parseStartResult({ started: true, sessionId: 's1', warnings: [] })).toEqual({
      started: true,
      sessionId: 's1',
      warnings: [],
    });
    expect(parseStartResult({ started: false })).toBeNull();
    expect(
      parseModelSelectResult({
        selected: true,
        family: 'apple-speech',
        model_id: 'apple-speech',
        supported_languages: ['auto', 'en', 'ja'],
      })?.family,
    ).toBe('apple-speech');

    const poll = parsePollResponse({ since: 0, latest_seq: 5, events: [JSON.parse(GOLDEN_FINAL_SEGMENT)] });
    expect(poll?.events[0]?.kind).toBe('segment');
    expect(poll?.latest_seq).toBe(5);
  });

  it('narrows to the discriminated union used by the UI', () => {
    const event: BridgeEvent | null = parseBridgeEvent(GOLDEN_FINAL_SEGMENT);
    if (event?.kind === 'segment') {
      expect(event.segment_id).toBe(7); // compile-time proof of the discriminant
    }
  });
});
