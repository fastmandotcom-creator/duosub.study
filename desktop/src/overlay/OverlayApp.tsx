import { useEffect, useState, type MouseEvent } from 'react';
import { listenSafe } from '../platform/tauri';

interface OverlayCaption {
  rows: Array<{
    translatedText: string;
    sourceText: string;
    final: boolean;
  }>;
  visible: boolean;
  showSource: boolean;
  fontSize: number;
}

const EMPTY: OverlayCaption = { rows: [], visible: false, showSource: true, fontSize: 18 };

export function OverlayApp() {
  const [caption, setCaption] = useState<OverlayCaption>(EMPTY);

  useEffect(() => {
    let unlistenA: () => void = () => undefined;
    let unlistenB: () => void = () => undefined;
    void listenSafe<OverlayCaption>('duosub:caption', (payload) => setCaption(payload)).then((fn) => { unlistenA = fn; });
    void listenSafe<{ visible: boolean }>('duosub:overlay-visibility', (payload) =>
      setCaption((current) => ({ ...current, visible: payload.visible })),
    ).then((fn) => { unlistenB = fn; });
    return () => { unlistenA(); unlistenB(); };
  }, []);

  const startDrag = (event: MouseEvent) => {
    if (event.button !== 0) return;
    if ('__TAURI_INTERNALS__' in window) {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().startDragging());
    }
  };

  const latest = caption.rows.at(-1);
  if (!caption.visible || latest === undefined || (latest.translatedText === '' && latest.sourceText === '')) {
    return null;
  }

  return (
    <div
      className="overlay-root"
      onMouseDown={startDrag}
      style={{ fontSize: caption.fontSize }}
    >
      <div className="overlay-line">{latest.translatedText || latest.sourceText}</div>
      {caption.showSource && latest.translatedText !== '' && (
        <div className="overlay-source">{latest.sourceText}</div>
      )}
    </div>
  );
}
