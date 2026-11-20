import { describe, expect, it } from 'vitest';
import { bridgeBinaryCandidates } from './bridgeBinary';
import { capabilitiesFor, defaultFamilyFor, detectHostOS } from './os';

describe('host capabilities', () => {
  it('starts every non-macOS host on Whisper instead of Apple Speech', () => {
    expect(defaultFamilyFor('macos')).toBe('apple-speech');
    expect(defaultFamilyFor('windows')).toBe('whisper-medium');
    expect(defaultFamilyFor('linux')).toBe('whisper-medium');
  });

  it('reports system-audio support honestly per host', () => {
    expect(capabilitiesFor('macos').systemAudioCapture).toBe(true);
    expect(capabilitiesFor('windows').systemAudioCapture).toBe(true);
    expect(capabilitiesFor('linux').systemAudioCapture).toBe(false);
    expect(capabilitiesFor('linux').frontmostApp).toBe(true); // profiles still work on Linux
    expect(capabilitiesFor('unknown').permissionPane).toBe(false);
  });

  it('trusts the bridge platform report over the browser UA', () => {
    expect(detectHostOS('windows', 'Mozilla Mac OS X')).toBe('windows');
    expect(detectHostOS(null, 'Mozilla/5.0 (Windows NT 10.0)')).toBe('windows');
    expect(detectHostOS('', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(detectHostOS(null, '')).toBe('unknown');
  });
});

describe('bridge binary resolution', () => {
  it('uses .exe and LOCALAPPDATA on Windows', () => {
    const paths = bridgeBinaryCandidates('windows', { home: 'C:/Users/Ada', appDataDir: 'C:/Data' });
    expect(paths).toContain('C:/Data/duosub-bridge.exe');
    expect(paths).toContain('C:/Users/Ada/AppData/Local/duosub/duosub-bridge.exe');
    expect(paths.some((p) => p.includes('/opt/homebrew'))).toBe(false);
  });

  it('uses ~/.local/bin on Linux and never an Apple path', () => {
    const paths = bridgeBinaryCandidates('linux', { home: '/home/ada' });
    expect(paths).toContain('/home/ada/.local/bin/duosub-bridge');
    expect(paths).toContain('/usr/local/bin/duosub-bridge');
    expect(paths.some((p) => p.toLowerCase().includes('mac'))).toBe(false);
  });

  it('honours the explicit override first and de-duplicates', () => {
    const paths = bridgeBinaryCandidates('macos', {
      envBinary: '/custom/bridge',
      appDataDir: '/custom',
    });
    expect(paths[0]).toBe('/custom/bridge');
    expect(new Set(paths).size).toBe(paths.length);
  });
});
