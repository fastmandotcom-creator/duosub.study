import type { HostOS } from '../platform/os';

/** Single place naming the bridge install path — mirrored from the LiveCode extension. */
export const DUOSUB_INSTALL_COMMAND =
  'curl -fsSL https://github.com/fastmandotcom-creator/duosub.study/releases/latest/download/install.sh | bash';

export const DUOSUB_DOWNLOAD_URL =
  'https://github.com/fastmandotcom-creator/duosub.study/releases/latest/download/DuoSub-Bridge-arm64.dmg';

export const DUOSUB_RELEASES_URL = 'https://github.com/fastmandotcom-creator/duosub.study/releases';

/** The install story differs per host; never show a macOS command to a Windows user. */
export function installHintFor(host: HostOS): { command: string | null; url: string; note: string } {
  if (host === 'macos') {
    return {
      command: DUOSUB_INSTALL_COMMAND,
      url: DUOSUB_RELEASES_URL,
      note: 'Cài một lần, app sẽ tự khởi động bridge.',
    };
  }
  return {
    command: null,
    url: DUOSUB_RELEASES_URL,
    note:
      host === 'windows'
        ? 'Tải bản Windows từ Releases và đặt duosub-bridge.exe vào PATH (hoặc %LOCALAPPDATA%\\duosub).'
        : 'Tải bản Linux từ Releases và đặt duosub-bridge vào ~/.local/bin. Capture hệ thống đang là port tiếp theo.',
  };
}
