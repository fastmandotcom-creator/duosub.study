import type { TranslationProvider } from '../translation/types';

export interface Profile {
  id: string;
  name: string;
  /** Substrings of the frontmost app name / bundle id, lower-cased. */
  matchApps: string[];
  language: string;
  family: string;
  translationProvider: TranslationProvider;
  targetLanguage: string;
  overlayEnabled: boolean;
}

export const DEFAULT_PROFILES: Profile[] = [
  {
    id: 'default',
    name: 'Mặc định',
    matchApps: [],
    language: 'auto',
    family: 'apple-speech',
    translationProvider: 'gemini',
    targetLanguage: 'vi',
    overlayEnabled: true,
  },
  {
    id: 'meeting-en',
    name: 'Họp tiếng Anh',
    matchApps: ['zoom', 'google meet', 'microsoft teams', 'chrome', 'safari', 'teams'],
    language: 'en',
    family: 'apple-speech',
    translationProvider: 'gemini',
    targetLanguage: 'vi',
    overlayEnabled: true,
  },
  {
    id: 'japanese',
    name: 'Nhật → Việt',
    matchApps: ['zoom', 'meeting'],
    language: 'ja',
    // Apple Speech cannot be pinned to Japanese on a non-Japanese Mac; the app auto-routes to
    // Whisper when the capability check fails.
    family: 'apple-speech',
    translationProvider: 'gemini',
    targetLanguage: 'vi',
    overlayEnabled: true,
  },
];

/** First profile with a matching app substring wins; the catch-all `default` is the fallback. */
export function matchProfile(profiles: readonly Profile[], frontmostApp: string): Profile | null {
  const app = frontmostApp.trim().toLowerCase();
  if (app === '') return null;
  for (const profile of profiles) {
    if (profile.matchApps.some((candidate) => app.includes(candidate.toLowerCase()))) return profile;
  }
  return profiles.find((profile) => profile.matchApps.length === 0) ?? null;
}
