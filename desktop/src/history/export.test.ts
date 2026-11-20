import { describe, expect, it } from 'vitest';
import type { CaptionRow } from '../caption/captionEngine';
import { exportCaptions, formatTimestamp } from './export';

const row = (overrides: Partial<CaptionRow> = {}): CaptionRow => ({
  id: 's1:1',
  sessionId: 's1',
  segmentId: 1,
  sourceText: 'hello world',
  translatedText: 'xin chào thế giới',
  translationState: 'done',
  final: true,
  source: 'system',
  language: 'en',
  t0Ms: 1_500,
  t1Ms: 3_500,
  seq: 1,
  vocabularyApplied: false,
  ...overrides,
});

describe('caption export', () => {
  it('formats SRT and VTT timestamps with the right separators', () => {
    expect(formatTimestamp(1_523)).toBe('00:00:01,523');
    expect(formatTimestamp(3_661_000, '.')).toBe('01:01:01.000');
  });

  it('writes a valid SRT cue with the source and translation', () => {
    const srt = exportCaptions([row()], 'srt');
    expect(srt).toContain('1\n00:00:01,500 --> 00:00:03,500\nhello world\n→ xin chào thế giới');
  });

  it('writes a WEBVTT header and a TXT transcript', () => {
    expect(exportCaptions([row()], 'vtt')).toContain('WEBVTT\n\n00:00:01.500 --> 00:00:03.500');
    expect(exportCaptions([row()], 'txt', false)).toBe('[00:00:01.500] xin chào thế giới');
  });

  it('never emits a zero-length cue', () => {
    const srt = exportCaptions([row({ t0Ms: 0, t1Ms: 0 })], 'srt');
    expect(srt).toContain('00:00:00,000 --> 00:00:00,001');
  });
});
