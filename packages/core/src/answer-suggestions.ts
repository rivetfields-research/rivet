import type { Source } from './types.ts';

/** Prefer the sources actually read for this answer over unrelated attachments. */
export function answerSources(sources: readonly Source[], selected: readonly string[] = [], read: readonly string[] = []): Source[] {
  const allowed = sources.filter(source => selected.includes(source.id));
  const used = allowed.filter(source => read.includes(source.id) && source.analytics);
  return used.length ? used : allowed;
}

/** Questions use declared capabilities, never filenames, inferred platforms or raw data. */
export function analyticalQuestions(sources: readonly Source[], seed = 0): string[] {
  const candidates = [...new Set(sources.flatMap(source => source.analytics?.metrics.slice(0, 8).map(metric =>
    metric.id === 'postCount' ? 'How many posts are there?' : `Show ${metric.label.toLowerCase()} by ${source.analytics!.recordLabel}.`) ?? []))];
  if (!candidates.length) return [];
  candidates.push('What data is missing?', 'What dates does this data cover?');
  const start = Math.abs(seed) % candidates.length;
  return Array.from({ length: Math.min(3, candidates.length) }, (_, i) => candidates[(start + i) % candidates.length]!);
}

export function asksForAlternatives(task: string): boolean {
  return /^(?:so[, ]+)?(?:what (?:can (?:you|we)|could (?:you|we)) (?:tell me|learn|calculate|answer|show me)(?: instead)?|what (?:else|instead)(?: can (?:you|we) (?:tell me|learn|calculate|answer|show me))?)[.!?]*$/i.test(task.trim());
}
