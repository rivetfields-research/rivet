import type { createWorkflowScheduleStore, ScheduleAttempt } from './workflow-schedules.ts';

/** Serial, bounded admission. The ordinary run path still owns permission, model
 * budget, source snapshots and idempotency. No prompts or tokens live here. */
export function createScheduleDispatcher(options: {
  store: ReturnType<typeof createWorkflowScheduleStore>;
  busy(): boolean;
  start(attempt: ScheduleAttempt): Promise<{id: string}>;
  now?: () => string;
}) {
  let closed=false;
  let pending: Promise<void> | undefined;
  const clock = () => options.now?.() ?? new Date().toISOString();
  const tick = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending=(async () => {
      const now=clock();
      for (const due of options.store.due(now)) {
        if (closed || options.busy()) break;
        const attempt=options.store.claim(due.id,now);
        if (!attempt) continue;
        try {
          const run=await options.start(attempt);
          if (closed) return;
          options.store.finish(attempt.id,{runId:run.id},clock());
        } catch (error) {
          if (closed) return;
          const code=(error && typeof error==='object' && 'code' in error && typeof error.code==='string') ? error.code : 'schedule_start_failed';
          // Another request can win admission while a permission check awaits.
          // Retain the durable request ID rather than creating a second start.
          if (code==='run_active') break;
          options.store.finish(attempt.id,{errorCode:code},clock());
        }
      }
    })().finally(()=>{pending=undefined;});
    return pending;
  };
  return { tick, async close() { closed=true; } };
}
