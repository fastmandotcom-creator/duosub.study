/**
 * Safe Tauri bridge. Every call degrades to a no-op in a plain browser so the whole UI can be
 * developed and tested with `npm run dev` against a real bridge on 127.0.0.1:4499 — no Rust build
 * and no macOS permissions needed for the visual work.
 */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** In-browser fallback so two dev tabs (main + overlay) can still talk to each other. */
const channels = new Map<string, BroadcastChannel[]>();

function broadcast(event: string, payload: unknown): void {
  try {
    const channel = new BroadcastChannel('duosub');
    channel.postMessage({ event, payload });
    channel.close();
  } catch {
    // BroadcastChannel is optional.
  }
}

export async function invokeSafe<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (error) {
    console.warn(`[duosub] invoke(${cmd}) failed`, error);
    return null;
  }
}

export async function listenSafe<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isTauri()) {
    try {
      const channel = new BroadcastChannel('duosub');
      channel.onmessage = (message: MessageEvent<{ event: string; payload: T }>) => {
        if (message.data?.event === event) handler(message.data.payload);
      };
      channels.set(event, [...(channels.get(event) ?? []), channel]);
      return () => {
        channel.close();
        channels.set(event, (channels.get(event) ?? []).filter((item) => item !== channel));
      };
    } catch {
      return () => undefined;
    }
  }
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen<T>(event, (e) => handler(e.payload));
  } catch (error) {
    console.warn(`[duosub] listen(${event}) failed`, error);
    return () => undefined;
  }
}

export async function emitSafe(event: string, payload?: unknown): Promise<void> {
  if (!isTauri()) {
    broadcast(event, payload);
    return;
  }
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(event, payload);
  } catch (error) {
    console.warn(`[duosub] emit(${event}) failed`, error);
  }
}

export async function writeTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Tauri webviews sometimes deny the async Clipboard API on http origins.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export interface SaveDialogResult {
  path: string | null;
}

/** Prefer the native save dialog; fall back to a browser download in dev. */
export async function saveTextFile(
  suggestedName: string,
  content: string,
  mime = 'text/plain',
): Promise<string> {
  if (isTauri()) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({ defaultPath: suggestedName });
      if (path) {
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        await writeTextFile(path, content);
        return path;
      }
      return '';
    } catch (error) {
      console.warn('[duosub] native save failed, using browser download', error);
    }
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return suggestedName;
}
