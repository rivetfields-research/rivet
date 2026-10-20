import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HarnessError } from './errors.ts';
import type { Run, RunAccessContext } from './types.ts';

export interface ReportEmailMessage { from: string; replyTo?: string; to: string; subject: string; text: string; html?: string; headers?: Record<string, string> }
export interface ReportEmailSender {
  localOnly?: boolean;
  send(message: ReportEmailMessage, options: { idempotencyKey: string; signal: AbortSignal }): Promise<{ id: string }>;
}
/** This argument comes from verified sign-in and server ownership, never request JSON. */
export interface ReportEmailOwner { recipient: string; accessContext: RunAccessContext; firstName?: string; workspaceName?: string }
export interface ReportEmailRecipient extends ReportEmailOwner {
  id: string; unsubscribeToken: string; introSentAt: string | null; unsubscribedAt: string | null;
  suppressedAt: string | null; suppressionReason: 'bounced' | 'complained' | 'suppressed' | null; updatedAt: string;
}
export interface ReportEmailPreference extends ReportEmailOwner {
  scheduleId: string; version: number; enabled: boolean; enabledAt: string | null; updatedAt: string;
}
export type ReportEmailDeliveryStatus = 'pending' | 'sending' | 'retry' | 'submitted' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed' | 'captured' | 'cancelled' | 'needs_attention';
export type ReportEmailErrorCode = 'cancelled' | 'preparation_failed' | 'send_failed' | 'send_rejected' | 'payload_changed' | 'retry_expired' | 'retry_limit';
export type ReportEmailEventType = 'email.sent' | 'email.delivered' | 'email.delivery_delayed' | 'email.bounced' | 'email.complained' | 'email.failed' | 'email.suppressed';
/** The server verifies the provider signature before calling applyEvent. No raw webhook body is retained. */
export interface ReportEmailEvent { id: string; type: ReportEmailEventType; occurredAt: string; providerId: string; recipient?: string }
export interface ReportEmailTimelineEntry { id: string; type: ReportEmailEventType | ReportEmailDeliveryStatus; occurredAt: string; status: ReportEmailDeliveryStatus }
export interface ReportEmailJob extends ReportEmailOwner {
  idempotencyKey: string; scheduleId: string; runId: string; artifactId: string;
  preferenceVersion: number; savedOutputHash: string; payloadHash: string | null;
  createdAt: string; runCreatedAt: string; completedAt: string; updatedAt: string;
  firstAttemptAt: string | null; nextAttemptAt: string; attempts: number;
  status: ReportEmailDeliveryStatus; localOnly: boolean | null; providerId: string | null;
  errorCode: ReportEmailErrorCode | null;
  template: 'intro' | 'weekly'; isTest: boolean; periodEnd: string; timeline: ReportEmailTimelineEntry[];
}

const descriptions: Record<ReportEmailErrorCode, string> = {
  cancelled: 'Email cancelled because this review is no longer eligible.',
  preparation_failed: 'The saved review could not be checked. Another attempt is scheduled.',
  send_failed: 'The email submission could not be confirmed. Another attempt may be scheduled.',
  send_rejected: 'The email service rejected this message. Operator review is required.',
  payload_changed: 'The saved review or email changed. Operator review is required.',
  retry_expired: 'The safe retry window expired. Operator review is required.',
  retry_limit: 'The retry limit was reached. Operator review is required.',
};
// Resend retains keys for 24 hours. Leave two hours for clock and request uncertainty.
export const REPORT_EMAIL_RETRY_WINDOW_MS = 22 * 60 * 60 * 1000;
export const REPORT_EMAIL_MAX_ATTEMPTS = 3;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const HEADER_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const fail = (message: string, code = 'invalid_report_email', status = 400): never => { throw new HarnessError(message, status, code); };
const iso = (value: string) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fail('Provide a valid email timestamp.');
  return new Date(value).toISOString();
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item ?? null)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function reportEmailSavedOutputHash(run: Run): string {
  return hash({ result: run.result, weeklyReview: run.weeklyReview, sources: run.sources, sourceIds: run.sourceIds });
}
export function reportEmailPayloadHash(message: ReportEmailMessage): string {
  return hash({ from: message.from, replyTo: message.replyTo, to: message.to, subject: message.subject, text: message.text,
    ...(message.html !== undefined ? { html: message.html } : {}), ...(message.headers !== undefined ? { headers: message.headers } : {}) });
}
export function validReportEmailHeaders(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const entries = Object.entries(value), names = new Set<string>();
  if (entries.length > 20) return false;
  let size = 0;
  for (const [name, content] of entries) {
    const lower = name.toLowerCase();
    if (!/^[A-Za-z0-9-]{1,80}$/.test(name) || names.has(lower) ||
        ['to', 'cc', 'bcc', 'from', 'sender', 'reply-to', 'subject', 'authorization', 'content-type', 'mime-version', 'content-transfer-encoding', 'return-path'].includes(lower) ||
        typeof content !== 'string' || !content.trim() || content.length > 2048 || HEADER_CONTROLS.test(content)) return false;
    names.add(lower); size += Buffer.byteLength(name + content);
  }
  return size <= 8192;
}
export function validReportEmailRecipient(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && !HEADER_CONTROLS.test(value) && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value);
}
function copyOwner(owner: ReportEmailOwner): ReportEmailOwner {
  const access = owner?.accessContext;
  if (!validReportEmailRecipient(owner?.recipient) || !access ||
      ![access.workspaceId, access.actor?.issuer, access.actor?.subject].every(value => typeof value === 'string' && value.length > 0 && value.length <= 500)) {
    return fail('A verified schedule owner email is required.');
  }
  const profile: Pick<ReportEmailOwner, 'firstName' | 'workspaceName'> = {};
  for (const key of ['firstName', 'workspaceName'] as const) if (owner[key] !== undefined) {
    if (typeof owner[key] !== 'string' || owner[key]!.length > 160 || HEADER_CONTROLS.test(owner[key]!) || /[{}\u202a-\u202e\u2066-\u2069]/u.test(owner[key]!)) return fail('Provide explicit readable email personalization.');
    const value = owner[key]!.trim(); if (value) profile[key] = value;
  }
  return { recipient: owner.recipient, accessContext: { workspaceId: access.workspaceId, actor: { issuer: access.actor.issuer, subject: access.actor.subject } }, ...profile };
}
const recipientId = (owner: ReportEmailOwner) => hash([owner.accessContext.workspaceId, owner.accessContext.actor.issuer, owner.accessContext.actor.subject, owner.recipient.toLowerCase()]);
const sameOwner = (a: ReportEmailOwner, b: ReportEmailOwner) => a.recipient === b.recipient && canonical(a.accessContext) === canonical(b.accessContext);
const terminal = (status: ReportEmailDeliveryStatus) => !['pending', 'sending', 'retry'].includes(status);
const eligibleRun = (run: Run) => run.status === 'completed' && !!run.weeklyReview && !!run.result && !!run.result.id;
// First sends age from completion; uncertain submissions retain their original retry window.
const submissionDeadline = (job: ReportEmailJob) =>
  Date.parse(job.firstAttemptAt ?? (job.isTest ? job.createdAt : job.completedAt)) + REPORT_EMAIL_RETRY_WINDOW_MS;
const submissionExpired = (job: ReportEmailJob, stamp: string) =>
  Date.parse(stamp) >= submissionDeadline(job);

/** Private persistence API. Return only status() to clients. No bodies or credentials are retained. */
export function createReportEmailStore(db: DatabaseSync, options: { now?: () => string; maxJobs?: number; maxPreferences?: number } = {}) {
  const now = () => iso(options.now?.() ?? new Date().toISOString());
  const boundedLimit = (value: number | undefined, maximum: number) => {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > maximum)) return fail('Provide a bounded email history limit.');
    return value ?? maximum;
  };
  const maxJobs = boundedLimit(options.maxJobs, 10_000), maxPreferences = boundedLimit(options.maxPreferences, 1000);
  // Cache presence only, so another store's first write becomes visible.
  let present = false, writable = false;
  const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const hasSchema = () => present ||= Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_email_preferences'").get());
  const ensureSchema = () => {
    if (writable) return;
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS report_email_preferences (schedule_id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS report_email_jobs (
          idempotency_key TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, run_id TEXT NOT NULL,
          status TEXT NOT NULL, next_attempt_at TEXT NOT NULL, data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS report_email_recipients (recipient_id TEXT PRIMARY KEY, unsubscribe_token TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS report_email_events (event_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS report_email_events_provider ON report_email_events(provider_id);`);
      const runUnique = db.prepare('PRAGMA index_list(report_email_jobs)').all().some(index => index.unique &&
        canonical(db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(String(index.name)).map(row => row.name)) === canonical(['schedule_id', 'run_id']));
      if (runUnique) {
        db.exec(`CREATE TABLE report_email_jobs_next (
            idempotency_key TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, run_id TEXT NOT NULL,
            status TEXT NOT NULL, next_attempt_at TEXT NOT NULL, data TEXT NOT NULL);
          INSERT INTO report_email_jobs_next SELECT * FROM report_email_jobs;
          DROP TABLE report_email_jobs;
          ALTER TABLE report_email_jobs_next RENAME TO report_email_jobs;`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS report_email_pending ON report_email_jobs(status,next_attempt_at);
        CREATE INDEX IF NOT EXISTS report_email_schedule_run ON report_email_jobs(schedule_id,run_id);
        CREATE INDEX IF NOT EXISTS report_email_schedule_period ON report_email_jobs(schedule_id,json_extract(data,'$.periodEnd'),lower(json_extract(data,'$.recipient')))
          WHERE coalesce(json_extract(data,'$.isTest'),0)=0;
        CREATE INDEX IF NOT EXISTS report_email_legacy_jobs ON report_email_jobs(schedule_id)
          WHERE json_type(data,'$.periodEnd') IS NULL AND coalesce(json_extract(data,'$.isTest'),0)=0;`);
    });
    present = true; writable = true;
  };
  const transaction = <T>(action: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const getPreference = (scheduleId: string): ReportEmailPreference | undefined => {
    if (!hasSchema()) return undefined;
    const row = db.prepare('SELECT data FROM report_email_preferences WHERE schedule_id=?').get(scheduleId);
    return row ? JSON.parse(row.data as string) : undefined;
  };
  const getJob = (key: string): ReportEmailJob | undefined => {
    if (!hasSchema()) return undefined;
    const row = db.prepare('SELECT data FROM report_email_jobs WHERE idempotency_key=?').get(key);
    return row ? normalizeJob(JSON.parse(row.data as string)) : undefined;
  };
  const periodFor = (run: Run) => iso(run.weeklyReview!.period.to);
  const normalizeJob = (job: ReportEmailJob): ReportEmailJob => {
    if (job.template !== undefined && job.isTest !== undefined && job.periodEnd !== undefined && job.timeline !== undefined) return job;
    const saved = hasTable('runs') ? db.prepare('SELECT data FROM runs WHERE id=?').get(job.runId) : undefined;
    const run = saved ? JSON.parse(saved.data as string) as Run : undefined;
    return { ...job, template: job.template ?? 'weekly', isTest: job.isTest ?? false,
      periodEnd: job.periodEnd ?? (run?.weeklyReview ? periodFor(run) : job.completedAt), timeline: job.timeline ?? [] };
  };
  const saveJob = (job: ReportEmailJob) => db.prepare('UPDATE report_email_jobs SET status=?,next_attempt_at=?,data=? WHERE idempotency_key=?')
    .run(job.status, job.nextAttemptAt, JSON.stringify(job), job.idempotencyKey);
  const readRecipient = (owner: ReportEmailOwner): ReportEmailRecipient | undefined => {
    if (!hasTable('report_email_recipients')) return undefined;
    const row = db.prepare('SELECT data FROM report_email_recipients WHERE recipient_id=?').get(recipientId(owner));
    return row ? JSON.parse(row.data as string) : undefined;
  };
  const saveRecipient = (recipient: ReportEmailRecipient) => db.prepare('INSERT INTO report_email_recipients VALUES (?,?,?) ON CONFLICT(recipient_id) DO UPDATE SET data=excluded.data')
    .run(recipient.id, recipient.unsubscribeToken, JSON.stringify(recipient));
  const recipientFor = (owner: ReportEmailOwner): ReportEmailRecipient => {
    const previous = readRecipient(owner);
    if (!previous && Number(db.prepare('SELECT count(*) AS n FROM report_email_recipients').get()!.n) >= 10_000) return fail('Retained email recipients need operator review.', 'report_email_recipient_limit', 409);
    const recipient: ReportEmailRecipient = previous ? { ...previous, ...owner, firstName: owner.firstName, workspaceName: owner.workspaceName } : {
      ...owner, id: recipientId(owner), unsubscribeToken: randomBytes(32).toString('hex'), introSentAt: null, unsubscribedAt: null,
      suppressedAt: null, suppressionReason: null, updatedAt: now(),
    };
    if (!previous || canonical(recipient) !== canonical(previous)) { recipient.updatedAt = now(); saveRecipient(recipient); }
    return recipient;
  };
  const blocked = (owner: ReportEmailOwner) => { const value = readRecipient(owner); return Boolean(value?.unsubscribedAt || value?.suppressedAt); };
  const timeline = (job: ReportEmailJob, status: ReportEmailDeliveryStatus, stamp: string, type: ReportEmailTimelineEntry['type'] = status, id = `${type}:${job.attempts}:${stamp}`) =>
    [...job.timeline, { id, type, occurredAt: stamp, status }].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const active = (job: ReportEmailJob) => {
    if (blocked(job)) return false;
    const pref = getPreference(job.scheduleId);
    if (job.isTest) return Boolean(readRecipient(job) && (!pref || sameOwner(pref, job)));
    return !!pref?.enabled && pref.version === job.preferenceVersion && !!pref.enabledAt && job.runCreatedAt >= pref.enabledAt && sameOwner(pref, job);
  };
  const finish = (key: string, status: ReportEmailDeliveryStatus, errorCode: ReportEmailErrorCode | null = null, providerId: string | null = null) => {
    const job = getJob(key);
    // An opt-out can cancel the queue while the provider is accepting an in-flight request.
    const lateReceipt = job?.status === 'cancelled' && job.attempts > 0 && providerId && (status === 'submitted' || status === 'captured');
    if (!job || terminal(job.status) && !lateReceipt) return;
    const stamp = now();
    saveJob({ ...job, status, errorCode, providerId, updatedAt: stamp, timeline: timeline(job, status, stamp) });
  };
  const cancelRecipient = (owner: ReportEmailOwner) => {
    for (const row of db.prepare("SELECT data FROM report_email_jobs WHERE status IN ('pending','sending','retry')").all()) {
      const job = normalizeJob(JSON.parse(row.data as string));
      if (recipientId(job) === recipientId(owner)) finish(job.idempotencyKey, 'cancelled', 'cancelled');
    }
  };
  const ranks: Partial<Record<ReportEmailDeliveryStatus, number>> = { submitted: 1, delayed: 2, failed: 3, delivered: 4, bounced: 5, complained: 6 };
  const eventStatus: Record<ReportEmailEventType, ReportEmailDeliveryStatus> = {
    'email.sent': 'submitted', 'email.delivered': 'delivered', 'email.delivery_delayed': 'delayed',
    'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed', 'email.suppressed': 'failed',
  };
  const applyToJob = (event: ReportEmailEvent): boolean => {
    const rows = db.prepare("SELECT data FROM report_email_jobs WHERE json_extract(data,'$.providerId')=? LIMIT 2").all(event.providerId);
    if (rows.length !== 1) return false;
    const job = normalizeJob(JSON.parse(rows[0].data as string));
    if (job.localOnly !== false || event.recipient && event.recipient.toLowerCase() !== job.recipient.toLowerCase()) return false;
    if (job.timeline.some(item => item.id === event.id)) return true;
    const next = eventStatus[event.type], stamp = now();
    const status = (ranks[next] ?? 0) > (ranks[job.status] ?? 0) ? next : job.status;
    saveJob({ ...job, status, updatedAt: stamp, timeline: timeline(job, status, event.occurredAt, event.type, event.id) });
    const recipient = readRecipient(job) ?? recipientFor(copyOwner(job));
    if (next === 'bounced' || next === 'complained' || event.type === 'email.suppressed') {
      const reason = event.type === 'email.suppressed' ? 'suppressed' : next as 'bounced' | 'complained';
      saveRecipient({ ...recipient, suppressedAt: recipient.suppressedAt ?? event.occurredAt,
        suppressionReason: recipient.suppressionReason === 'complained' ? 'complained' : reason,
        ...(next === 'complained' ? { unsubscribedAt: recipient.unsubscribedAt ?? event.occurredAt } : {}), updatedAt: stamp });
      cancelRecipient(job);
    } else if (status === 'delivered' && next === 'delivered' && job.template === 'intro' && !job.isTest && !recipient.introSentAt) {
      saveRecipient({ ...recipient, introSentAt: event.occurredAt, updatedAt: stamp });
    }
    return true;
  };
  const insertJob = (scheduleId: string, run: Run, owner: ReportEmailOwner, key: string, isTest: boolean, forceIntro = false): ReportEmailJob => {
    const recipient = recipientFor(owner), stamp = now();
    if (Number(db.prepare('SELECT count(*) AS n FROM report_email_jobs').get()!.n) >= maxJobs) return fail('Retained email history needs operator review before another delivery.', 'report_email_history_limit', 409);
    const job: ReportEmailJob = { ...owner, idempotencyKey: key, scheduleId, runId: run.id, artifactId: run.result!.id,
      preferenceVersion: getPreference(scheduleId)?.version ?? 0, savedOutputHash: reportEmailSavedOutputHash(run), payloadHash: null,
      createdAt: stamp, runCreatedAt: iso(run.createdAt), completedAt: iso(run.result!.createdAt), updatedAt: stamp, firstAttemptAt: null,
      nextAttemptAt: stamp, attempts: 0, status: 'pending', localOnly: null, providerId: null, errorCode: null,
      template: forceIntro || !recipient.introSentAt ? 'intro' : 'weekly', isTest, periodEnd: periodFor(run), timeline: [], };
    job.timeline = timeline(job, 'pending', stamp);
    db.prepare('INSERT INTO report_email_jobs VALUES (?,?,?,?,?,?)').run(key, scheduleId, run.id, job.status, stamp, JSON.stringify(job));
    return job;
  };
  return {
    now, getPreference, getJob, active,
    getRecipient(verifiedOwner: ReportEmailOwner): ReportEmailRecipient {
      const owner = copyOwner(verifiedOwner); ensureSchema();
      return transaction(() => recipientFor(owner));
    },
    resetIntro(verifiedOwner: ReportEmailOwner): ReportEmailRecipient {
      const owner = copyOwner(verifiedOwner); ensureSchema();
      return transaction(() => { const recipient = { ...recipientFor(owner), introSentAt: null, updatedAt: now() }; saveRecipient(recipient); return recipient; });
    },
    unsubscribe(token: string): boolean {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !hasTable('report_email_recipients')) return false;
      ensureSchema();
      return transaction(() => {
        const row = db.prepare('SELECT data FROM report_email_recipients WHERE unsubscribe_token=?').get(token);
        if (!row) return false;
        const recipient = JSON.parse(row.data as string) as ReportEmailRecipient, stamp = now();
        saveRecipient({ ...recipient, unsubscribedAt: recipient.unsubscribedAt ?? stamp, updatedAt: stamp });
        for (const row of db.prepare('SELECT schedule_id,data FROM report_email_preferences').all()) {
          const pref = JSON.parse(row.data as string) as ReportEmailPreference;
          if (recipientId(pref) === recipient.id && pref.enabled) db.prepare('UPDATE report_email_preferences SET data=? WHERE schedule_id=?')
            .run(JSON.stringify({ ...pref, enabled: false, enabledAt: null, version: pref.version + 1, updatedAt: stamp }), row.schedule_id);
        }
        cancelRecipient(recipient); return true;
      });
    },
    applyEvent(value: ReportEmailEvent): boolean {
      if (!value || !ID.test(value.id) || !Object.hasOwn(eventStatus, value.type) || !ID.test(value.providerId) ||
          value.recipient !== undefined && !validReportEmailRecipient(value.recipient)) return fail('Provide bounded verified email evidence.');
      const event: ReportEmailEvent = { id: value.id, type: value.type, occurredAt: iso(value.occurredAt), providerId: value.providerId,
        ...(value.recipient !== undefined ? { recipient: value.recipient } : {}) };
      if (!hasSchema()) return false;
      const matches = db.prepare("SELECT data FROM report_email_jobs WHERE json_extract(data,'$.providerId')=? LIMIT 2").all(event.providerId);
      if (matches.length !== 1) return false;
      const match = normalizeJob(JSON.parse(matches[0].data as string));
      if (match.localOnly !== false || event.recipient && event.recipient.toLowerCase() !== match.recipient.toLowerCase()) return false;
      ensureSchema();
      return transaction(() => {
        const previous = db.prepare('SELECT data FROM report_email_events WHERE event_id=?').get(event.id);
        if (previous && canonical(JSON.parse(previous.data as string)) !== canonical(event)) return fail('Email evidence ID already belongs to another event.', 'report_email_event_conflict', 409);
        if (!previous) {
          if (Number(db.prepare('SELECT count(*) AS n FROM report_email_events').get()!.n) >= 100_000) return fail('Retained email evidence needs operator review.', 'report_email_event_limit', 409);
          db.prepare('INSERT INTO report_email_events VALUES (?,?,?)').run(event.id, event.providerId, JSON.stringify(event));
        }
        return applyToJob(event);
      });
    },
    updatePreference(scheduleId: string, input: { version: number; enabled: boolean }, verifiedOwner: ReportEmailOwner): ReportEmailPreference {
      if (!ID.test(scheduleId) || !input || Object.keys(input).some(key => !['version', 'enabled'].includes(key)) ||
          !Number.isSafeInteger(input.version) || input.version < 0 || typeof input.enabled !== 'boolean') return fail('Provide an email opt-in and current version only.');
      const owner = copyOwner(verifiedOwner);
      ensureSchema();
      return transaction(() => {
        const previous = getPreference(scheduleId);
        if ((previous?.version ?? 0) !== input.version) return fail('Email preferences changed. Reload before saving.', 'report_email_version_conflict', 409);
        const recipient = recipientFor(owner);
        if (input.enabled && recipient.suppressedAt) return fail('This recipient has stopped review emails.', 'report_email_recipient_suppressed', 409);
        if (!previous && Number(db.prepare('SELECT count(*) AS n FROM report_email_preferences').get()!.n) >= maxPreferences) {
          return fail('Retained email preferences need operator review before another opt-in.', 'report_email_preference_limit', 409);
        }
        const stamp = now();
        const reconsent = input.enabled && recipient.unsubscribedAt !== null;
        if (reconsent) saveRecipient({ ...recipient, unsubscribedAt: null, updatedAt: stamp });
        const pref: ReportEmailPreference = { scheduleId, ...owner, version: input.version + 1, enabled: input.enabled,
          enabledAt: input.enabled ? previous?.enabled && sameOwner(previous, owner) && !reconsent ? previous.enabledAt : stamp : null, updatedAt: stamp };
        db.prepare('INSERT INTO report_email_preferences(schedule_id,data) VALUES (?,?) ON CONFLICT(schedule_id) DO UPDATE SET data=excluded.data')
          .run(scheduleId, JSON.stringify(pref));
        return pref;
      });
    },
    enqueue({ scheduleId, run }: { scheduleId: string; run: Run }): ReportEmailJob | null {
      if (!ID.test(scheduleId) || !ID.test(run.id)) return fail('Provide saved schedule and run references.');
      if (!hasSchema()) return null;
      ensureSchema();
      return transaction(() => {
        const pref = getPreference(scheduleId);
        const duplicate = db.prepare("SELECT data FROM report_email_jobs WHERE schedule_id=? AND run_id=? AND coalesce(json_extract(data,'$.isTest'),0)=0").all(scheduleId, run.id)
          .map(row => normalizeJob(JSON.parse(row.data as string))).find(job => pref && sameOwner(job, pref));
        if (duplicate) return duplicate;
        if (!pref?.enabled || !pref.enabledAt || !eligibleRun(run) || blocked(pref)) return null;
        const runCreatedAt = iso(run.createdAt), completedAt = iso(run.result!.createdAt);
        if (runCreatedAt < pref.enabledAt || completedAt < pref.enabledAt ||
            run.workspaceId && run.workspaceId !== pref.accessContext.workspaceId || run.actor && canonical(run.actor) !== canonical(pref.accessContext.actor)) return null;
        const stamp = now();
        if (Date.parse(stamp) - Date.parse(completedAt) >= REPORT_EMAIL_RETRY_WINDOW_MS) return null;
        const periodEnd = periodFor(run), key = 'weekly-review/' + hash([pref.accessContext.workspaceId, scheduleId, periodEnd, recipientId(pref)]);
        const indexed = db.prepare(`SELECT data FROM report_email_jobs
          WHERE schedule_id=? AND json_extract(data,'$.periodEnd')=? AND lower(json_extract(data,'$.recipient'))=?
            AND coalesce(json_extract(data,'$.isTest'),0)=0`).all(scheduleId, periodEnd, pref.recipient.toLowerCase());
        // Only pre-upgrade rows need saved-run lookup; never parse the growing new-job history.
        const existing = getJob(key) ?? indexed.map(row => normalizeJob(JSON.parse(row.data as string)))
          .find(job => recipientId(job) === recipientId(pref)) ?? db.prepare(`SELECT data FROM report_email_jobs
            WHERE schedule_id=? AND json_type(data,'$.periodEnd') IS NULL AND coalesce(json_extract(data,'$.isTest'),0)=0`).all(scheduleId)
          .map(row => normalizeJob(JSON.parse(row.data as string))).find(job => job.periodEnd === periodEnd && recipientId(job) === recipientId(pref));
        return existing ?? insertJob(scheduleId, run, copyOwner(pref), key, false);
      });
    },
    enqueueTest({ scheduleId, run, owner: provided, forceIntro, requestId }: {
      scheduleId: string; run: Run; owner?: ReportEmailOwner; forceIntro?: boolean; requestId: string;
    }): ReportEmailJob | null {
      if (!ID.test(scheduleId) || !ID.test(run.id) || !ID.test(requestId) || forceIntro !== undefined && typeof forceIntro !== 'boolean' || !eligibleRun(run)) return fail('Provide a completed saved review and a stable test request ID.');
      const owner = copyOwner(provided ?? getPreference(scheduleId)!);
      if (run.workspaceId && run.workspaceId !== owner.accessContext.workspaceId || run.actor && canonical(run.actor) !== canonical(owner.accessContext.actor)) return fail('This saved review belongs to another owner.', 'report_email_owner_required', 403);
      const pref = getPreference(scheduleId);
      if (pref && canonical(pref.accessContext) !== canonical(owner.accessContext)) return fail('This schedule belongs to another owner.', 'report_email_owner_required', 403);
      ensureSchema();
      return transaction(() => {
        const key = 'weekly-review-test/' + hash([owner.accessContext.workspaceId, owner.accessContext.actor, requestId]);
        const previous = getJob(key);
        if (previous) {
          if (previous.scheduleId !== scheduleId || previous.runId !== run.id || !sameOwner(previous, owner) ||
              forceIntro && previous.template !== 'intro') return fail('This test request ID is already bound to another email.', 'request_id_conflict', 409);
          return previous;
        }
        if (blocked(owner)) return null;
        return insertJob(scheduleId, run, owner, key, true, forceIntro);
      });
    },
    pending(limit = 25): ReportEmailJob[] {
      if (!hasSchema()) return [];
      const count = Math.max(1, Math.min(100, Math.floor(limit) || 25));
      return db.prepare("SELECT data FROM report_email_jobs WHERE status IN ('pending','sending','retry') AND next_attempt_at<=? ORDER BY next_attempt_at,rowid LIMIT ?")
        .all(now(), count).map(row => normalizeJob(JSON.parse(row.data as string)));
    },
    beginAttempt(key: string, message: ReportEmailMessage, localOnly: boolean): ReportEmailJob | null {
      if (!hasSchema()) return null;
      return transaction(() => {
        const job = getJob(key), stamp = now();
        if (!job || terminal(job.status) || job.nextAttemptAt > stamp) return null;
        if (!active(job)) { finish(key, 'cancelled', 'cancelled'); return null; }
        if (submissionExpired(job, stamp)) {
          finish(key, 'needs_attention', 'retry_expired'); return null;
        }
        if (job.attempts >= REPORT_EMAIL_MAX_ATTEMPTS) { finish(key, 'needs_attention', 'retry_limit'); return null; }
        if (!validReportEmailRecipient(message.to) || message.to !== job.recipient || typeof message.from !== 'string' || !message.from ||
            HEADER_CONTROLS.test(message.from) || (message.replyTo !== undefined && !validReportEmailRecipient(message.replyTo)) || typeof message.subject !== 'string' || !message.subject || message.subject.length > 300 ||
            HEADER_CONTROLS.test(message.subject) || typeof message.text !== 'string' || !message.text || Buffer.byteLength(message.text) > 16_000 ||
            message.html !== undefined && (typeof message.html !== 'string' || !message.html.trim() || Buffer.byteLength(message.html) > 80_000) ||
            message.headers !== undefined && !validReportEmailHeaders(message.headers)) {
          finish(key, 'needs_attention', 'payload_changed'); return null;
        }
        const payloadHash = reportEmailPayloadHash(message);
        if (job.payloadHash && (job.payloadHash !== payloadHash || job.localOnly !== localOnly)) {
          finish(key, 'needs_attention', 'payload_changed'); return null;
        }
        const claimed: ReportEmailJob = { ...job, status: 'sending', payloadHash, localOnly, attempts: job.attempts + 1,
          firstAttemptAt: job.firstAttemptAt ?? stamp, updatedAt: stamp, nextAttemptAt: new Date(Date.parse(stamp) + 60_000).toISOString(), errorCode: null,
          timeline: timeline(job, 'sending', stamp) };
        saveJob(claimed); return claimed;
      });
    },
    finish,
    retry(key: string, preparation = false, retryAfterMs?: number): void {
      const job = getJob(key); if (!job || terminal(job.status)) return;
      const stamp = now();
      if (!active(job)) return finish(key, 'cancelled', 'cancelled');
      if (submissionExpired(job, stamp)) return finish(key, 'needs_attention', 'retry_expired');
      if (job.attempts >= REPORT_EMAIL_MAX_ATTEMPTS) return finish(key, 'needs_attention', 'retry_limit');
      // Untagged historical retries conservatively count toward the preparation budget.
      const preparationFailures = job.timeline.filter(item => item.type === 'retry' && !item.id.startsWith('provider:')).length;
      if (preparation && preparationFailures + 1 >= REPORT_EMAIL_MAX_ATTEMPTS) return finish(key, 'needs_attention', 'retry_limit');
      const providerDelay = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
      const delay = Math.max(providerDelay, Math.min(60 * 60_000, 60_000 * 2 ** job.attempts));
      const nextAttemptAt = Date.parse(stamp) + delay;
      if (nextAttemptAt >= submissionDeadline(job)) return finish(key, 'needs_attention', 'retry_expired');
      saveJob({ ...job, status: 'retry', updatedAt: stamp, nextAttemptAt: new Date(nextAttemptAt).toISOString(),
        errorCode: preparation ? 'preparation_failed' : 'send_failed',
        timeline: timeline(job, 'retry', stamp, 'retry', `${preparation ? 'preparation' : 'provider'}:${job.attempts}:${job.timeline.length}:${stamp}`) });
    },
    /** Only verified provider delivery evidence may call this. API acceptance is submitted. */
    confirmDelivered(key: string, providerId: string): boolean {
      const job = getJob(key);
      if (!job || job.status !== 'submitted' || job.localOnly || job.providerId !== providerId) return false;
      ensureSchema();
      return transaction(() => applyToJob({ id: `delivery:${hash(providerId)}`, type: 'email.delivered', providerId, occurredAt: now() }));
    },
    status(scheduleId: string, options: { owner: ReportEmailOwner; configured: boolean; localOnly?: boolean }) {
      const pref = getPreference(scheduleId), owned = !!pref && sameOwner(pref, options.owner);
      const retainedJobs = hasSchema() ? Number(db.prepare('SELECT count(*) AS n FROM report_email_jobs').get()!.n) : 0;
      const deliveries = hasSchema() ? db.prepare('SELECT data FROM report_email_jobs WHERE schedule_id=? ORDER BY rowid DESC LIMIT 20').all(scheduleId)
        .map(row => {
          const job = normalizeJob(JSON.parse(row.data as string));
          return { job, public: { runId: job.runId, status: job.status, localOnly: job.localOnly, attempts: job.attempts, createdAt: job.createdAt, updatedAt: job.updatedAt,
            template: job.template, isTest: job.isTest, periodEnd: job.periodEnd, timeline: job.timeline, providerId: job.providerId,
            error: job.errorCode ? descriptions[job.errorCode] : null } };
        }).filter(item => sameOwner(item.job, options.owner)).map(item => item.public) : [];
      return { configured: options.configured, enabled: owned && pref.enabled, recipient: options.owner.recipient,
        version: pref?.version ?? 0, localOnly: options.localOnly === true, deliveries,
        retainedJobs, jobLimit: maxJobs, limitReached: retainedJobs >= maxJobs };
    },
  };
}
export type ReportEmailStore = ReturnType<typeof createReportEmailStore>;

export interface ReportEmailPreparation {
  getRun(job: ReportEmailJob): Promise<Run | undefined> | Run | undefined;
  getSchedule(job: ReportEmailJob): Promise<(ReportEmailOwner & { enabled: boolean; archivedAt: string | null }) | null>;
  /** Includes schedule/run binding and normal server admission. */
  admit(job: ReportEmailJob, run: Run): Promise<boolean>;
  hasCurrentMembership(job: ReportEmailJob): Promise<boolean>;
  hasSourcePermission(job: ReportEmailJob, run: Run): Promise<boolean>;
  compose(run: Run, job: ReportEmailJob): Promise<ReportEmailMessage | null> | ReportEmailMessage | null;
}
/** Rebuild from immutable output only after fresh access checks. null revokes a pending send. */
export function createReportEmailPrepare(callbacks: ReportEmailPreparation) {
  return async (job: ReportEmailJob): Promise<ReportEmailMessage | null> => {
    const eligible = (run: Run) => eligibleRun(run) && run.id === job.runId && run.result!.id === job.artifactId &&
      (!run.workspaceId || run.workspaceId === job.accessContext.workspaceId) &&
      (!run.actor || canonical(run.actor) === canonical(job.accessContext.actor));
    const allowed = async (run: Run) => {
      const schedule = await callbacks.getSchedule(job);
      return !!schedule && (job.isTest || schedule.enabled) && !schedule.archivedAt && sameOwner(schedule, job) &&
        await callbacks.admit(job, run) && await callbacks.hasCurrentMembership(job) && await callbacks.hasSourcePermission(job, run);
    };
    const run = await callbacks.getRun(job);
    if (!run || !eligible(run) || !await allowed(run)) return null;
    if (reportEmailSavedOutputHash(run) !== job.savedOutputHash) throw new ReportEmailPayloadChanged();
    const message = await callbacks.compose(run, job);
    // Composition may await other work; recheck permissions immediately before returning.
    if (!message) return null;
    const latest = await callbacks.getRun(job);
    if (!latest || !eligible(latest) || !await allowed(latest)) return null;
    if (reportEmailSavedOutputHash(latest) !== job.savedOutputHash) throw new ReportEmailPayloadChanged();
    return message;
  };
}
class ReportEmailPayloadChanged extends Error {}

/** One dispatcher per store/runtime. Durable sending claims recover after a one-minute lease. */
export function createReportEmailDispatcher(options: {
  store: ReportEmailStore; sender?: ReportEmailSender;
  prepare(job: ReportEmailJob): Promise<ReportEmailMessage | null>;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return fail('Provide an email timeout of at most 30 seconds.');
  let closed = false, running: Promise<void> | null = null, controller: AbortController | null = null;
  const work = async () => {
    if (!options.sender) return;
    for (const job of options.store.pending()) {
      if (closed) break;
      if (!options.store.active(job)) { options.store.finish(job.idempotencyKey, 'cancelled', 'cancelled'); continue; }
      if (submissionExpired(job, options.store.now())) {
        options.store.finish(job.idempotencyKey, 'needs_attention', 'retry_expired'); continue;
      }
      let message: ReportEmailMessage | null;
      try { message = await options.prepare(job); }
      catch (error) {
        if (error instanceof ReportEmailPayloadChanged) options.store.finish(job.idempotencyKey, 'needs_attention', 'payload_changed');
        else options.store.retry(job.idempotencyKey, true);
        continue;
      }
      if (closed) break;
      if (!message) { options.store.finish(job.idempotencyKey, 'cancelled', 'cancelled'); continue; }
      const claimed = options.store.beginAttempt(job.idempotencyKey, message, options.sender.localOnly === true);
      if (!claimed) continue;
      controller = new AbortController();
      const activeController = controller;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          options.sender.send(message, { idempotencyKey: claimed.idempotencyKey, signal: activeController.signal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { activeController.abort(); reject(new Error('Email submission timed out.')); }, timeoutMs);
            activeController.signal.addEventListener('abort', () => reject(new Error('Email submission stopped.')), { once: true });
          }),
        ]);
        if (!result || typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(result.id)) throw new Error('Invalid submission receipt.');
        options.store.finish(claimed.idempotencyKey, options.sender.localOnly ? 'captured' : 'submitted', null, result.id);
      } catch (error) {
        if (error && typeof error === 'object' && 'retryable' in error && error.retryable === false) options.store.finish(claimed.idempotencyKey, 'needs_attention', 'send_rejected');
        else options.store.retry(claimed.idempotencyKey, false,
          error && typeof error === 'object' && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number' ? error.retryAfterMs : undefined);
      }
      finally { clearTimeout(timer); controller = null; }
    }
  };
  return {
    tick(): Promise<void> {
      if (closed) return Promise.resolve();
      if (!running) running = work().finally(() => { running = null; });
      return running;
    },
    async close(): Promise<void> { closed = true; controller?.abort(); await running; },
  };
}

/** Explicit local QA only. Bounded in-memory capture; no external I/O or durable bodies. */
export function createReportEmailCaptureSender(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('Provide a bounded local email capture limit.');
  const captures = new Map<string, { id: string; message: ReportEmailMessage }>();
  return {
    localOnly: true as const,
    async send(message: ReportEmailMessage, options: { idempotencyKey: string; signal: AbortSignal }) {
      if (options.signal.aborted) throw new Error('Local capture stopped.');
      const previous = captures.get(options.idempotencyKey);
      if (previous) {
        if (reportEmailPayloadHash(previous.message) !== reportEmailPayloadHash(message)) throw new Error('Local capture payload changed.');
        return { id: previous.id };
      }
      if (captures.size >= limit) throw new Error('Local capture limit reached.');
      const id = 'capture-' + hash(options.idempotencyKey);
      captures.set(options.idempotencyKey, { id, message: structuredClone(message) }); return { id };
    },
    captures() { return [...captures].map(([idempotencyKey, capture]) => ({ idempotencyKey, ...capture, message: structuredClone(capture.message) })); },
  };
}
