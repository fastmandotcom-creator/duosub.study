import type { TranslationProvider } from './types';

/** Translation must be opt-in: never enable a cloud provider without a user-supplied key. */
export function resolveTranslationProvider(
  selected: TranslationProvider | undefined,
  apiKeys: Partial<Record<'gemini' | 'openai', string>> | undefined,
): TranslationProvider {
  if (selected === undefined || selected === 'none') return 'none';
  const key = apiKeys?.[selected]?.trim() ?? '';
  return key === '' ? 'none' : selected;
}
