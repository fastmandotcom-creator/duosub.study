export type TranslationProvider = 'none' | 'gemini' | 'openai';

export interface TranslateRequest {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  signal?: AbortSignal;
}

export interface Translator {
  readonly id: TranslationProvider;
  readonly label: string;
  readonly requiresKey: boolean;
  /** Streams deltas and resolves with the complete translation. */
  translate(req: TranslateRequest, onDelta: (delta: string, accumulated: string) => void): Promise<string>;
}
