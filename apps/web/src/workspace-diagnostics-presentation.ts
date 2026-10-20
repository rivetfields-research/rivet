import type { AllowanceCounter, ModelAllowanceSnapshot } from '../../../packages/core/src/workspace-diagnostics';

export type AllowanceCapacity = { status: 'unavailable' } | {
  status: 'available'; remaining: number; exhausted: boolean;
  gauge: { min: number; max: number; value: number };
};

/** Missing or non-finite limits are unknown, never an unlimited allowance. */
export function allowanceCapacity(counter: AllowanceCounter | null | undefined): AllowanceCapacity {
  if (!counter || !Number.isSafeInteger(counter.used) || counter.used < 0 ||
      !Number.isSafeInteger(counter.limit) || counter.limit < 0) return { status: 'unavailable' };
  const remaining = Math.min(counter.limit, Math.max(0, counter.limit - counter.used));
  return { status: 'available', remaining, exhausted: remaining === 0,
    // Native meters require max > min, even when the reported limit is zero.
    gauge: { min: 0, max: Math.max(1, counter.limit), value: remaining } };
}

export function allowanceReset(snapshot: Pick<ModelAllowanceSnapshot, 'period' | 'resetsAt'>): { dateTime: string | null; text: string } {
  if (snapshot.resetsAt === null) return { dateTime: null, text: snapshot.period === 'batch'
    ? 'No automatic renewal. A new batch requires owner approval.' : 'Reset time unavailable.' };
  const reset = new Date(snapshot.resetsAt);
  if (!Number.isFinite(reset.getTime())) return { dateTime: null, text: 'Reset time unavailable.' };
  return { dateTime: snapshot.resetsAt, text: new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(reset) };
}
