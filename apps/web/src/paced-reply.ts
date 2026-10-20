import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const REPLY_CHARACTERS_PER_SECOND = 50;
const REPLY_TICK_MS = 40;

/** Pace received prose independently of the network batch size. A background
 * tab resuming must not spend its elapsed time in one large visual jump. */
export function advanceReplyReveal(target: string, shown: string, elapsedMs: number, reducedMotion = false): string {
  if (reducedMotion) return target;
  const start = target.startsWith(shown) ? shown.length : 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return target.slice(0, start);
  const count = Math.floor(REPLY_CHARACTERS_PER_SECOND * Math.min(200, elapsedMs) / 1000);
  let end = Math.min(target.length, start + count);
  if (end < target.length && /[\uD800-\uDBFF]/.test(target[end - 1] ?? '')) end--;
  return target.slice(0, end);
}

export function wholeReplyPrefix(shown: string, target: string): string {
  if (!target.startsWith(shown)) return '';
  if (shown === target || /\s/.test(target[shown.length] ?? '')) return shown;
  const boundary = shown.search(/\S+$/);
  return boundary < 0 ? shown : shown.slice(0, boundary);
}

export type PacedReplyOptions = {
  streamKey: string;
  revisionKey?: string;
  active: boolean;
  complete: boolean;
};

type ReplyInput = PacedReplyOptions & { text: string | null; reducedMotion?: boolean };
export type ReplyRevealState = {
  streamKey: string;
  revisionKey?: string;
  target: string;
  shown: string;
  seenActive: boolean;
  revealAll: boolean;
};

/** Pure reconciliation makes changed runs, rejected drafts and corrected final
 * text disappear in the same render. Only an observed live run is animated. */
export function reconcileReplyReveal(previous: ReplyRevealState | null, input: ReplyInput): ReplyRevealState {
  const sameRun = previous?.streamKey === input.streamKey;
  const state = sameRun ? previous : null;
  const seenActive = Boolean(state?.seenActive || input.active);
  const revisionChanged = input.revisionKey !== undefined && state?.revisionKey !== input.revisionKey;
  const revisionKey = input.revisionKey ?? state?.revisionKey;
  if (!input.text || (!input.active && !input.complete)) {
    return { streamKey: input.streamKey, revisionKey, target: '', shown: '', seenActive: input.active && seenActive, revealAll: false };
  }
  const samePrefix = !revisionChanged && input.text.startsWith(state?.shown ?? '');
  const revealAll = Boolean(state?.revealAll && samePrefix);
  const immediate = input.reducedMotion || revealAll || (input.complete && !seenActive);
  return {
    streamKey: input.streamKey, revisionKey, target: input.text,
    shown: immediate ? input.text : samePrefix ? state?.shown ?? '' : '',
    seenActive, revealAll,
  };
}

export function usePacedReply(text: string | null, options: PacedReplyOptions): {
  text: string | null;
  revealing: boolean;
  showAll: () => void;
} {
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [stored, setStored] = useState<ReplyRevealState | null>(null);
  const input = { text, ...options, reducedMotion };
  const latest = useRef(input); latest.current = input;
  const state = reconcileReplyReveal(stored, input);
  const revealing = state.shown !== state.target;

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    setStored(current => reconcileReplyReveal(current, latest.current));
  }, [text, options.streamKey, options.revisionKey, options.active, options.complete, reducedMotion]);

  useEffect(() => {
    if (!revealing) return;
    // One clock survives rapid SSE deltas and the switch to saved completion.
    // Nothing here delays backend work, final status, tools or follow-up access.
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - last; last = now;
      setStored(current => {
        const next = reconcileReplyReveal(current, latest.current);
        return { ...next, shown: advanceReplyReveal(next.target, next.shown, elapsed, latest.current.reducedMotion) };
      });
    }, REPLY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [revealing, options.streamKey]);

  return {
    text: wholeReplyPrefix(state.shown, state.target) || null,
    revealing,
    showAll: () => setStored(current => {
      const next = reconcileReplyReveal(current, latest.current);
      return { ...next, shown: next.target, revealAll: true };
    }),
  };
}
