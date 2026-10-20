import type { RunSummary } from '../../../packages/core/src/types';
export interface RunPage { runs: RunSummary[]; nextCursor: string | null; }

/** Only preserve history if the refreshed head overlaps it, so no gap is hidden. */
export function refreshRunPage(previous: RunPage, fresh: RunPage): RunPage {
  const ids = new Set(fresh.runs.map(run => run.id));
  if (!fresh.nextCursor || !previous.runs.some(run => ids.has(run.id))) return fresh;
  return {runs:[...fresh.runs,...previous.runs.filter(run => !ids.has(run.id))],nextCursor:previous.nextCursor};
}

/** A late response for an obsolete tail cannot overwrite the refreshed cursor. */
export function appendRunPage(previous: RunPage, older: RunPage, requestedCursor: string): RunPage {
  if (previous.nextCursor !== requestedCursor) return previous;
  const ids = new Set(previous.runs.map(run => run.id));
  return {runs:[...previous.runs,...older.runs.filter(run => !ids.has(run.id))],nextCursor:older.nextCursor};
}
