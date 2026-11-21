/**
 * macOS Live Captions keeps a rolling list of utterances in its accessibility tree. Only the tail
 * that appeared since the previous snapshot should become new caption rows.
 */
export function newLines(previous: readonly string[], next: readonly string[]): string[] {
  if (next.length === 0) return [];
  if (previous.length === 0) return [...next];
  if (next.length > previous.length && previous.every((line, index) => next[index] === line)) {
    return next.slice(previous.length);
  }
  // The system window may trim older lines: re-anchor on the last previously seen line still
  // present, and emit everything after it.
  for (let i = previous.length - 1; i >= 0; i -= 1) {
    const anchor = next.lastIndexOf(previous[i]);
    if (anchor !== -1) return next.slice(anchor + 1);
  }
  return [next[next.length - 1]];
}
