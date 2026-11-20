import type { CaptionRow, TranslationState } from '../caption/captionEngine';
import type { Translator } from './types';

export interface PipelineHooks {
  onUpdate: (rowId: string, text: string, state: TranslationState) => void;
  debounceMs?: number;
}

interface Pending {
  row: CaptionRow;
  timer: ReturnType<typeof setTimeout> | null;
  generation: number;
  controller: AbortController | null;
}

/**
 * Debounced, cancellable translation of ASR utterances.
 *
 * - partials: translate after `debounceMs` of quiet, showing a streaming draft;
 * - finals: translate immediately and refine the draft;
 * - a changed source text invalidates the in-flight request (generation counter + AbortController).
 */
export class TranslationPipeline {
  private readonly pending = new Map<string, Pending>();
  private readonly debounceMs: number;
  private readonly onUpdate: PipelineHooks['onUpdate'];
  private generation = 0;
  private translator: Translator | null;
  private targetLanguage: string;

  constructor(
    translator: Translator | null,
    targetLanguage: string,
    hooks: PipelineHooks,
  ) {
    this.translator = translator;
    this.targetLanguage = targetLanguage;
    this.onUpdate = hooks.onUpdate;
    this.debounceMs = hooks.debounceMs ?? 350;
  }

  configure(translator: Translator | null, targetLanguage: string): void {
    this.cancelAll();
    this.translator = translator;
    this.targetLanguage = targetLanguage;
  }

  schedule(row: CaptionRow): void {
    const translator = this.translator;
    if (translator === null || row.sourceText.trim() === '') return;
    const existing = this.pending.get(row.id);
    if (existing?.controller) existing.controller.abort();
    if (existing?.timer !== null && existing?.timer !== undefined) clearTimeout(existing.timer);

    const generation = ++this.generation;
    const controller = new AbortController();
    const entry: Pending = { row, timer: null, generation, controller };
    this.pending.set(row.id, entry);

    const run = () => {
      entry.timer = null;
      void this.translate(entry, translator);
    };
    if (row.final) run();
    else entry.timer = setTimeout(run, this.debounceMs);
  }

  private async translate(entry: Pending, translator: Translator): Promise<void> {
    const { row, generation } = entry;
    this.onUpdate(row.id, '', 'pending');
    try {
      const text = await translator.translate(
        {
          text: row.sourceText,
          sourceLanguage: row.language,
          targetLanguage: this.targetLanguage,
          signal: entry.controller?.signal,
        },
        (_delta, accumulated) => {
          if (this.pending.get(row.id)?.generation === generation) {
            this.onUpdate(row.id, accumulated, 'streaming');
          }
        },
      );
      if (this.pending.get(row.id)?.generation !== generation) return;
      if (text === '') {
        this.onUpdate(row.id, '', 'error');
        return;
      }
      this.onUpdate(row.id, text, 'done');
    } catch (error) {
      if (this.pending.get(row.id)?.generation !== generation) return;
      if (error instanceof Error && error.name === 'AbortError') return;
      this.onUpdate(row.id, '', 'error');
    }
  }

  cancel(rowId: string): void {
    const entry = this.pending.get(rowId);
    if (entry?.timer !== null && entry?.timer !== undefined) clearTimeout(entry.timer);
    entry?.controller?.abort();
    this.pending.delete(rowId);
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }
}
