import type { Run, RunUpdate } from '../../../packages/core/src/types';

/** Reconnection may repeat a page, but it must never repeat or skip an action. */
export function mergeRunUpdate(current: Run, update: RunUpdate): Run {
  if (!update || update.run?.id !== current.id || !Array.isArray(update.events) || !Number.isSafeInteger(update.cursor) || update.cursor < 0 || typeof update.hasMore !== 'boolean') throw new Error('The live task update was not valid.');
  const last = current.events.at(-1)?.sequence ?? 0;
  if (update.cursor < last) return current;
  const events = [...current.events];
  for (const event of update.events) {
    if (!event || typeof event.id !== 'string' || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error('The live task event was not valid.');
    if (event.sequence <= last) {
      if (events[event.sequence - 1]?.id !== event.id) throw new Error('The live task history changed. Reload the task.');
      continue;
    }
    if (event.sequence !== events.length + 1) throw new Error('A live task event is missing. Reload to recover its saved history.');
    events.push(event);
  }
  if ((events.at(-1)?.sequence ?? 0) !== update.cursor) throw new Error('The live task cursor does not match its events.');
  if (!['queued', 'running'].includes(current.status) && ['queued', 'running'].includes(update.run.status)) return current;
  return { ...update.run, events };
}
