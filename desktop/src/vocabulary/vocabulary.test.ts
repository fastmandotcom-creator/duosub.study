import { describe, expect, it } from 'vitest';
import { applyVocabulary } from './vocabulary';

describe('custom vocabulary', () => {
  it('replaces case-insensitively and preserves the match casing', () => {
    const entries = [{ id: '1', from: 'fumihiko', to: 'phu hao', enabled: true }];
    expect(applyVocabulary('Fumihiko spoke', entries)).toBe('Phu hao spoke');
    expect(applyVocabulary('FUMIHIKO spoke', entries)).toBe('PHU HAO spoke');
  });

  it('honours longest-rule-first and whole-word boundaries', () => {
    const entries = [
      { id: '1', from: 'AI', to: 'trí tuệ', enabled: true },
      { id: '2', from: 'OpenAI', to: 'OpenAI Corp', enabled: true },
    ];
    expect(applyVocabulary('OpenAI and AI', entries)).toBe('OpenAI Corp and TRÍ TUỆ');
    expect(applyVocabulary('AIM and AIR', entries)).toBe('AIM and AIR');
  });

  it('ignores disabled and empty rules', () => {
    expect(
      applyVocabulary('hello', [
        { id: '1', from: 'hello', to: 'bye', enabled: false },
        { id: '2', from: '  ', to: 'x', enabled: true },
      ]),
    ).toBe('hello');
  });
});
