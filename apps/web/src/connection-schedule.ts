import type { SyncJob } from '../../../packages/core/src/sync-jobs';

export function scheduleEditorValues(job: SyncJob | null, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, now = new Date()) {
  if (job?.localTime && job.timezone) return { time: job.localTime, timezone: job.timezone, weekday: job.weekday ?? 1 };
  const reference = job?.nextRunAt ? new Date(job.nextRunAt) : new Date(`${now.toISOString().slice(0, 10)}T${job?.timeUtc ?? '06:00'}:00Z`);
  if (!job?.nextRunAt && job?.frequency === 'weekly') reference.setUTCDate(reference.getUTCDate() + ((job.weekday ?? 1) - reference.getUTCDay() + 7) % 7);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'long' }).formatToParts(reference);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === name)!.value;
  return { time: `${part('hour')}:${part('minute')}`, timezone, weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(part('weekday')) };
}
