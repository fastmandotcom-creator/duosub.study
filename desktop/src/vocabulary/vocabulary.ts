export interface VocabularyEntry {
  id: string;
  from: string;
  to: string;
  enabled: boolean;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Case-insensitive whole-word-ish replacements, longest rule first, so "OpenAI" is not mangled by
 * a rule for "AI". Unicode-aware so Vietnamese and Japanese text survive.
 */
export function applyVocabulary(text: string, entries: readonly VocabularyEntry[]): string {
  const rules = entries
    .filter((entry) => entry.enabled && entry.from.trim() !== '')
    .slice()
    .sort((a, b) => b.from.length - a.from.length);
  let result = text;
  for (const rule of rules) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(rule.from)}(?![\\p{L}\\p{N}])`, 'giu');
    result = result.replace(pattern, (match) => {
      if (match === match.toUpperCase()) return rule.to.toUpperCase();
      if (match[0] === match[0].toUpperCase()) return rule.to.charAt(0).toUpperCase() + rule.to.slice(1);
      return rule.to;
    });
  }
  return result;
}
