import { describe, expect, it } from 'vitest';
import { resolveTranslationProvider } from './policy';

describe('translation policy', () => {
  it('defaults to no translation', () => {
    expect(resolveTranslationProvider(undefined, undefined)).toBe('none');
  });

  it('ignores a cloud provider without an API key', () => {
    expect(resolveTranslationProvider('gemini', { gemini: '' })).toBe('none');
    expect(resolveTranslationProvider('openai', {})).toBe('none');
  });

  it('honours a cloud provider only when a key exists', () => {
    expect(resolveTranslationProvider('gemini', { gemini: 'AIza...' })).toBe('gemini');
  });

  it('always respects an explicit none', () => {
    expect(resolveTranslationProvider('none', { gemini: 'AIza...' })).toBe('none');
  });
});
