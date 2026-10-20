import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validateSourceIds } from './source-scope.ts';
import { CONNECTION_ID } from './connections.ts';
import { HarnessError } from './errors.ts';
import type { RunAccessContext } from './types.ts';
import { Temporal } from '@js-temporal/polyfill';

export const DEFAULT_SCHEDULE_SIGN_OFF = 'The Rivet team';

export interface WorkflowScheduleInput {
  name: string;
  workflowId: string;
  workflowVersion: number;
  sourceIds: string[];
  /** Connections whose latest synced version is resolved once per attempt (0–5, unique). */
  connectionIds?: string[];
  /** Ask for a pre-sync before the run. Absent means no refresh. */
  refreshBeforeRun?: boolean;
  frequency: 'daily' | 'weekly';
  time: string;
  weekday?: number;
  /** IANA timezone; time remains a local wall-clock time. Existing UTC settings stay UTC. */
  timezone: string;
  /** Absent means DEFAULT_SCHEDULE_SIGN_OFF; defaults are omitted from stored hashes. */
  signOff?: string;
  enabled: boolean;
}
export interface WorkflowSchedule extends WorkflowScheduleInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastAttempt: { id: string; scheduledFor: string; status: ScheduleAttempt['status']; runId?: string; errorCode?: string } | null;
  archivedAt: string | null;
}
/** What one attempt actually used: recorded once, then reused by every retry. */
export interface SchedulePin {
  presync: { status: 'skipped' | 'completed' | 'partial' | 'failed'; connections: { connectionId: string; attemptId: string; status: string }[] };
  resolvedSources: { connectionId: string; sourceId: string; datasetId: string; observedAt: string }[];
  /** Weekly reviews retain every chosen connection, including those without usable data. */
  missingConnectionIds?: string[];
}
export interface ScheduleAttempt {
  id: string;
  scheduleId: string;
  requestId: string;
  scheduledFor: string;
  claimedAt: string;
  finishedAt: string | null;
  status: 'pending' | 'started' | 'failed';
  runId?: string;
  errorCode?: string;
  /** Exact configuration claimed before admission; never a fresh global source pool. */
  schedule: WorkflowSchedule;
  /** Resolved connection versions, written once so retries cannot re-resolve or re-sync. */
  pin?: SchedulePin;
  /** Server supplied identity only; API responses must not return this field. */
  accessContext: RunAccessContext | null;
}
type StoredSchedule = { schedule: WorkflowSchedule; accessContext: RunAccessContext | null };
export type ScheduleCreateInput = WorkflowScheduleInput & { requestId: string };
export type ScheduleUpdateInput = WorkflowScheduleInput & { version: number };
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/;
const fail = (message: string, status = 400, code = 'invalid_schedule'): never => { throw new HarnessError(message, status, code); };
const iso = (value: string | Date) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return fail('Provide a valid schedule timestamp.');
  return date.toISOString();
};

export function validateScheduleConnectionIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5 || value.some(id => typeof id !== 'string' || !CONNECTION_ID.test(id)) || new Set(value).size !== value.length) {
    return fail('Choose up to 5 different connections for this schedule.', 400, 'invalid_connection_ids');
  }
  return [...value].sort();
}

export function validateScheduleInput(input: unknown, update = false): ScheduleCreateInput | ScheduleUpdateInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Provide a schedule configuration.');
  const value = input as Record<string, unknown>;
  const allowed = ['name', 'workflowId', 'workflowVersion', 'sourceIds', 'connectionIds', 'refreshBeforeRun', 'frequency', 'time', 'weekday', 'timezone', 'signOff', 'enabled', update ? 'version' : 'requestId'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return fail('Schedules accept a saved workflow, selected files or connections, a daily or weekly local time, a named timezone and an optional sign-off.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160) return fail('Name the schedule using 1–160 characters.');
  if (typeof value.workflowId !== 'string' || !ID.test(value.workflowId) || !Number.isSafeInteger(value.workflowVersion) || (value.workflowVersion as number) < 1) return fail('Choose a saved workflow version.');
  if (!Array.isArray(value.sourceIds)) return fail('Choose the exact files for this schedule.');
  const sourceIds = validateSourceIds(value.sourceIds);
  const connectionIds = validateScheduleConnectionIds(value.connectionIds);
  if (value.refreshBeforeRun !== undefined && typeof value.refreshBeforeRun !== 'boolean') return fail('Choose whether this schedule refreshes its connections before running.');
  if (value.frequency !== 'daily' && value.frequency !== 'weekly') return fail('Choose daily or weekly.');
  if (typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return fail('Choose a valid local time.');
  const timezone = scheduleTimezone(value.timezone);
  if (value.signOff !== undefined && (typeof value.signOff !== 'string' || value.signOff.trim().length > 80 ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value.signOff))) return fail('Use a single-line sign-off of at most 80 characters.');
  const signOff = (value.signOff as string | undefined)?.trim() || DEFAULT_SCHEDULE_SIGN_OFF;
  if (value.frequency === 'weekly' ? !Number.isInteger(value.weekday) || (value.weekday as number) < 0 || (value.weekday as number) > 6 : value.weekday !== undefined) return fail('Weekly schedules require a weekday from 0 (Sunday) to 6 (Saturday).');
  if (typeof value.enabled !== 'boolean') return fail('Choose whether the schedule is enabled.');
  if (update ? !Number.isSafeInteger(value.version) || (value.version as number) < 1 : typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)) return fail(update ? 'Provide the current schedule version.' : 'Provide a stable creation request ID.');
  // Defaults are omitted, so an existing schedule keeps its exact saved configuration hash.
  return { name: value.name.trim(), workflowId: value.workflowId, workflowVersion: value.workflowVersion as number, sourceIds,
    ...(connectionIds.length ? { connectionIds } : {}), ...(value.refreshBeforeRun ? { refreshBeforeRun: true } : {}), frequency: value.frequency, time: value.time, ...(value.frequency === 'weekly' ? { weekday: value.weekday as number } : {}), timezone,
    ...(signOff !== DEFAULT_SCHEDULE_SIGN_OFF ? { signOff } : {}), enabled: value.enabled, ...(update ? { version: value.version as number } : { requestId: value.requestId as string }) } as ScheduleCreateInput | ScheduleUpdateInput;
}

export function validateSchedulePin(input: unknown): SchedulePin {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['presync', 'resolvedSources', 'missingConnectionIds'].includes(key))) return fail('Record the pre-sync outcome and the resolved data versions for this start.', 400, 'invalid_schedule_pin');
  const value = input as SchedulePin;
  const presync = value.presync;
  if (!presync || typeof presync !== 'object' || Array.isArray(presync) || Object.keys(presync).length !== 2 ||
      !['skipped', 'completed', 'partial', 'failed'].includes(presync.status) || !Array.isArray(presync.connections) || presync.connections.length > 5) {
    return fail('Record the pre-sync outcome for this start.', 400, 'invalid_schedule_pin');
  }
  const bounded = (item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 200 && !/[\u0000-\u001f\u007f]/.test(item);
  const connections = presync.connections.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3 ||
        !CONNECTION_ID.test(item.connectionId) || !bounded(item.attemptId) || !bounded(item.status)) return fail('Record each pre-sync attempt exactly once.', 400, 'invalid_schedule_pin');
    return { connectionId: item.connectionId, attemptId: item.attemptId, status: item.status };
  });
  if (!Array.isArray(value.resolvedSources) || value.resolvedSources.length > 5) return fail('Record the resolved data versions for this start.', 400, 'invalid_schedule_pin');
  const resolvedSources = value.resolvedSources.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 4 ||
        !CONNECTION_ID.test(item.connectionId) || !bounded(item.sourceId) || !bounded(item.datasetId) || !bounded(item.observedAt) ||
        !Number.isFinite(new Date(item.observedAt).getTime())) {
      return fail('Record the resolved data versions for this start.', 400, 'invalid_schedule_pin');
    }
    return { connectionId: item.connectionId, sourceId: item.sourceId, datasetId: item.datasetId, observedAt: new Date(item.observedAt).toISOString() };
  });
  if (new Set(resolvedSources.map(item => item.connectionId)).size !== resolvedSources.length ||
      new Set(connections.map(item => item.connectionId)).size !== connections.length) return fail('A connection resolves to one data version per start.', 400, 'invalid_schedule_pin');
  const missingConnectionIds = value.missingConnectionIds === undefined ? undefined : validateScheduleConnectionIds(value.missingConnectionIds);
  if (missingConnectionIds?.some(id => resolvedSources.some(source => source.connectionId === id))) return fail('A missing connection cannot also have resolved data.', 400, 'invalid_schedule_pin');
  return { presync: { status: presync.status, connections }, resolvedSources, ...(missingConnectionIds !== undefined ? { missingConnectionIds } : {}) };
}

function scheduleTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(value)) return fail('Choose a valid named timezone.');
  try { Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value); }
  catch { return fail('Choose a supported IANA timezone.'); }
  return value;
}

/** Strictly future local occurrence. DST gaps shift forward by the gap; overlaps
 * use the earlier occurrence once. Omitted timezone preserves legacy UTC callers. */
export function nextScheduleTime(schedule: Pick<WorkflowScheduleInput, 'frequency' | 'time' | 'weekday'> & Partial<Pick<WorkflowScheduleInput, 'timezone'>>, after: string | Date): string {
  const timezone = scheduleTimezone(schedule.timezone ?? 'UTC');
  const current = Temporal.Instant.from(iso(after));
  const localDate = current.toZonedDateTimeISO(timezone).toPlainDate();
  const [hour, minute] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const date = localDate.add({ days: offset });
    if (schedule.frequency === 'weekly' && date.dayOfWeek % 7 !== schedule.weekday) continue;
    const next = Temporal.ZonedDateTime.from({ timeZone: timezone, year: date.year, month: date.month, day: date.day, hour, minute }, { disambiguation: 'compatible' }).toInstant();
    if (Temporal.Instant.compare(next, current) > 0) return new Date(next.epochMilliseconds).toISOString();
  }
  return fail('Could not find the next schedule time.');
}
function copyAccess(access: RunAccessContext | null): RunAccessContext | null {
  if (access === null) return null;
  if (!access || typeof access.workspaceId !== 'string' || !access.workspaceId || typeof access.actor?.issuer !== 'string' || !access.actor.issuer || typeof access.actor.subject !== 'string' || !access.actor.subject) return fail('A server-verified schedule owner is required.');
  return { workspaceId: access.workspaceId, actor: { issuer: access.actor.issuer, subject: access.actor.subject } };
}

/** Persistence only. Caller enforces role, current membership, workflow/source validity,
 * normal model admission, and single-flight dispatch before each start. */
export function createWorkflowScheduleStore(db: DatabaseSync, options: { now?: () => string } = {}) {
  const now = () => iso(options.now?.() ?? new Date());
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_schedules (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, configuration_hash TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workflow_schedule_attempts (
    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES workflow_schedules(id),
    request_id TEXT NOT NULL UNIQUE, scheduled_for TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
    UNIQUE(schedule_id, scheduled_for)
  );`);
  const transaction = <T>(action: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const stored = (id: string): StoredSchedule | undefined => {
    const row = db.prepare('SELECT data FROM workflow_schedules WHERE id=?').get(id);
    return row ? JSON.parse(row.data as string) : undefined;
  };
  const save = (entry: StoredSchedule) => db.prepare('UPDATE workflow_schedules SET data=? WHERE id=?').run(JSON.stringify(entry), entry.schedule.id);
  const requireSchedule = (id: string) => {
    const entry = stored(id);
    if (!entry || entry.schedule.archivedAt) return fail('Schedule not found.', 404, 'schedule_not_found');
    return entry;
  };
  const pending = (id: string): ScheduleAttempt | undefined => {
    const row = db.prepare("SELECT data FROM workflow_schedule_attempts WHERE schedule_id=? AND status='pending' ORDER BY scheduled_for LIMIT 1").get(id);
    return row ? JSON.parse(row.data as string) : undefined;
  };
  const requireSettled = (id: string) => { if (pending(id)) fail('A scheduled start needs confirmation before changing this schedule.', 409, 'schedule_attempt_pending'); };
  const list = (): WorkflowSchedule[] => db.prepare('SELECT data FROM workflow_schedules ORDER BY rowid DESC').all().map(row => (JSON.parse(row.data as string) as StoredSchedule).schedule).filter(schedule => !schedule.archivedAt);
  return {
    list,
    get(id: string): WorkflowSchedule | undefined { const entry = stored(id); return entry?.schedule.archivedAt ? undefined : entry?.schedule; },
    getAccessContext(id: string): RunAccessContext | null { return requireSchedule(id).accessContext; },
    create(input: unknown, accessContext: RunAccessContext | null = null): WorkflowSchedule {
      const { requestId, ...config } = validateScheduleInput(input) as ScheduleCreateInput;
      const access = copyAccess(accessContext);
      const fingerprint = createHash('sha256').update(JSON.stringify({ config, access })).digest('hex');
      return transaction(() => {
        const previous = db.prepare('SELECT configuration_hash,data FROM workflow_schedules WHERE request_id=?').get(requestId);
        if (previous) {
          if (previous.configuration_hash !== fingerprint) return fail('That request ID already belongs to another schedule configuration.', 409, 'request_id_conflict');
          const result = (JSON.parse(previous.data as string) as StoredSchedule).schedule;
          if (result.archivedAt) return fail('That schedule was archived. Use a new request ID to create another.', 409, 'schedule_archived');
          return result;
        }
        if (list().length >= 25 || (db.prepare('SELECT count(*) AS n FROM workflow_schedules').get()!.n as number) >= 1000) return fail('The workspace schedule limit has been reached.', 409, 'schedule_limit');
        const stamp = now();
        const schedule: WorkflowSchedule = { ...config, id: randomUUID(), version: 1, createdAt: stamp, updatedAt: stamp, nextRunAt: config.enabled ? nextScheduleTime(config, stamp) : null, lastAttempt: null, archivedAt: null };
        db.prepare('INSERT INTO workflow_schedules(id,request_id,configuration_hash,data) VALUES (?,?,?,?)').run(schedule.id, requestId, fingerprint, JSON.stringify({ schedule, accessContext: access }));
        return schedule;
      });
    },
    update(id: string, input: unknown, accessContext?: RunAccessContext | null): WorkflowSchedule {
      const { version, ...config } = validateScheduleInput(input, true) as ScheduleUpdateInput;
      const access = accessContext === undefined ? undefined : copyAccess(accessContext);
      return transaction(() => {
        const entry = requireSchedule(id);
        if (entry.schedule.version !== version) return fail('This schedule changed. Reload before saving.', 409, 'schedule_version_conflict');
        requireSettled(id);
        const stamp = now();
        const next: WorkflowSchedule = { ...entry.schedule, ...config, version: version + 1, updatedAt: stamp, nextRunAt: config.enabled ? nextScheduleTime(config, stamp) : null };
        if (!config.connectionIds?.length) delete next.connectionIds;
        if (!config.refreshBeforeRun) delete next.refreshBeforeRun;
        if (!config.signOff) delete next.signOff;
        entry.schedule = next;
        if (access !== undefined) entry.accessContext = access;
        save(entry); return entry.schedule;
      });
    },
    remove(id: string, version: number): WorkflowSchedule {
      return transaction(() => {
        const entry = requireSchedule(id);
        if (entry.schedule.version !== version) return fail('This schedule changed. Reload before archiving.', 409, 'schedule_version_conflict');
        requireSettled(id);
        const stamp = now();
        entry.schedule = { ...entry.schedule, enabled: false, nextRunAt: null, archivedAt: stamp, updatedAt: stamp, version: version + 1 };
        save(entry); return entry.schedule;
      });
    },
    due(at = now()): WorkflowSchedule[] {
      const stamp = iso(at);
      return list().filter(s => s.enabled && s.nextRunAt && s.nextRunAt <= stamp).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
    },
    claim(id: string, at = now()): ScheduleAttempt | null {
      const stamp = iso(at);
      return transaction(() => {
        const entry = requireSchedule(id);
        const existing = pending(id);
        if (existing) return existing;
        const s = entry.schedule;
        if (!s.enabled || !s.nextRunAt || s.nextRunAt > stamp) return null;
        if ((db.prepare('SELECT count(*) AS n FROM workflow_schedule_attempts').get()!.n as number) >= 10000) return fail('Retained schedule history needs operator review before another start.', 409, 'schedule_history_limit');
        const requestId = 'schedule-' + createHash('sha256').update(`${id}:${s.version}:${s.nextRunAt}`).digest('hex');
        const attempt: ScheduleAttempt = { id: randomUUID(), scheduleId: id, requestId, scheduledFor: s.nextRunAt, claimedAt: stamp, finishedAt: null, status: 'pending', schedule: s, accessContext: entry.accessContext };
        db.prepare('INSERT INTO workflow_schedule_attempts(id,schedule_id,request_id,scheduled_for,status,data) VALUES (?,?,?,?,?,?)').run(attempt.id, id, requestId, attempt.scheduledFor, attempt.status, JSON.stringify(attempt));
        entry.schedule = { ...entry.schedule, lastAttempt: { id: attempt.id, scheduledFor: attempt.scheduledFor, status: 'pending' } };
        save(entry);
        return attempt;
      });
    },
    /** Written once. A different pin for the same attempt is a conflict, never an overwrite. */
    pin(attemptId: string, pin: SchedulePin): SchedulePin {
      const value = validateSchedulePin(pin);
      return transaction(() => {
        const row = db.prepare('SELECT data FROM workflow_schedule_attempts WHERE id=?').get(attemptId);
        if (!row) return fail('Schedule attempt not found.', 404, 'schedule_attempt_not_found');
        const attempt = JSON.parse(row.data as string) as ScheduleAttempt;
        if (attempt.pin) {
          if (JSON.stringify(attempt.pin) !== JSON.stringify(value)) return fail('This scheduled start already recorded the data version it uses.', 409, 'schedule_pin_conflict');
          return attempt.pin;
        }
        db.prepare('UPDATE workflow_schedule_attempts SET data=? WHERE id=?').run(JSON.stringify({ ...attempt, pin: value }), attemptId);
        return value;
      });
    },
    finish(attemptId: string, outcome: { runId: string } | { errorCode: string }, at = now()): ScheduleAttempt {
      const stamp = iso(at);
      if (!outcome || Object.keys(outcome).length !== 1 || ('runId' in outcome ? typeof outcome.runId !== 'string' || !ID.test(outcome.runId) : !('errorCode' in outcome) || typeof outcome.errorCode !== 'string' || !/^[a-z0-9_]{1,80}$/.test(outcome.errorCode))) return fail('Record a run ID or a bounded error code for this scheduled start.');
      return transaction(() => {
        const row = db.prepare('SELECT data FROM workflow_schedule_attempts WHERE id=?').get(attemptId);
        if (!row) return fail('Schedule attempt not found.', 404, 'schedule_attempt_not_found');
        const previous = JSON.parse(row.data as string) as ScheduleAttempt;
        if (previous.status !== 'pending') {
          if ('runId' in outcome ? previous.runId === outcome.runId : previous.errorCode === outcome.errorCode) return previous;
          return fail('This scheduled start already has a recorded outcome.', 409, 'schedule_attempt_conflict');
        }
        const attempt: ScheduleAttempt = { ...previous, ...outcome, status: 'runId' in outcome ? 'started' : 'failed', finishedAt: stamp };
        db.prepare('UPDATE workflow_schedule_attempts SET status=?,data=? WHERE id=?').run(attempt.status, JSON.stringify(attempt), attemptId);
        const entry = requireSchedule(attempt.scheduleId);
        entry.schedule = { ...entry.schedule, nextRunAt: entry.schedule.enabled ? nextScheduleTime(entry.schedule, stamp > attempt.scheduledFor ? stamp : attempt.scheduledFor) : null, lastAttempt: { id: attempt.id, scheduledFor: attempt.scheduledFor, status: attempt.status, ...outcome } };
        save(entry); return attempt;
      });
    },
    /** The attempt that started a run, found by the run's stable request ID; never its access context. */
    attemptForRequest(requestId: string): Omit<ScheduleAttempt, 'accessContext'> | undefined {
      if (typeof requestId !== 'string' || !/^schedule-[a-f0-9]{64}$/.test(requestId)) return undefined;
      const row = db.prepare('SELECT data FROM workflow_schedule_attempts WHERE request_id=?').get(requestId);
      if (!row) return undefined;
      const { accessContext: _access, ...attempt } = JSON.parse(row.data as string) as ScheduleAttempt;
      return attempt;
    },
    attempts(id: string): Omit<ScheduleAttempt, 'accessContext'>[] {
      return db.prepare('SELECT data FROM workflow_schedule_attempts WHERE schedule_id=? ORDER BY scheduled_for DESC LIMIT 100').all(id).map(row => {
        const { accessContext: _access, ...attempt } = JSON.parse(row.data as string) as ScheduleAttempt; return attempt;
      });
    },
  };
}
