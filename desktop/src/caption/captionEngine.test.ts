import { describe, expect, it } from 'vitest';
import type { SegmentPayload } from '@duosub/caption-contract';
import { applySegment, rowId, setTranslation, visibleRows, type CaptionRow } from './captionEngine';
import { applyVocabulary } from '../vocabulary/vocabulary';

const segment = (overrides: Partial<SegmentPayload> = {}): SegmentPayload => ({
  session_id: 's1',
  segment_id: 1,
  text: 'hello',
  final: false,
  source: 'system',
  language: 'en',
  t0_ms: 100,
  t1_ms: 500,
  ...overrides,
});

describe('caption engine', () => {
  it('upserts a partial into its final utterance instead of appending a second row', () => {
    let rows: readonly CaptionRow[] = [];
    rows = applySegment(rows, segment({ text: 'hel' }), 1);
    rows = applySegment(rows, segment({ text: 'hello world', final: true }), 2);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(rowId('s1', 1));
    expect(rows[0].sourceText).toBe('hello world');
    expect(rows[0].final).toBe(true);
    expect(rows[0].seq).toBe(2);
  });

  it('invalidates an existing translation when the source text changes', () => {
    let rows: readonly CaptionRow[] = [];
    rows = applySegment(rows, segment(), 1);
    rows = setTranslation(rows, rows[0].id, 'xin chào', 'done');
    rows = applySegment(rows, segment({ text: 'hello there' }), 2);
    expect(rows[0].translatedText).toBe('xin chào');
    expect(rows[0].translationState).toBe('pending');
  });

  it('keeps a translation when only the final flag flips', () => {
    let rows: readonly CaptionRow[] = applySegment([], segment(), 1);
    rows = setTranslation(rows, rows[0].id, 'xin chào', 'done');
    rows = applySegment(rows, segment({ final: true }), 2);
    expect(rows[0].translatedText).toBe('xin chào');
    expect(rows[0].translationState).toBe('done');
  });

  it('applies vocabulary and flags it on the row', () => {
    const rows = applySegment([], segment({ text: 'Fumihiko speaks' }), 1, (text) =>
      applyVocabulary(text, [{ id: '1', from: 'Fumihiko', to: 'Phu Hao', enabled: true }]),
    );
    expect(rows[0].sourceText).toBe('Phu Hao speaks');
    expect(rows[0].vocabularyApplied).toBe(true);
  });

  it('caps the ring and returns only the newest rows for display', () => {
    let rows: readonly CaptionRow[] = [];
    for (let i = 0; i < 505; i += 1) rows = applySegment(rows, segment({ segment_id: i }), i);
    expect(rows).toHaveLength(500);
    expect(visibleRows(rows, 2).map((row) => row.segmentId)).toEqual([503, 504]);
  });
});
