import type { CaptionRow } from '../caption/captionEngine';

const pad = (value: number, length = 2): string => String(Math.floor(value)).padStart(length, '0');

export function formatTimestamp(ms: number, separator: ',' | '.' = ','): string {
  const safe = Math.max(0, Math.floor(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`;
}

const cueTimes = (row: CaptionRow): [number, number] => {
  const start = Math.max(0, row.t0Ms);
  const end = Math.max(start + 1, row.t1Ms);
  return [start, end];
};

export function toSrt(rows: readonly CaptionRow[], includeSource = true): string {
  return rows
    .map((row, index) => {
      const [start, end] = cueTimes(row);
      const lines = includeSource && row.translatedText !== ''
        ? [row.sourceText, `→ ${row.translatedText}`]
        : [row.translatedText || row.sourceText];
      return `${index + 1}\n${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${lines.join('\n')}\n`;
    })
    .join('\n');
}

export function toVtt(rows: readonly CaptionRow[], includeSource = true): string {
  const cues = rows
    .map((row) => {
      const [start, end] = cueTimes(row);
      const lines = includeSource && row.translatedText !== ''
        ? [row.sourceText, `→ ${row.translatedText}`]
        : [row.translatedText || row.sourceText];
      return `${formatTimestamp(start, '.')} --> ${formatTimestamp(end, '.')}\n${lines.join('\n')}`;
    })
    .join('\n\n');
  return `WEBVTT\n\n${cues}\n`;
}

export function toTxt(rows: readonly CaptionRow[], includeSource = true): string {
  return rows
    .map((row) => {
      const stamp = `[${formatTimestamp(row.t0Ms, '.')}]`;
      if (includeSource && row.translatedText !== '') return `${stamp} ${row.sourceText}\n${stamp} → ${row.translatedText}`;
      return `${stamp} ${row.translatedText || row.sourceText}`;
    })
    .join('\n');
}

export type ExportFormat = 'srt' | 'vtt' | 'txt';

export function exportCaptions(rows: readonly CaptionRow[], format: ExportFormat, includeSource = true): string {
  switch (format) {
    case 'srt':
      return toSrt(rows, includeSource);
    case 'vtt':
      return toVtt(rows, includeSource);
    case 'txt':
      return toTxt(rows, includeSource);
  }
}
