/**
 * OS-neutral capability layer. The bridge reports its real capabilities over /health; this module
 * only provides *defaults before the bridge is reachable* and the UI copy for each host. No file in
 * the views/store should hard-code macOS behaviour again.
 */
export type HostOS = 'macos' | 'windows' | 'linux' | 'unknown';

export interface HostCapabilities {
  /** Can the bridge capture meeting/system audio on this host? */
  systemAudioCapture: boolean;
  /** macOS 26+ SpeechAnalyzer. */
  appleSpeech: boolean;
  /** Always-on-top frameless caption window. */
  overlay: boolean;
  autostart: boolean;
  /** Reading the frontmost application name for per-app profiles. */
  frontmostApp: boolean;
  /** Native system-audio permission pane that the bridge can open. */
  permissionPane: boolean;
}

const CAPABILITIES: Record<HostOS, HostCapabilities> = {
  macos: {
    systemAudioCapture: true,
    appleSpeech: true,
    overlay: true,
    autostart: true,
    frontmostApp: true,
    permissionPane: true,
  },
  windows: {
    systemAudioCapture: true, // WASAPI loopback in the bridge
    appleSpeech: false,
    overlay: true,
    autostart: true,
    frontmostApp: true,
    permissionPane: false,
  },
  linux: {
    systemAudioCapture: false, // PulseAudio/PipeWire backend not ported yet
    appleSpeech: false,
    overlay: true,
    autostart: true,
    frontmostApp: true, // xdotool/wmctrl
    permissionPane: false,
  },
  unknown: {
    systemAudioCapture: false,
    appleSpeech: false,
    overlay: false,
    autostart: false,
    frontmostApp: false,
    permissionPane: false,
  },
};

export function capabilitiesFor(os: HostOS): HostCapabilities {
  return CAPABILITIES[os];
}

/** Prefer the bridge's own report; fall back to the webview UA only while offline. */
export function detectHostOS(bridgePlatform?: string | null, userAgent?: string): HostOS {
  if (bridgePlatform === 'macos' || bridgePlatform === 'windows' || bridgePlatform === 'linux') {
    return bridgePlatform;
  }
  const ua = (userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)).toLowerCase();
  if (ua.includes('mac os') || ua.includes('macos')) return 'macos';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('linux') || ua.includes('x11')) return 'linux';
  return 'unknown';
}

/** Apple Speech is macOS-only; every other host starts on multilingual Whisper medium. */
export function defaultFamilyFor(os: HostOS): string {
  return os === 'macos' ? 'apple-speech' : 'whisper-medium';
}

export const OS_LABEL: Record<HostOS, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  unknown: 'Unknown',
};
