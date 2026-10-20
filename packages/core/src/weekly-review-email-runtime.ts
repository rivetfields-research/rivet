import type { DatabaseSync } from 'node:sqlite';
import { HarnessError } from './errors.ts';
import { createReportEmailDispatcher, createReportEmailPrepare, createReportEmailStore, type ReportEmailMessage, type ReportEmailOwner, type ReportEmailSender } from './report-email.ts';
import type { Run, RunAccessContext } from './types.ts';
import type { WorkflowSchedule, createWorkflowScheduleStore } from './workflow-schedules.ts';

export interface ReviewEmailContext {
  template: 'intro' | 'weekly';
  isTest: boolean;
  schedule: WorkflowSchedule;
  unsubscribeToken: string;
}

export interface WeeklyReviewEmailOptions {
  sender?: ReportEmailSender;
  /** Resolve from the server's current identity records, never browser input. */
  owner(context: RunAccessContext | null): Promise<ReportEmailOwner | null>;
  compose(run: Run, owner: ReportEmailOwner, context: ReviewEmailContext): ReportEmailMessage | null;
}

export function createWeeklyReviewEmailRuntime(input: {
  db: DatabaseSync;
  schedules: ReturnType<typeof createWorkflowScheduleStore>;
  config?: WeeklyReviewEmailOptions;
  getRun(id: string): Run | undefined;
  isWeeklyWorkflow(id: string): boolean;
  checkPermission(context: RunAccessContext | null): Promise<void>;
  hasSourcePermission(run: Run): boolean;
}) {
  const store = createReportEmailStore(input.db);
  const denied = (): never => { throw new HarnessError('Only the schedule owner can manage its review emails.', 403, 'report_email_owner_required'); };
  const contextEqual = (a: RunAccessContext | null, b: RunAccessContext | null) => a?.workspaceId === b?.workspaceId && a?.actor.issuer === b?.actor.issuer && a?.actor.subject === b?.actor.subject;
  async function ownerFor(id: string, actor?: RunAccessContext | null) {
    const schedule = input.schedules.get(id);
    if (!schedule) throw new HarnessError('Schedule not found.', 404, 'schedule_not_found');
    const context = input.schedules.getAccessContext(id);
    if (actor !== undefined && !contextEqual(actor, context)) return denied();
    await input.checkPermission(context);
    const owner = await input.config?.owner(context);
    if (!owner || context && !contextEqual(context, owner.accessContext)) return denied();
    return { schedule, owner };
  }
  const prepare = createReportEmailPrepare({
    getRun: job => input.getRun(job.runId),
    getSchedule: async job => {
      try { const { schedule, owner } = await ownerFor(job.scheduleId); return { ...owner, enabled: schedule.enabled, archivedAt: schedule.archivedAt }; }
      catch (error) { if (error instanceof HarnessError && [403, 404].includes(error.status)) return null; throw error; }
    },
    admit: async (job, run) => {
      if (job.isTest) {
        const schedule = input.schedules.get(job.scheduleId);
        return !!schedule && run.workflowId === schedule.workflowId && input.isWeeklyWorkflow(schedule.workflowId);
      }
      const attempt = input.schedules.attemptForRequest(run.requestId);
      return attempt?.scheduleId === job.scheduleId && attempt.status === 'started' && attempt.runId === run.id &&
        attempt.schedule.workflowId === run.workflowId && attempt.schedule.workflowVersion === run.workflowVersion;
    },
    hasCurrentMembership: async job => {
      try { await input.checkPermission(input.schedules.getAccessContext(job.scheduleId)); return true; } catch { return false; }
    },
    hasSourcePermission: async (_job, run) => input.hasSourcePermission(run),
    compose: async (run, job) => {
      const { schedule, owner } = await ownerFor(job.scheduleId);
      const recipient = store.getRecipient(owner);
      return input.config?.compose(run, owner, {
        template: job.template ?? 'weekly', isTest: job.isTest === true,
        schedule: job.isTest ? schedule : input.schedules.attemptForRequest(run.requestId)?.schedule ?? schedule,
        unsubscribeToken: recipient.unsubscribeToken,
      }) ?? null;
    },
  });
  const dispatcher = createReportEmailDispatcher({ store, sender: input.config?.sender, prepare });
  let closed = false, ticking: Promise<void> | null = null;
  const status = (id: string, owner: ReportEmailOwner) => store.status(id, { owner, configured: Boolean(input.config?.sender), localOnly: input.config?.sender?.localOnly });
  return {
    applyEvent: store.applyEvent,
    unsubscribe: store.unsubscribe,
    /** Internal operator action; callers must resolve a verified owner first. */
    resetIntroduction: store.resetIntro,
    observeVerifiedOwner(owner: ReportEmailOwner) {
      if (closed) return;
      for (const schedule of input.schedules.list()) {
        const pref = store.getPreference(schedule.id);
        if (pref && contextEqual(pref.accessContext, owner.accessContext)) {
          store.updatePreference(schedule.id, { version: pref.version, enabled: false }, owner);
        }
      }
    },
    async status(id: string, actor: RunAccessContext | null) {
      const { owner } = await ownerFor(id, actor);
      return status(id, owner);
    },
    async update(id: string, value: { version: number; enabled: boolean }, actor: RunAccessContext | null) {
      const { schedule, owner } = await ownerFor(id, actor);
      if (value?.enabled && !input.config?.sender) throw new HarnessError('The Rivet email sender is not configured yet.', 409, 'report_email_unconfigured');
      if (value?.enabled && !input.isWeeklyWorkflow(schedule.workflowId)) throw new HarnessError('Automatic email is available for weekly reviews.', 400, 'report_email_weekly_required');
      // Resolve again after asynchronous identity checks, before changing the opt-in.
      const latest = await ownerFor(id, actor);
      if (latest.owner.recipient !== owner.recipient || input.schedules.get(id)?.version !== schedule.version ||
          !contextEqual(input.schedules.getAccessContext(id), actor)) throw new HarnessError('The schedule changed. Reload before saving email preferences.', 409, 'report_email_version_conflict');
      store.updatePreference(id, value, owner);
      return status(id, owner);
    },
    async test(id: string, value: { requestId: string; forceIntro?: boolean }, actor: RunAccessContext | null) {
      if (!value || Object.keys(value).some(key => !['requestId', 'forceIntro'].includes(key)) ||
          typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(value.requestId) ||
          value.forceIntro !== undefined && typeof value.forceIntro !== 'boolean') throw new HarnessError('Provide a test request ID and optional introduction choice.', 400, 'invalid_report_email_test');
      if (!input.config?.sender) throw new HarnessError('The Rivet email sender is not configured yet.', 409, 'report_email_unconfigured');
      const { schedule, owner } = await ownerFor(id, actor);
      if (!input.isWeeklyWorkflow(schedule.workflowId)) throw new HarnessError('Choose a weekly review schedule.', 400, 'report_email_weekly_required');
      const run = input.schedules.attempts(id).flatMap(attempt => attempt.runId ? [input.getRun(attempt.runId)] : [])
        .find(saved => saved?.status === 'completed' && saved.weeklyReview && saved.result);
      if (!run) throw new HarnessError('Run this review once before sending a test email.', 409, 'report_email_report_required');
      if (!input.hasSourcePermission(run)) throw new HarnessError('The saved review sources are no longer available.', 403, 'report_email_source_unavailable');
      const job = store.enqueueTest({ scheduleId: id, run, owner, forceIntro: value.forceIntro, requestId: value.requestId });
      if (!job) throw new HarnessError('This recipient has stopped review emails.', 409, 'report_email_recipient_suppressed');
      await dispatcher.tick();
      return status(id, owner);
    },
    tick(): Promise<void> {
      if (closed || !input.config?.sender) return Promise.resolve();
      if (!ticking) ticking = (async () => {
        // Recover completions committed before a shutdown; no model or provider data is read here.
        try {
          for (const schedule of input.schedules.list()) {
            if (!store.getPreference(schedule.id)?.enabled) continue;
            for (const attempt of input.schedules.attempts(schedule.id)) {
              if (!attempt.runId || attempt.status !== 'started') continue;
              const run = input.getRun(attempt.runId);
              if (run) store.enqueue({ scheduleId: schedule.id, run });
            }
          }
        } catch (error) {
          // A full retained history blocks new jobs, not delivery of existing jobs.
          if (!(error instanceof HarnessError) || error.code !== 'report_email_history_limit') throw error;
        }
        await dispatcher.tick();
      })().finally(() => { ticking = null; });
      return ticking;
    },
    async close() { closed = true; await dispatcher.close(); await ticking; },
  };
}
