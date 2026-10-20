import { createHash } from 'node:crypto';
import { calculateWeeklyUsage, USAGE_METRICS_VERSION, type UsageDataset, type UsageMetric, type WeeklyUsageReport } from './reporting.ts';

/** An uploader's declaration, never inferred from the dates of observed events. */
export interface UsageCoverage { readonly from: string; readonly through: string; readonly complete: boolean; }
export interface PeriodCoverage {
  readonly status: 'declared-complete' | 'partial' | 'unknown';
  readonly message: string;
}
export interface UsageComparison {
  readonly key: UsageMetric['key']; readonly label: string; readonly unit: UsageMetric['unit'];
  readonly current: number | null; readonly previous: number | null;
  readonly absoluteChange: number | null; readonly percentChange: number | null;
  readonly reason: string | null;
}
export interface UsageDay { readonly date: string; readonly events: number | null; readonly activeUsers: number | null; }
export interface WeeklyUsageAnalysis {
  readonly kind: 'weekly-usage'; readonly schemaVersion: 1; readonly id: string;
  readonly datasetId: string; readonly sourceId: string; readonly sourceName: string;
  readonly contentHash: string; readonly calculatorVersion: typeof USAGE_METRICS_VERSION;
  /** Exact arithmetic over supplied rows. Render comparisons/daily to preserve unknowns. */
  readonly current: WeeklyUsageReport; readonly previous: WeeklyUsageReport | null;
  readonly coverage: { readonly declaration: UsageCoverage | null; readonly current: PeriodCoverage; readonly previous: PeriodCoverage | null; };
  readonly comparisons: readonly UsageComparison[];
  readonly daily: { readonly current: readonly UsageDay[]; readonly previous: readonly UsageDay[] | null; };
  readonly checks: readonly { readonly id: string; readonly status: 'passed' | 'warning'; readonly message: string }[];
  readonly createdAt: string;
}

function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000-') &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10) === value;
}
export function validateUsageCoverage(value: unknown): UsageCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
      Object.keys(value).some(key => !['from','through','complete'].includes(key))) throw new TypeError('Coverage requires from, through and complete.');
  const input = value as Record<string,unknown>;
  if (!date(input.from) || !date(input.through) || input.from > input.through || typeof input.complete !== 'boolean') throw new TypeError('Coverage requires real UTC dates in order and a boolean completeness declaration.');
  return Object.freeze({from:input.from,through:input.through,complete:input.complete});
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Only a saved, imported dataset may be supplied by the caller. No model numbers. */
export function calculateUsageAnalysis(input: {
  datasetId: string; dataset: UsageDataset; weekStart: string; comparePrevious: boolean;
  coverage?: UsageCoverage; createdAt: string;
}): WeeklyUsageAnalysis {
  const {datasetId,dataset,weekStart,comparePrevious,createdAt} = input;
  if (typeof comparePrevious !== 'boolean') throw new TypeError('comparePrevious must be a boolean.');
  const declaration = input.coverage === undefined ? null : validateUsageCoverage(input.coverage);
  const current = calculateWeeklyUsage(dataset,weekStart);
  const previousStart = new Date(Date.parse(`${weekStart}T00:00:00.000Z`) - 7*86_400_000).toISOString().slice(0,10);
  const previous = comparePrevious ? calculateWeeklyUsage(dataset,previousStart) : null;
  const completeDay = (day: string) => declaration?.complete === true && declaration.from <= day && declaration.through >= day;
  const coverage = (report: WeeklyUsageReport): PeriodCoverage => {
    if (completeDay(report.period.from) && completeDay(report.period.through)) return {status:'declared-complete',message:'The uploader declared this full period complete. This declaration has not been independently verified.'};
    if (report.recordsIncluded > 0) return {status:'partial',message:'Counts describe supplied records only. Full-period completeness has not been established.'};
    return {status:'unknown',message:'No rows supplied for this period; activity is unknown.'};
  };
  const currentCoverage = coverage(current), previousCoverage = previous ? coverage(previous) : null;
  const display = (metric: UsageMetric, report: WeeklyUsageReport, status: PeriodCoverage) =>
    report.recordsIncluded === 0 && status.status !== 'declared-complete' ? null : metric.value;
  const comparisons = current.metrics.map((metric,index): UsageComparison => {
    const currentValue = display(metric,current,currentCoverage);
    const previousValue = previous ? display(previous.metrics[index],previous,previousCoverage!) : null;
    let reason: string | null = null;
    if (!previous) reason = 'Previous-period comparison was not requested.';
    else if (currentCoverage.status !== 'declared-complete' || previousCoverage?.status !== 'declared-complete') reason = 'Growth is unavailable without declared complete coverage for both periods.';
    else if (currentValue === null || previousValue === null) reason = 'This metric is undefined when there are no active users.';
    const absoluteChange = reason === null ? currentValue! - previousValue! : null;
    const percentChange = reason === null && previousValue !== 0 ? absoluteChange! / previousValue! * 100 : null;
    if (reason === null && previousValue === 0) reason = 'Percentage change is undefined because the previous value is zero.';
    return {key:metric.key,label:metric.label,unit:metric.unit,current:currentValue,previous:previousValue,absoluteChange,percentChange,reason};
  });
  const daily = (report: WeeklyUsageReport): UsageDay[] => report.days.map(day => ({date:day.date,
    events:day.events || completeDay(day.date) ? day.events : null,
    activeUsers:day.events || completeDay(day.date) ? day.activeUsers : null,
  }));
  const digest = createHash('sha256').update(JSON.stringify([datasetId,dataset.contentHash,USAGE_METRICS_VERSION,weekStart,comparePrevious,declaration])).digest('hex');
  const duplicates = current.duplicateRowsIncluded + (previous?.duplicateRowsIncluded ?? 0);
  return freeze({kind:'weekly-usage',schemaVersion:1,id:`calculation_${digest}`,datasetId,sourceId:`source_${digest}`,sourceName:dataset.sourceName,
    contentHash:dataset.contentHash,calculatorVersion:USAGE_METRICS_VERSION,current,previous,
    coverage:{declaration,current:currentCoverage,previous:previousCoverage},comparisons,daily:{current:daily(current),previous:previous?daily(previous):null},
    checks:[
      {id:'schema',status:'passed',message:'The saved CSV passed the date,user_id,event input contract.'},
      {id:'arithmetic',status:'passed',message:'Fixed code calculated these values from the saved input records; source record references are retained.'},
      {id:'coverage',status:currentCoverage.status==='declared-complete'&&(!previous||previousCoverage?.status==='declared-complete')?'passed':'warning',message:'Coverage is an uploader declaration, not proof. Missing rows are unknown unless their dates fall inside declared complete coverage.'},
      {id:'duplicates',status:duplicates?'warning':'passed',message:`${duplicates} identical repeated records in the requested periods were retained, not removed.`},
      {id:'source-truth',status:'warning',message:'Format and arithmetic checks do not verify the truth or completeness of the upload, or the model’s conclusions.'},
    ],createdAt});
}

/** Bounded aggregate receipt: no raw identifiers, event labels or large row-index lists. */
export function usageAnalysisText(analysis: WeeklyUsageAnalysis): string {
  const value = (number: number | null) => number === null ? 'Unknown or undefined' : String(number);
  return [
    `# Weekly usage analysis · ${analysis.current.period.from}`, '',
    `Current: ${analysis.current.period.from} through ${analysis.current.period.through} UTC.`,
    analysis.previous ? `Previous: ${analysis.previous.period.from} through ${analysis.previous.period.through} UTC.` : 'Previous period: not requested.',
    `Current coverage: ${analysis.coverage.current.message}`,
    ...(analysis.coverage.previous ? [`Previous coverage: ${analysis.coverage.previous.message}`] : []), '',
    '| Metric | Current supplied records | Previous supplied records | Change | Change % |', '| --- | ---: | ---: | ---: | ---: |',
    ...analysis.comparisons.map(metric => `| ${metric.label} (${metric.unit}) | ${value(metric.current)} | ${value(metric.previous)} | ${value(metric.absoluteChange)} | ${value(metric.percentChange)} |`), '',
    ...[...new Set(analysis.comparisons.map(metric=>metric.reason).filter(Boolean))].map(reason=>`- ${reason}`), '',
    ...analysis.current.metrics.map(metric=>`- ${metric.label}: ${metric.definition}`), '',
    '## Daily supplied records', '| Period | Date UTC | Events | Active users |', '| --- | --- | ---: | ---: |',
    ...analysis.daily.current.map(day=>`| Current | ${day.date} | ${value(day.events)} | ${value(day.activeUsers)} |`),
    ...(analysis.daily.previous??[]).map(day=>`| Previous | ${day.date} | ${value(day.events)} | ${value(day.activeUsers)} |`), '',
    ...analysis.checks.map(check=>`- ${check.message}`), '',
    `Dataset version: ${analysis.datasetId}`, `Input SHA-256: ${analysis.contentHash}`, `Calculator: ${analysis.calculatorVersion}`,
    'Exact record references are saved with the calculation. Do not infer causation, revenue or business savings from usage counts alone.',
  ].join('\n');
}
