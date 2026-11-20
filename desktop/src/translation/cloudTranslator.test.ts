import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudTranslator } from './cloudTranslator';

/** Minimal ReadableStream-shaped body so the test needs no real network. */
function sseResponse(frames: string[]): Response {
  const chunks = frames.map((frame) => new TextEncoder().encode(frame));
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined },
        releaseLock: () => undefined,
      }),
    },
    text: async () => '',
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('CloudTranslator', () => {
  it('streams Gemini text deltas without sending audio', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Xin "}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"chào"}]}}]}\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const translator = new CloudTranslator({ provider: 'gemini', apiKey: 'test-key' });
    const deltas: string[] = [];
    const result = await translator.translate(
      { text: 'hello', sourceLanguage: 'en', targetLanguage: 'vi' },
      (delta) => deltas.push(delta),
    );
    expect(result).toBe('Xin chào');
    expect(deltas).toEqual(['Xin ', 'chào']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(':streamGenerateContent?alt=sse&key=test-key');
    expect(init.body).not.toContain('audio');
  });

  it('parses OpenAI chat-completion deltas and the [DONE] sentinel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hola"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    );
    const translator = new CloudTranslator({ provider: 'openai', apiKey: 'sk-test' });
    const result = await translator.translate(
      { text: 'hello', sourceLanguage: 'en', targetLanguage: 'es' },
      () => undefined,
    );
    expect(result).toBe('Hola');
  });

  it('fails loudly when no API key is configured', async () => {
    const translator = new CloudTranslator({ provider: 'gemini', apiKey: '' });
    await expect(
      translator.translate({ text: 'a', sourceLanguage: 'en', targetLanguage: 'vi' }, () => undefined),
    ).rejects.toThrow('API key');
  });
});
