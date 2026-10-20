import { DataLayerError } from '../errors.ts';
import { TOOL_IDS, labelFor } from '../labels.ts';
import { CONTEMPORANEOUS_TOLERANCE_SECONDS, buildReceipt, observationGapSeconds, type EvidenceReceipt } from '../receipts.ts';
import { SOCIAL_METRICS, SOCIAL_NORMALIZER_VERSION, normalizeSocialBatch, type SocialMetric, type SocialPlatform } from '../normalize/social.ts';
import type { RawBatch, RawCoverage } from '../types.ts';

export const COHORT_STATEMENT = 'Posts published inside the stated week; counters are lifetime totals as observed at fetch time, not activity during that week.';

export interface SocialMetricAggregate {
  /** Posts where the provider reported this metric. */
  readonly observed: number;
  /** Posts where it was absent or null. Missing is never counted as zero. */
  readonly missing: number;
  /** Null when nothing was observed; a real zero total stays zero. */
  readonly total: number | null;
}

export interface SocialAccountGroup {
  readonly platform: SocialPlatform;
  readonly account: string;
  readonly posts: number;
  readonly metrics: Readonly<Record<SocialMetric, SocialMetricAggregate>>;
}

export interface SocialWeeklySummary {
  readonly toolId: string;
  readonly label: string;
  readonly week: { readonly from: string; readonly through: string };
  readonly cohort: string;
  readonly posts: number;
  readonly undatedPosts: number;
  readonly outsideWeek: number;
  readonly groups: readonly SocialAccountGroup[];
  readonly coverage: { readonly status: RawCoverage; readonly notice: string };
  readonly warnings: readonly string[];
  readonly receipt: EvidenceReceipt;
}

export interface SocialPeriodComparison {
  readonly toolId: string;
  readonly label: string;
  readonly boundary: { readonly platform: SocialPlatform; readonly account: string };
  readonly comparison: string;
  readonly metric: SocialMetric;
  readonly current: { readonly week: { from: string; through: string }; readonly posts: number; readonly aggregate: SocialMetricAggregate; readonly receipt: EvidenceReceipt };
  readonly previous: { readonly week: { from: string; through: string }; readonly posts: number; readonly aggregate: SocialMetricAggregate; readonly receipt: EvidenceReceipt };
  readonly change: number | null;
  readonly perPostChange: number | null;
  readonly suppressed: { readonly reason: string; readonly message: string } | null;
}

const DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function weekRange(weekStart: string): { from: string; through: string } {
  if (!validDate(weekStart)) {
    throw new DataLayerError('Use a real UTC week start in YYYY-MM-DD format for the seven-day window.', 'invalid_week_start',
      [{ code: 'invalid_week_start', message: 'Provide a real UTC date such as 2026-09-14.' }]);
  }
  const from = Date.parse(`${weekStart}T00:00:00Z`);
  return { from: weekStart, through: new Date(from + 6 * DAY).toISOString().slice(0, 10) };
}

const dateOf = (timestamp: string) => timestamp.slice(0, 10);

function aggregate(metrics: readonly (number | null)[], label: SocialMetric): SocialMetricAggregate {
  const observed = metrics.filter((value): value is number => value !== null);
  let total = 0;
  for (const value of observed) total += value;
  if (observed.length && !Number.isSafeInteger(total)) {
    throw new DataLayerError(`The ${label} total exceeds exact integer range; split the window before summarizing.`, 'metric_overflow',
      [{ code: 'metric_overflow', message: `The observed ${label} values cannot be summed exactly.`, field: label }]);
  }
  return { observed: observed.length, missing: metrics.length - observed.length, total: observed.length ? total : null };
}

const coverageNotice = (status: RawCoverage) => status === 'complete'
  ? 'The uploader declared this window complete. That declaration is not independently verified.'
  : status === 'partial' ? 'The uploader declared this window partial, so the cohort is a lower bound.'
  : 'Coverage was not declared. A counter total is a lower bound, and an absent metric is unknown rather than zero.';

/**
 * Summarize the public counters of posts published in one UTC week.
 *
 * Only observed public metrics are reported. Nothing here derives reach, impressions, clicks,
 * spend, revenue or return on investment: a public post export does not contain them, and a
 * number that was not observed is never produced. Totals stay inside one account and platform,
 * because counters from different providers are not comparable and are never summed together.
 */
export function socialWeeklySummary(input: {
  readonly batch: RawBatch;
  readonly platform: SocialPlatform | null;
  readonly weekStart: string;
  readonly now?: () => string;
}): SocialWeeklySummary {
  const now = input.now ?? (() => new Date().toISOString());
  const week = weekRange(input.weekStart);
  const normalized = normalizeSocialBatch(input.batch, { platform: input.platform });
  const inWeek = normalized.posts.filter(post => post.publishedAt !== null && dateOf(post.publishedAt) >= week.from && dateOf(post.publishedAt) <= week.through);
  const byAccount = new Map<string, typeof inWeek>();
  for (const post of inWeek) byAccount.set(post.account, [...(byAccount.get(post.account) ?? []), post]);
  const groups: SocialAccountGroup[] = [...byAccount.entries()].map(([account, posts]) => ({
    platform: normalized.platform,
    account,
    posts: posts.length,
    metrics: Object.fromEntries(SOCIAL_METRICS.map(metric => [metric, aggregate(posts.map(post => post.metrics[metric]), metric)])) as Record<SocialMetric, SocialMetricAggregate>,
  })).sort((a, b) => a.account.localeCompare(b.account));
  return {
    toolId: TOOL_IDS.socialWeekly,
    label: labelFor(TOOL_IDS.socialWeekly),
    week,
    cohort: COHORT_STATEMENT,
    posts: inWeek.length,
    undatedPosts: normalized.posts.length - normalized.posts.filter(post => post.publishedAt !== null).length,
    outsideWeek: normalized.posts.length - inWeek.length - (normalized.posts.length - normalized.posts.filter(post => post.publishedAt !== null).length),
    groups,
    coverage: { status: input.batch.provenance.declaredCoverage, notice: coverageNotice(input.batch.provenance.declaredCoverage) },
    warnings: normalized.warnings.map(warning => warning.message),
    receipt: buildReceipt({
      batch: input.batch, toolId: TOOL_IDS.socialWeekly, label: labelFor(TOOL_IDS.socialWeekly),
      sourceVersion: SOCIAL_NORMALIZER_VERSION, records: inWeek.map(post => post.record), computedAt: now(),
    }),
  };
}

/**
 * Compare one metric between two publication cohorts of the same account and platform.
 *
 * A comparison is refused or suppressed rather than shown as growth when it would mislead:
 * incomplete coverage, missing observations, a metric the provider never reports, or two
 * snapshots whose counters were observed far apart (a lifetime counter keeps accumulating,
 * so cohort totals from different observation times are not like-for-like).
 */
export function socialPeriodComparison(input: {
  readonly current: { readonly batch: RawBatch; readonly weekStart: string };
  readonly previous: { readonly batch: RawBatch; readonly weekStart: string };
  readonly platform: SocialPlatform | null;
  readonly account: string;
  readonly metric: SocialMetric;
  readonly now?: () => string;
}): SocialPeriodComparison {
  const now = input.now ?? (() => new Date().toISOString());
  if (!SOCIAL_METRICS.includes(input.metric)) {
    throw new DataLayerError(`Compare one of the observed public metrics: ${SOCIAL_METRICS.join(', ')}.`, 'unknown_metric',
      [{ code: 'unknown_metric', message: 'Choose a metric this source can observe.' }]);
  }
  const side = (batch: RawBatch, weekStart: string) => {
    const summary = socialWeeklySummary({ batch, platform: input.platform, weekStart, now });
    const group = summary.groups.find(item => item.account === input.account);
    if (!group) {
      throw new DataLayerError(`The ${summary.week.from} week has no posts for ${input.account}. Compare weeks that both contain this account.`, 'missing_boundary_group',
        [{ code: 'missing_boundary_group', message: `No ${input.account} posts were published in the week starting ${summary.week.from}.` }]);
    }
    return { summary, group };
  };
  const current = side(input.current.batch, input.current.weekStart);
  const previous = side(input.previous.batch, input.previous.weekStart);
  if (current.summary.week.from === previous.summary.week.from && input.current.batch.id === input.previous.batch.id) {
    throw new DataLayerError('Compare two different weeks of publication cohorts.', 'same_period', [{ code: 'same_period', message: 'Choose a previous week that differs from the current week.' }]);
  }
  const metricCurrent = current.group.metrics[input.metric];
  const metricPrevious = previous.group.metrics[input.metric];
  const gap = observationGapSeconds(input.current.batch, input.previous.batch);
  // One suppression decision drives both the figures and the claim, so a suppressed comparison
  // can never still publish a growth number.
  const suppression = suppress(input.current.batch, input.previous.batch, metricCurrent, metricPrevious)
    ?? (gap > CONTEMPORANEOUS_TOLERANCE_SECONDS ? {
      reason: 'non-contemporaneous-observations',
      message: `The two snapshots were fetched ${Math.round(gap / 3600)} hours apart. Lifetime counters accumulate, so cohorts observed at different times are not comparable; the figures are shown without a growth claim.`,
    } : null);
  return {
    toolId: TOOL_IDS.socialPeriod,
    label: labelFor(TOOL_IDS.socialPeriod),
    boundary: { platform: current.group.platform, account: current.group.account },
    comparison: 'Publication cohorts for one account and one platform, each summarized inside its own week and never merged with another provider.',
    metric: input.metric,
    current: { week: current.summary.week, posts: current.group.posts, aggregate: metricCurrent, receipt: current.summary.receipt },
    previous: { week: previous.summary.week, posts: previous.group.posts, aggregate: metricPrevious, receipt: previous.summary.receipt },
    change: suppression || metricCurrent.total === null || metricPrevious.total === null ? null : metricCurrent.total - metricPrevious.total,
    perPostChange: suppression || metricCurrent.total === null || metricPrevious.total === null ? null
      : Number(((metricCurrent.total / current.group.posts) - (metricPrevious.total / previous.group.posts)).toFixed(4)),
    suppressed: suppression,
  };
}

function suppress(current: RawBatch, previous: RawBatch, metricCurrent: SocialMetricAggregate, metricPrevious: SocialMetricAggregate) {
  if (current.provenance.declaredCoverage !== 'complete' || previous.provenance.declaredCoverage !== 'complete') {
    return { reason: 'incomplete-coverage', message: 'Coverage is incomplete or undeclared for at least one week, so a change would overstate what was observed. The totals are shown without a growth claim.' };
  }
  // Nothing observed on either side is a provider that does not expose the metric, which is a
  // different statement from "some posts are missing a value this provider does report".
  if (!metricCurrent.observed && !metricPrevious.observed) {
    return { reason: 'metric-not-observed', message: 'This provider does not report the metric for these posts, so no change exists to report.' };
  }
  if (metricCurrent.missing || metricPrevious.missing) {
    return { reason: 'missing-values', message: 'At least one post has no observed value for this metric, so each total is a partial sum. A change between partial sums is not reported.' };
  }
  return null;
}
