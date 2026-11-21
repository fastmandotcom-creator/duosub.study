import { describe, expect, it } from 'vitest';
import { newLines } from './systemCaptions';

describe('system caption diff', () => {
  it('returns everything on the first snapshot', () => {
    expect(newLines([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('emits only appended lines', () => {
    expect(newLines(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'd']);
  });

  it('re-anchors when the system window trims old lines', () => {
    expect(newLines(['a', 'b', 'c'], ['c', 'd'])).toEqual(['d']);
  });

  it('falls back to the newest line when nothing matches', () => {
    expect(newLines(['old'], ['new1', 'new2'])).toEqual(['new2']);
  });

  it('emits nothing for an unchanged snapshot', () => {
    expect(newLines(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
});
