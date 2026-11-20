import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILES, matchProfile } from './profiles';

describe('profiles', () => {
  it('matches the frontmost app case-insensitively', () => {
    expect(matchProfile(DEFAULT_PROFILES, 'Google Meet - Chrome')?.id).toBe('meeting-en');
    expect(matchProfile(DEFAULT_PROFILES, 'zoom.us')?.id).toBe('meeting-en');
  });

  it('falls back to the catch-all profile for an unknown app', () => {
    expect(matchProfile(DEFAULT_PROFILES, 'Notes')?.id).toBe('default');
    expect(matchProfile(DEFAULT_PROFILES, '')).toBeNull();
  });
});
