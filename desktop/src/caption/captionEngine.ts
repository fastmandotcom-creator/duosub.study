import type { SegmentPayload } from '@duosub/caption-contract';

export type TranslationState = 'none' | 'pending' | 'streaming' | 'done' | 'error';

export interface CaptionRow {
  /** `${sessionId}:${segmentId}` — stable across partial → final. */
  id: string;
  sessionId: string;
  segmentId: number;
  sourceText: string;
  translatedText: string;
  translationState: TranslationState;
  final: boolean;
  source: string;
  language: string;
  speaker?: number;
  t0Ms: number;
  t1Ms: number;
  seq: number;
  /** Set when a vocabulary rule changed the displayed source text. */
  vocabularyApplied: boolean;
}

export const MAX_ROWS = 500;

export function rowId(sessionId: string, segmentId: number): string {
  return `${sessionId}:${segmentId}`;
}

/**
 * Upsert one ASR segment. Pure: the same input always yields the same rows, which makes the
 * partial/final rewrite behaviour trivial to pin with a test.
 */
export function applySegment(
  rows: readonly CaptionRow[],
  segment: SegmentPayload,
  seq: number,
  applyText: (text: string) => string = (text) => text,
): CaptionRow[] {
  const id = rowId(segment.session_id, segment.segment_id);
  const text = applyText(segment.text);
  const index = rows.findIndex((row) => row.id === id);
  const sourceChanged = index === -1 || rows[index].sourceText !== text;

  const next: CaptionRow = {
    id,
    sessionId: segment.session_id,
    segmentId: segment.segment_id,
    sourceText: text,
    translatedText: index === -1 ? '' : rows[index].translatedText,
    translationState: index === -1 || sourceChanged ? 'pending' : (rows[index].translationState ?? 'none'),
    final: segment.final,
    source: segment.source,
    language: segment.language,
    t0Ms: segment.t0_ms,
    t1Ms: segment.t1_ms,
    seq,
    vocabularyApplied: text !== segment.text,
  };
  if (segment.speaker !== undefined) next.speaker = segment.speaker;

  const updated = index === -1 ? [...rows, next] : rows.map((row, i) => (i === index ? next : row));
  return updated.length > MAX_ROWS ? updated.slice(updated.length - MAX_ROWS) : updated;
}

export function setTranslation(
  rows: readonly CaptionRow[],
  id: string,
  translatedText: string,
  state: TranslationState,
): CaptionRow[] {
  return rows.map((row) =>
    row.id === id ? { ...row, translatedText, translationState: state } : row,
  );
}

export function clearSessionRows(rows: readonly CaptionRow[], sessionId?: string): CaptionRow[] {
  return sessionId === undefined ? [] : rows.filter((row) => row.sessionId !== sessionId);
}

export function visibleRows(rows: readonly CaptionRow[], limit = 40): CaptionRow[] {
  return rows.slice(-limit);
}
