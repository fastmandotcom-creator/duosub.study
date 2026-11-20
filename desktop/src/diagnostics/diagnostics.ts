import type { HealthResponse } from '@duosub/caption-contract';

export interface DiagnosticContext {
  health: HealthResponse | null;
  bridgeUrl: string;
  connection: string;
  frontmostApp: string;
  profileId: string;
  appVersion: string;
  rowsInMemory: number;
  lastError: string;
}

/** One-click support bundle. Deliberately plain text: easy to paste into an issue. */
export function buildDiagnosticReport(ctx: DiagnosticContext): string {
  const line = (key: string, value: unknown): string => `${key.padEnd(24)} ${String(value)}`;
  const health = ctx.health;
  return [
    'DuoSub Desktop — diagnostics',
    `generated               ${new Date().toISOString()}`,
    line('app version', ctx.appVersion),
    line('bridge url', ctx.bridgeUrl),
    line('connection', ctx.connection),
    line('bridge ok', health?.ok ?? 'unknown'),
    line('bridge version', health?.version ?? 'unknown'),
    line('family', health?.family ?? 'unknown'),
    line('model', health?.model_id ?? 'unknown'),
    line('model ready', health?.model_ready ?? 'unknown'),
    line('sources', (health?.sources ?? []).join(', ') || 'none'),
    line('supported languages', (health?.supported_languages ?? []).join(', ') || 'none'),
    line('system audio', health?.system_audio ?? 'unknown'),
    line('apple speech', health?.apple_speech_available ?? 'unknown'),
    line('session active', health?.session?.active ?? false),
    line('session warnings', (health?.session?.warnings ?? []).join(', ') || 'none'),
    line('frontmost app', ctx.frontmostApp || 'unknown'),
    line('active profile', ctx.profileId),
    line('rows in memory', ctx.rowsInMemory),
    line('last error', ctx.lastError || 'none'),
    '',
    'Raw /health:',
    JSON.stringify(health, null, 2),
  ].join('\n');
}
