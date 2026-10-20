import type { DatabaseSync } from 'node:sqlite';
import { HarnessError } from './errors.ts';
import type { RunAccessContext, WeeklyReviewMetadata, WeeklyReviewPeriod, Workflow } from './types.ts';
import { Temporal } from '@js-temporal/polyfill';

/** Previous complete week, with an inclusive start and exclusive end. No Node runtime imports. */
export function previousFullWeekUtc(anchor: string): WeeklyReviewPeriod {
  const date = new Date(anchor);
  if (!Number.isFinite(date.getTime())) throw new HarnessError('Provide a valid weekly review anchor.', 400, 'invalid_weekly_review');
  const monday = new Date(date);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const from = new Date(monday);
  from.setUTCDate(from.getUTCDate() - 7);
  return { from: from.toISOString(), to: monday.toISOString(), timezone: 'UTC', anchor: date.toISOString() };
}

/** Seven full local days before the frozen fire date, not seven 24-hour blocks.
 * Temporal's compatible rule resolves missing/repeated local midnights. */
export function previousFullDaysInTimezone(anchor: string, timezone: string): WeeklyReviewPeriod {
  try {
    if (typeof timezone !== 'string' || timezone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(timezone)) throw new Error();
    const instant = Temporal.Instant.from(anchor);
    const end = instant.toZonedDateTimeISO(timezone).toPlainDate();
    const boundary = (date: Temporal.PlainDate) => new Date(date.toZonedDateTime(timezone).epochMilliseconds).toISOString();
    return { from: boundary(end.subtract({ days: 7 })), to: boundary(end), timezone, anchor: new Date(instant.epochMilliseconds).toISOString() };
  } catch { throw new HarnessError('Provide a valid weekly review anchor and IANA timezone.', 400, 'invalid_weekly_review'); }
}

/** Keep the source's date basis; only bind the requested interval. */
export function bindWeeklyReviewDates<T extends object>(request: T, period: WeeklyReviewPeriod, native = false, sourceTimezone?: string): T & { dateRange: { from: string; to: string } } {
  // Non-UTC periods require matching day boundaries. Legacy UTC queries retain
  // their native-day semantics and disclose the property-timezone limitation.
  if (native && period.timezone !== 'UTC' && sourceTimezone !== period.timezone) {
    throw new HarnessError('Native review dates require the verified source timezone to match the schedule timezone. No local-period calculation was executed.', 422, 'weekly_review_period_mismatch');
  }
  const calendarDate = (instant: string) => Temporal.Instant.from(instant).toZonedDateTimeISO(period.timezone).toPlainDate().toString();
  const dates = { from: calendarDate(period.from), to: calendarDate(period.to) };
  const range = (request as { dateRange?: unknown }).dateRange;
  if (range !== undefined) {
    const value = range as { from?: unknown; to?: unknown } | null;
    const matches = (value: unknown, expected: string, localDate: string) => value === expected || value === localDate;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
        !matches(value.from, period.from, dates.from) || !matches(value.to, period.to, dates.to)) {
      throw new HarnessError(`Weekly review calculations must use dateRange {from:"${period.from}",to:"${period.to}"} (end exclusive). No all-time or different-period calculation was executed.`, 422, 'weekly_review_period_mismatch');
    }
  }
  return { ...request, dateRange: native ? dates : { from: period.from, to: period.to } };
}

export interface WeeklyReviewPreparation {
  workflow: Workflow;
  accessContext: RunAccessContext | null;
  metadata: WeeklyReviewMetadata;
  sealed: boolean;
}

/** Retained like schedule attempts: bounded, never evicted or silently re-prepared. */
export function createWeeklyReviewStore(db: DatabaseSync) {
  // Cache presence only, so another store's first write becomes visible.
  let present = false;
  const hasSchema = () => present ||= Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='weekly_review_preparations'").get());
  const ensureSchema = () => {
    if (hasSchema()) return;
    db.exec('CREATE TABLE IF NOT EXISTS weekly_review_preparations (request_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    present = true;
  };
  const get = (requestId: string): WeeklyReviewPreparation | undefined => {
    if (!hasSchema()) return undefined;
    const row = db.prepare('SELECT data FROM weekly_review_preparations WHERE request_id=?').get(requestId);
    return row ? JSON.parse(row.data as string) as WeeklyReviewPreparation : undefined;
  };
  return {
    get,
    create(requestId: string, workflow: Workflow, anchor: string, accessContext: RunAccessContext | null, timezone?: string): WeeklyReviewPreparation {
      const previous = get(requestId);
      if (previous) return previous;
      ensureSchema();
      if ((db.prepare('SELECT count(*) AS n FROM weekly_review_preparations').get()!.n as number) >= 10000) {
        throw new HarnessError('Retained weekly review preparations need operator review before another start.', 409, 'weekly_review_history_limit');
      }
      const entry: WeeklyReviewPreparation = { workflow, accessContext, sealed: false,
        metadata: { period: timezone === undefined ? previousFullWeekUtc(anchor) : previousFullDaysInTimezone(anchor, timezone), connectionIds: [...workflow.weeklyReview!.connectionIds],
          presync: { status: 'skipped', connections: [] }, resolvedSources: [], missingConnectionIds: [] } };
      db.prepare('INSERT INTO weekly_review_preparations(request_id,data) VALUES (?,?)').run(requestId, JSON.stringify(entry));
      return entry;
    },
    save(requestId: string, entry: WeeklyReviewPreparation) {
      if (get(requestId)?.sealed) throw new HarnessError('This weekly review already pinned its inputs.', 409, 'weekly_review_pin_conflict');
      ensureSchema();
      db.prepare('UPDATE weekly_review_preparations SET data=? WHERE request_id=?').run(JSON.stringify(entry), requestId);
    },
  };
}

export function weeklyReviewContext(metadata: WeeklyReviewMetadata): string {
  return `\nWeekly review period and preparation (authoritative): ${JSON.stringify(metadata)}\n` +
    `Review only the previous full week specified above: from is inclusive, to is exclusive, timezone is ${metadata.period.timezone}. ` +
    'Use these exact dates even when the run was admitted later. Read and cite every pinned latest input, one snapshot per selected connection, and address every selected account. ' +
    'For workspace.analyze_table and workspace.analyze_sources review, dateRange is bound to this exact from/to interval; omit it to use the bound dates or supply these exact dates. ' +
    'Native review dates remain publication dates or provider reporting days in the property timezone. ' +
    (metadata.period.timezone === 'UTC' ? 'Property reporting days cannot establish exact UTC event activity. '
      : 'A native date-only calculation requires matching source and schedule timezones; provider reporting days cannot establish exact activity in another timezone. ') +
    'Other source operations cannot currently bind an explicit compatible period in this weekly workflow; describe that limitation rather than executing an all-time comparison, join or correlation. ' +
    'A single-source chart or calculation must not replace this whole review. Use qualitative findings and explicit limitations when period metrics are unavailable. ' +
    'Separate posts published during this week from activity measured during this week. Publication dates do not date lifetime metrics. ' +
    'Never sum lifetime snapshots or present lifetime counts as weekly activity. Use source-native metric definitions and time coverage; ' +
    'do not equate likes, views, impressions, reach or engagement across providers. Report unavailable period activity as unknown. ' +
    'Disclose failed, incomplete or skipped refreshes and the exact data observation times; stale fallback is not a successful refresh. ' +
    'Return a source-linked review with supported findings, data limitations and concrete next actions for human review.';
}
