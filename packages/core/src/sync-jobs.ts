import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CONNECTION_ID, type Connection } from './connections.ts';
import { HarnessError } from './errors.ts';
import { nextScheduleTime } from './workflow-schedules.ts';
import { Temporal } from '@js-temporal/polyfill';

export type SyncFrequency = 'daily' | 'weekly' | 'manual';
export type SyncTrigger = 'schedule' | 'manual' | 'presync' | 'connect';
export type SyncAttemptStatus = 'pending' | 'started' | 'completed' | 'unchanged' | 'failed' | 'interrupted';
export interface SyncScheduleInput {
  frequency: SyncFrequency; timeUtc: string; weekday?: number; enabled: boolean;
  /** Optional wall-clock schedule. Older jobs keep their fixed UTC behavior. */
  localTime?: string; timezone?: string;
}
export interface SyncJob extends SyncScheduleInput {
  id: string;
  connectionId: string;
  version: number;
  /** The next slot, strictly in the future when saved; null for manual or disabled jobs. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set when a disconnect stopped an enabled job, so a reconnect restores it (M8); a job paused by its owner stays paused. */
  pausedByDisconnect?: true;
}
/** One acquired file. `key` and `mapping` stay server-side; the API returns name, hash and counts. */
export interface SyncAttemptFile {
  key: string;
  name: string;
  contentHash: string;
  bytes: number;
  /** When the provider data was acquired; reused unchanged by boot recovery. */
  observedAt: string;
  mapping: Record<string, unknown>;
  /**
   * `json`: the provider's JSON is kept raw under `key` and its derived CSV imported under `<key>-t` (M8). `social`: a
   * page of public posts imported through the social path with `key` as its request ID (M9); `mapping` then holds the
   * page's platform, account, dataset, offset and coverage.
   */
  format?: 'json' | 'social';
}
export interface SyncAttempt {
  id: string;
  jobId: string;
  connectionId: string;
  scheduledFor: string;
  attempt: number;
  trigger: SyncTrigger;
  status: SyncAttemptStatus;
  idempotencyKey: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  versionIds: string[];
  files: SyncAttemptFile[];
  errorCode?: string;
  message?: string;
  bytes?: number;
  records?: number;
}
/**
 * One row of `GET /api/connections` (never the stored owner identity): the connection, its sync job,
 * the latest usable version ("Data as of"), an attempt still pending or running, and the stored plain
 * message of a failed last attempt. All read from saved records; nothing here is estimated.
 */
export interface ConnectionListEntry extends Omit<Connection, 'owner'> {
  job: SyncJob | null;
  latestVersion: { observedAt: string; sourceId: string } | null;
  activeAttempt: { id: string; status: 'pending' | 'started'; trigger: SyncTrigger; createdAt: string } | null;
  lastFailure: { errorCode: string; message: string } | null;
  /** Only for providers that need an account sign-in (M7): whether one is saved. Never the credential. */
  signedIn?: boolean;
  /** Only for providers that need an API token (M9): whether this connection's sealed token is saved. Never the token. */
  tokenConfigured?: boolean;
  /** "Sync now" is available again at this time (provider rate limits, M8); absent when it is available now. */
  syncAvailableAt?: string;
}
export interface SyncAttemptOutcome {
  status: 'completed' | 'unchanged' | 'failed';
  versionIds?: string[];
  errorCode?: string;
  message?: string;
  bytes?: number;
  records?: number;
}

export const SYNC_JOB_ID = /^sjob_[0-9a-f]{24}$/;
export const SYNC_ATTEMPT_ID = /^satt_[0-9a-f]{24}$/;
/** The data-layer key format (C4): no colons, 8–128 characters. */
export const SYNC_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const TERMINAL: readonly SyncAttemptStatus[] = ['completed', 'unchanged', 'failed', 'interrupted'];
const TRIGGERS: readonly SyncTrigger[] = ['schedule', 'manual', 'presync', 'connect'];
/** Attempt history is retained (N-1); past this an operator reviews it before more syncs. */
const HISTORY_LIMIT = 100_000;

const fail = (message: string, status = 400, code = 'invalid_sync_job'): never => { throw new HarnessError(message, status, code); };
const iso = (value: string | Date) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return fail('Provide a valid sync timestamp.');
  return date.toISOString();
};
const hex = () => randomBytes(12).toString('hex');

/** `sync-` + 40 hex characters: regex-safe (C4), and a retry's new attempt number gives a new key. */
export function syncAttemptKey(jobId: string, scheduledFor: string, attempt: number): string {
  return 'sync-' + createHash('sha256').update(`${jobId}:${scheduledFor}:${attempt}`).digest('hex').slice(0, 40);
}

/** Exact keys only. `manual` jobs never run on a clock; `weekday` is required for weekly jobs only. */
export function validateSyncSchedule(input: unknown): SyncScheduleInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Provide a sync schedule.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['frequency', 'timeUtc', 'weekday', 'enabled', 'localTime', 'timezone'].includes(key))) return fail('A sync schedule has a frequency, a UTC time, an optional weekday and whether it is enabled. Local schedules also have a time and timezone.');
  if (!['daily', 'weekly', 'manual'].includes(value.frequency as string)) return fail('Choose a daily, weekly or manual sync.');
  if (typeof value.timeUtc !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.timeUtc)) return fail('Choose a valid UTC time such as 06:00.');
  if (value.frequency === 'weekly' ? !Number.isInteger(value.weekday) || (value.weekday as number) < 0 || (value.weekday as number) > 6 : value.weekday !== undefined) {
    return fail('Weekly syncs require a weekday from 0 (Sunday) to 6 (Saturday).');
  }
  if (typeof value.enabled !== 'boolean') return fail('Choose whether scheduled syncs are enabled.');
  const local = value.localTime !== undefined || value.timezone !== undefined;
  if (local) {
    if (typeof value.localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.localTime) ||
        typeof value.timezone !== 'string' || value.timezone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(value.timezone)) return fail('Choose a valid local time and named timezone.');
    try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); } catch { return fail('Choose a supported timezone.'); }
  }
  return { frequency: value.frequency as SyncFrequency, timeUtc: value.timeUtc, ...(value.frequency === 'weekly' ? { weekday: value.weekday as number } : {}), enabled: value.enabled,
    ...(local ? { localTime: value.localTime as string, timezone: value.timezone as string } : {}) };
}

export function nextSyncTime(schedule: SyncScheduleInput, after: string): string | null {
  if (!schedule.enabled || schedule.frequency === 'manual') return null;
  if (!schedule.timezone || !schedule.localTime) return nextScheduleTime({ frequency: schedule.frequency, time: schedule.timeUtc, weekday: schedule.weekday }, after);
  const instant = Temporal.Instant.from(after);
  const localDate = instant.toZonedDateTimeISO(schedule.timezone).toPlainDate();
  const [hour, minute] = schedule.localTime.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const date = localDate.add({ days: offset });
    if (schedule.frequency === 'weekly' && date.dayOfWeek % 7 !== schedule.weekday) continue;
    // Spring gaps move forward; autumn overlaps use the first occurrence, once.
    const slot = Temporal.ZonedDateTime.from({ timeZone: schedule.timezone, year: date.year, month: date.month, day: date.day, hour, minute }, { disambiguation: 'compatible' }).toInstant();
    if (Temporal.Instant.compare(slot, instant) > 0) return new Date(slot.epochMilliseconds).toISOString();
  }
  return fail('Could not find the next sync time.');
}
const nextSlot = nextSyncTime;

type Row = Record<string, unknown>;
type StoredAttempt = Omit<SyncAttempt, 'id' | 'jobId' | 'connectionId' | 'scheduledFor' | 'attempt' | 'trigger' | 'status' | 'idempotencyKey'>;

/**
 * Persistence only, in `harness.sqlite` beside the connection registry. The caller enforces
 * roles, membership, provider access and the one-sync-at-a-time rule. No credential or payload
 * is stored here: a file entry carries its hash, size, idempotency key and column mapping.
 */
export function createSyncJobStore(db: DatabaseSync, options: { now?: () => string } = {}) {
  const now = () => iso(options.now?.() ?? new Date());
  db.exec(`CREATE TABLE IF NOT EXISTS sync_jobs (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL UNIQUE REFERENCES connections(id),
    version INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_job_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES sync_jobs(id),
    scheduled_for TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    UNIQUE (job_id, scheduled_for, attempt)
  );`);
  const transaction = <T>(action: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const parseJob = (row: Row): SyncJob => ({ ...JSON.parse(row.data as string), id: row.id as string, connectionId: row.connection_id as string, version: row.version as number });
  const jobRow = (id: string) => db.prepare('SELECT * FROM sync_jobs WHERE id=?').get(id) as Row | undefined;
  const writeJob = (job: SyncJob) => {
    const { id: _id, connectionId: _connection, version: _version, ...data } = job;
    db.prepare('UPDATE sync_jobs SET version=?,data=? WHERE id=?').run(job.version, JSON.stringify(data), job.id);
    return job;
  };
  const parseAttempt = (row: Row): SyncAttempt => {
    const data = JSON.parse(row.data as string) as StoredAttempt;
    const job = jobRow(row.job_id as string);
    return {
      id: row.id as string, jobId: row.job_id as string, connectionId: job?.connection_id as string,
      scheduledFor: row.scheduled_for as string, attempt: row.attempt as number, trigger: row.trigger as SyncTrigger,
      status: row.status as SyncAttemptStatus, idempotencyKey: row.idempotency_key as string, ...data,
    };
  };
  const attemptRow = (id: string) => db.prepare('SELECT * FROM sync_job_attempts WHERE id=?').get(id) as Row | undefined;
  const writeAttempt = (attempt: SyncAttempt) => {
    const { id, jobId: _job, connectionId: _connection, scheduledFor: _slot, attempt: _number, trigger: _trigger, status, idempotencyKey: _key, ...data } = attempt;
    db.prepare('UPDATE sync_job_attempts SET status=?,data=? WHERE id=?').run(status, JSON.stringify(data), id);
    return attempt;
  };
  const insertAttempt = (jobId: string, scheduledFor: string, number: number, trigger: SyncTrigger): SyncAttempt => {
    if ((db.prepare('SELECT count(*) AS n FROM sync_job_attempts').get()!.n as number) >= HISTORY_LIMIT) {
      return fail('Retained sync history needs operator review before another sync.', 409, 'sync_history_limit');
    }
    const id = `satt_${hex()}`;
    const idempotencyKey = syncAttemptKey(jobId, scheduledFor, number);
    const data: StoredAttempt = { createdAt: now(), versionIds: [], files: [] };
    db.prepare('INSERT INTO sync_job_attempts(id,job_id,scheduled_for,attempt,trigger,status,idempotency_key,data) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, jobId, scheduledFor, number, trigger, 'pending', idempotencyKey, JSON.stringify(data));
    return parseAttempt(attemptRow(id)!);
  };
  const activeFor = (jobId: string): SyncAttempt | undefined => {
    const row = db.prepare("SELECT * FROM sync_job_attempts WHERE job_id=? AND status IN ('pending','started') ORDER BY rowid LIMIT 1").get(jobId) as Row | undefined;
    return row ? parseAttempt(row) : undefined;
  };
  const requireAttempt = (id: string) => {
    const row = typeof id === 'string' && SYNC_ATTEMPT_ID.test(id) ? attemptRow(id) : undefined;
    return row ? parseAttempt(row) : fail('Sync attempt not found.', 404, 'sync_attempt_not_found');
  };
  return {
    get(id: string): SyncJob | undefined { const row = typeof id === 'string' && SYNC_JOB_ID.test(id) ? jobRow(id) : undefined; return row ? parseJob(row) : undefined; },
    forConnection(connectionId: string): SyncJob | undefined {
      if (typeof connectionId !== 'string' || !CONNECTION_ID.test(connectionId)) return undefined;
      const row = db.prepare('SELECT * FROM sync_jobs WHERE connection_id=?').get(connectionId) as Row | undefined;
      return row ? parseJob(row) : undefined;
    },
    /** One job per connection. A reconnect keeps the existing job and applies the new schedule. */
    ensure(connectionId: string, schedule: SyncScheduleInput = { frequency: 'manual', timeUtc: '00:00', enabled: true }): SyncJob {
      if (typeof connectionId !== 'string' || !CONNECTION_ID.test(connectionId)) return fail('Choose a connection for this sync job.');
      const value = validateSyncSchedule(schedule);
      return transaction(() => {
        const stamp = now();
        const row = db.prepare('SELECT * FROM sync_jobs WHERE connection_id=?').get(connectionId) as Row | undefined;
        if (row) {
          const saved = parseJob(row);
          const next: SyncJob = { ...saved, ...value, version: saved.version + 1, updatedAt: stamp, nextRunAt: nextSlot(value, stamp) };
          if (value.weekday === undefined) delete next.weekday;
          if (value.localTime === undefined) { delete next.localTime; delete next.timezone; }
          delete next.pausedByDisconnect;
          return writeJob(next);
        }
        const job: SyncJob = { id: `sjob_${hex()}`, connectionId, version: 1, ...value, nextRunAt: nextSlot(value, stamp), createdAt: stamp, updatedAt: stamp };
        const { id, connectionId: _connection, version, ...data } = job;
        db.prepare('INSERT INTO sync_jobs(id,connection_id,version,data) VALUES (?,?,?,?)').run(id, connectionId, version, JSON.stringify(data));
        return job;
      });
    },
    update(id: string, input: SyncScheduleInput & { version: number }): SyncJob {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.version) || input.version < 1) return fail('Provide the current sync job version to change it.');
      const { version, ...schedule } = input;
      const value = validateSyncSchedule(schedule);
      return transaction(() => {
        const row = typeof id === 'string' && SYNC_JOB_ID.test(id) ? jobRow(id) : undefined;
        if (!row) return fail('Sync job not found.', 404, 'sync_job_not_found');
        const saved = parseJob(row);
        if (saved.version !== version) return fail('This sync schedule changed. Reload before saving.', 409, 'sync_job_version_conflict');
        const stamp = now();
        const next: SyncJob = { ...saved, ...value, version: saved.version + 1, updatedAt: stamp, nextRunAt: nextSlot(value, stamp) };
        if (value.weekday === undefined) delete next.weekday;
        if (value.localTime === undefined) { delete next.localTime; delete next.timezone; }
        delete next.pausedByDisconnect;
        return writeJob(next);
      });
    },
    /** Disconnect: stop scheduled syncs. Attempts and their history are kept. */
    disable(id: string): SyncJob {
      return transaction(() => {
        const row = jobRow(id);
        if (!row) return fail('Sync job not found.', 404, 'sync_job_not_found');
        const saved = parseJob(row);
        if (!saved.enabled && saved.nextRunAt === null) return saved;
        return writeJob({ ...saved, enabled: false, nextRunAt: null, pausedByDisconnect: true, version: saved.version + 1, updatedAt: now() });
      });
    },
    /**
     * Reconnect (M8 gate): a job that a disconnect stopped runs again on its saved frequency and time, with its next
     * slot strictly in the future (no catch-up). A job its owner had paused before the disconnect stays paused.
     */
    resume(id: string): SyncJob {
      return transaction(() => {
        const row = jobRow(id);
        if (!row) return fail('Sync job not found.', 404, 'sync_job_not_found');
        const saved = parseJob(row);
        if (!saved.pausedByDisconnect) return saved;
        const stamp = now();
        const next: SyncJob = { ...saved, enabled: true, version: saved.version + 1, updatedAt: stamp };
        delete next.pausedByDisconnect;
        return writeJob({ ...next, nextRunAt: nextSlot(next, stamp) });
      });
    },
    /**
     * Claim one attempt per due job and advance its slot strictly past `at`. Missed slots advance
     * without catch-up; a job whose connection is disconnected or already syncing claims nothing.
     */
    claimDue(at = now()): SyncAttempt[] {
      const stamp = iso(at);
      return transaction(() => {
        const claimed: SyncAttempt[] = [];
        const rows = db.prepare("SELECT j.* FROM sync_jobs j JOIN connections c ON c.id=j.connection_id WHERE c.status != 'disconnected' ORDER BY j.rowid").all() as Row[];
        for (const row of rows) {
          const job = parseJob(row);
          if (!job.enabled || !job.nextRunAt || job.nextRunAt > stamp) continue;
          if (!activeFor(job.id)) {
            const slotTaken = db.prepare('SELECT 1 FROM sync_job_attempts WHERE job_id=? AND scheduled_for=? LIMIT 1').get(job.id, job.nextRunAt);
            if (!slotTaken) claimed.push(insertAttempt(job.id, job.nextRunAt, 1, 'schedule'));
          }
          writeJob({ ...job, nextRunAt: nextSlot(job, stamp) });
        }
        return claimed;
      });
    },
    /** "Sync now" and pre-sync. An attempt already pending or started is returned, never duplicated. */
    request(jobId: string, trigger: SyncTrigger, at = now()): { attempt: SyncAttempt; reused: boolean } {
      if (!TRIGGERS.includes(trigger) || trigger === 'schedule') return fail('Choose an on-demand sync.');
      return transaction(() => {
        if (!jobRow(jobId)) return fail('Sync job not found.', 404, 'sync_job_not_found');
        const active = activeFor(jobId);
        if (active) return { attempt: active, reused: true };
        // The request time is the slot; two requests in one millisecond get distinct slots.
        let slot = new Date(iso(at));
        while (db.prepare('SELECT 1 FROM sync_job_attempts WHERE job_id=? AND scheduled_for=? LIMIT 1').get(jobId, slot.toISOString())) slot = new Date(slot.getTime() + 1);
        return { attempt: insertAttempt(jobId, slot.toISOString(), 1, trigger), reused: false };
      });
    },
    active(jobId: string): SyncAttempt | undefined { return activeFor(jobId); },
    attempt(id: string): SyncAttempt | undefined {
      const row = typeof id === 'string' && SYNC_ATTEMPT_ID.test(id) ? attemptRow(id) : undefined;
      return row ? parseAttempt(row) : undefined;
    },
    nextPending(): SyncAttempt | undefined {
      const row = db.prepare("SELECT * FROM sync_job_attempts WHERE status='pending' ORDER BY rowid LIMIT 1").get() as Row | undefined;
      return row ? parseAttempt(row) : undefined;
    },
    started(): SyncAttempt[] {
      return (db.prepare("SELECT * FROM sync_job_attempts WHERE status='started' ORDER BY rowid").all() as Row[]).map(parseAttempt);
    },
    /** Set immediately before any external call. */
    start(id: string): SyncAttempt {
      return transaction(() => {
        const attempt = requireAttempt(id);
        if (attempt.status !== 'pending') return fail('This sync attempt already started.', 409, 'sync_attempt_conflict');
        return writeAttempt({ ...attempt, status: 'started', startedAt: now() });
      });
    },
    /** Recorded after the fetch and before any import, so boot recovery can finish with the same keys. */
    recordFiles(id: string, files: SyncAttemptFile[]): SyncAttempt {
      return transaction(() => {
        const attempt = requireAttempt(id);
        if (attempt.status !== 'started' || attempt.files.length) return fail('This sync attempt already recorded its files.', 409, 'sync_attempt_conflict');
        if (!Array.isArray(files) || files.length > 5 || files.some(file => !SYNC_KEY.test(file.key) || !/^[a-f0-9]{64}$/.test(file.contentHash))) return fail('Record at most five acquired files with valid keys and hashes.');
        return writeAttempt({ ...attempt, files: files.map(file => ({ ...file, observedAt: iso(file.observedAt) })) });
      });
    },
    finish(id: string, outcome: SyncAttemptOutcome): SyncAttempt {
      if (!outcome || !['completed', 'unchanged', 'failed'].includes(outcome.status) ||
          (outcome.errorCode !== undefined && !/^[a-z0-9_]{1,80}$/.test(outcome.errorCode)) ||
          (outcome.status === 'failed') !== (outcome.errorCode !== undefined)) return fail('Record a bounded outcome for this sync attempt.');
      return transaction(() => {
        const attempt = requireAttempt(id);
        if (TERMINAL.includes(attempt.status)) return fail('This sync attempt already has a recorded outcome.', 409, 'sync_attempt_conflict');
        const message = outcome.message === undefined ? undefined : String(outcome.message).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
        return writeAttempt({ ...attempt, status: outcome.status, finishedAt: now(), versionIds: outcome.versionIds ?? attempt.versionIds,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}), ...(message ? { message } : {}),
          ...(outcome.bytes !== undefined ? { bytes: outcome.bytes } : {}), ...(outcome.records !== undefined ? { records: outcome.records } : {}) });
      });
    },
    /** Found `started` at boot with nothing to finish: mark it and queue attempt N+1 for the same slot. */
    interrupt(id: string): { interrupted: SyncAttempt; retry: SyncAttempt } {
      return transaction(() => {
        const attempt = requireAttempt(id);
        if (attempt.status !== 'started') return fail('Only a started sync attempt can be interrupted.', 409, 'sync_attempt_conflict');
        const interrupted = writeAttempt({ ...attempt, status: 'interrupted', finishedAt: now(), errorCode: 'interrupted',
          message: 'The previous process stopped during this sync. A new attempt was queued.' });
        return { interrupted, retry: insertAttempt(attempt.jobId, attempt.scheduledFor, attempt.attempt + 1, attempt.trigger) };
      });
    },
    /** The latest finished outcomes, newest first; interrupted attempts do not count as failures. */
    recentOutcomes(jobId: string, limit = 3): SyncAttemptStatus[] {
      return (db.prepare("SELECT status FROM sync_job_attempts WHERE job_id=? AND status IN ('completed','unchanged','failed') ORDER BY rowid DESC LIMIT ?").all(jobId, limit) as Row[])
        .map(row => row.status as SyncAttemptStatus);
    },
    attempts(jobId: string, limit = 20): SyncAttempt[] {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('Request 1–100 sync attempts.');
      return (db.prepare('SELECT * FROM sync_job_attempts WHERE job_id=? ORDER BY rowid DESC LIMIT ?').all(jobId, limit) as Row[]).map(parseAttempt);
    },
    latestSuccessfulAttempt(jobId: string): SyncAttempt | undefined {
      const row = db.prepare("SELECT * FROM sync_job_attempts WHERE job_id=? AND status IN ('completed','unchanged') ORDER BY rowid DESC LIMIT 1").get(jobId) as Row | undefined;
      return row ? parseAttempt(row) : undefined;
    },
  };
}
export type SyncJobStore = ReturnType<typeof createSyncJobStore>;
