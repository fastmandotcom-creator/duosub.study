import { parseSseChunk } from '@duosub/caption-contract';
import type { TranslateRequest, TranslationProvider, Translator } from './types';

export interface CloudTranslatorOptions {
  provider: Exclude<TranslationProvider, 'none'>;
  apiKey: string;
  model?: string;
  targetLanguage?: string;
}

const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const OPENAI_MODEL = 'gpt-4o-mini';

const languageName: Record<string, string> = {
  vi: 'Vietnamese',
  en: 'English',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  yue: 'Cantonese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

export function translatePrompt(req: TranslateRequest): string {
  const target = languageName[req.targetLanguage] ?? req.targetLanguage;
  const source = req.sourceLanguage === 'auto' ? 'auto-detected' : (languageName[req.sourceLanguage] ?? req.sourceLanguage);
  return [
    `Translate the text below from ${source} into ${target}.`,
    'Output ONLY the translated text — no quotes, no notes, no explanation.',
    'Preserve names, numbers and technical terms exactly.',
    '',
    req.text,
  ].join('\n');
}

/**
 * Text-only translation. Crucially, audio NEVER leaves the machine: ASR runs in the DuoSub bridge
 * and only the recognised text is sent here. This is a different stage from the extension's
 * `cloudLiveCaptionProducer`, which streams *audio* to a vendor's ASR+MT model.
 */
export class CloudTranslator implements Translator {
  readonly id: Exclude<TranslationProvider, 'none'>;
  readonly label: string;
  readonly requiresKey = true;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: CloudTranslatorOptions) {
    this.id = options.provider;
    this.label = options.provider === 'gemini' ? 'Gemini (text translation)' : 'OpenAI (text translation)';
    this.apiKey = options.apiKey;
    this.model = options.model ?? (options.provider === 'gemini' ? GEMINI_MODEL : OPENAI_MODEL);
  }

  async translate(req: TranslateRequest, onDelta: (delta: string, accumulated: string) => void): Promise<string> {
    if (this.apiKey.trim() === '') throw new Error('Chưa có API key cho dịch đám mây.');
    const isGemini = this.id === 'gemini';
    const endpoint = isGemini
      ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`
      : 'https://api.openai.com/v1/chat/completions';
    const body = isGemini
      ? JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: translatePrompt(req) }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 768 },
        })
      : JSON.stringify({
          model: this.model,
          stream: true,
          temperature: 0.1,
          messages: [
            { role: 'system', content: `Translate into ${req.targetLanguage}. Output only the translation.` },
            { role: 'user', content: translatePrompt(req) },
          ],
        });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(isGemini ? {} : { Authorization: `Bearer ${this.apiKey}` }),
      },
      body,
      signal: req.signal,
    });
    if (!response.ok || response.body === null) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Dịch thất bại (HTTP ${response.status}): ${detail}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulated = '';
    const delta = (text: string) => {
      if (text === '') return;
      accumulated += text;
      onDelta(text, accumulated);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalise \r\n so the shared SSE parser sees its \n\n delimiter.
      buffer = buffer.replace(/\r\n/g, '\n');
      buffer = parseSseChunk(buffer, (frame) => {
        if (frame.data.trim() === '[DONE]') return;
        try {
          const json = JSON.parse(frame.data) as Record<string, unknown>;
          if (isGemini) {
            const candidates = json.candidates as Array<Record<string, unknown>> | undefined;
            const parts = (candidates?.[0]?.content as Record<string, unknown> | undefined)?.parts as
              | Array<Record<string, unknown>>
              | undefined;
            for (const part of parts ?? []) if (typeof part.text === 'string') delta(part.text);
          } else {
            const choices = json.choices as Array<Record<string, unknown>> | undefined;
            const content = (choices?.[0]?.delta as Record<string, unknown> | undefined)?.content;
            if (typeof content === 'string') delta(content);
          }
        } catch {
          // A keep-alive or partial frame is not a translation error — skip it.
        }
      });
    }
    return accumulated.trim();
  }
}

export class NoopTranslator implements Translator {
  readonly id = 'none' as const;
  readonly label = 'Không dịch';
  readonly requiresKey = false;
  async translate(): Promise<string> {
    return '';
  }
}
