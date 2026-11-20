import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationPipeline } from './pipeline';
import type { CaptionRow, TranslationState } from '../caption/captionEngine';
import type { Translator } from './types';

const row = (overrides: Partial<CaptionRow> = {}): CaptionRow => ({
  id: 's1:1',
  sessionId: 's1',
  segmentId: 1,
  sourceText: 'hello world',
  translatedText: '',
  translationState: 'pending',
  final: false,
  source: 'system',
  language: 'en',
  t0Ms: 0,
  t1Ms: 100,
  seq: 1,
  vocabularyApplied: false,
  ...overrides,
});

function translator(handler: (text: string, onDelta: (d: string) => void) => Promise<string>): Translator {
  return {
    id: 'gemini',
    label: 'test',
    requiresKey: true,
    translate: async (req, onDelta) => handler(req.text, (delta) => onDelta(delta, delta)),
  };
}

afterEach(() => vi.useRealTimers());

describe('translation pipeline', () => {
  it('debounces partials and translates finals immediately', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const updates: Array<[string, string, TranslationState]> = [];
    const pipeline = new TranslationPipeline(
      translator(async (text, delta) => {
        calls.push(text);
        delta('Xin chào');
        return 'Xin chào';
      }),
      'vi',
      { onUpdate: (id, text, state) => updates.push([id, text, state]), debounceMs: 300 },
    );

    pipeline.schedule(row());
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual(['hello world']);
    expect(updates.at(-1)).toEqual(['s1:1', 'Xin chào', 'done']);

    pipeline.schedule(row({ sourceText: 'goodbye', final: true }));
    expect(calls).toHaveLength(2); // no debounce for a final
  });

  it('cancels a stale request when the source text changes', async () => {
    vi.useFakeTimers();
    let resolveFirst: (value: string) => void = () => undefined;
    const calls: string[] = [];
    const pipeline = new TranslationPipeline(
      translator(
        (text) =>
          new Promise<string>((resolve) => {
            calls.push(text);
            if (calls.length === 1) resolveFirst = resolve;
            else resolve('dịch mới');
          }),
      ),
      'vi',
      { onUpdate: () => undefined, debounceMs: 0 },
    );

    pipeline.schedule(row({ sourceText: 'first' }));
    await vi.advanceTimersByTimeAsync(0);
    pipeline.schedule(row({ sourceText: 'second' }));
    await vi.advanceTimersByTimeAsync(0);
    resolveFirst('dịch cũ');
    await Promise.resolve();
    expect(calls).toEqual(['first', 'second']);
  });

  it('marks translation as error when the provider throws', async () => {
    const updates: TranslationState[] = [];
    const pipeline = new TranslationPipeline(
      translator(async () => {
        throw new Error('quota');
      }),
      'vi',
      { onUpdate: (_id, _text, state) => updates.push(state) },
    );
    pipeline.schedule(row({ final: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).toContain('error');
  });
});
