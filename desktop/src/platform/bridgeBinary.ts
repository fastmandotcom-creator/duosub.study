import type { HostOS } from './os';

export interface BinaryCandidates {
  /** Explicit operator override (DUOSUB_BRIDGE_BINARY). */
  envBinary?: string;
  /** Tauri app-local data dir. */
  appDataDir?: string;
  home?: string;
}

const join = (...parts: string[]): string => parts.filter((p) => p !== '').join('/').replace(/\/+/g, '/');

/**
 * Pure path resolution so Windows/Linux candidates are unit-testable on a Mac. The native shell
 * uses the equivalent table in `src-tauri/src/platform/`.
 */
export function bridgeBinaryCandidates(os: HostOS, opts: BinaryCandidates = {}): string[] {
  const paths: string[] = [];
  const env = opts.envBinary?.trim() ?? '';
  if (env !== '') paths.push(env);
  if (opts.appDataDir !== undefined) {
    paths.push(
      os === 'windows'
        ? join(opts.appDataDir, 'duosub-bridge.exe')
        : join(opts.appDataDir, 'duosub-bridge'),
    );
  }
  const home = opts.home ?? '~';
  switch (os) {
    case 'macos':
      paths.push('/opt/homebrew/bin/duosub-bridge', '/usr/local/bin/duosub-bridge');
      break;
    case 'windows':
      paths.push(join(home, 'AppData/Local/duosub/duosub-bridge.exe'), 'duosub-bridge.exe');
      break;
    case 'linux':
      paths.push(join(home, '.local/bin/duosub-bridge'), '/usr/local/bin/duosub-bridge');
      break;
    default:
      break;
  }
  return [...new Set(paths)];
}
