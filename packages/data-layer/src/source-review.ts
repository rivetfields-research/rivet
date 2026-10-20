import { refuse } from './errors.ts';
import { contentHash } from './tabular/input.ts';
import type { SourceSemantics, SourceObservation, SourceRecord } from './source-semantics.ts';

export interface SourceReviewRequest {
  operation: 'review'; observationId: string; metric: string;
  groupBy: 'record' | 'day' | 'contentType' | 'channel';
  dateRange?: { from: string; to: string };
  limit?: number;
}

export function validateSourceReview(input: unknown): SourceReviewRequest {
  const value = input as SourceReviewRequest;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['operation', 'observationId', 'metric', 'groupBy', 'dateRange', 'limit'].includes(key)) || value.operation !== 'review' ||
      ![value.observationId, value.metric].every(id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(id)) ||
      !['record', 'day', 'contentType', 'channel'].includes(value.groupBy) ||
      value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100)) {
    refuse('invalid_source_analysis', 'Review requires a saved observationId, native metric, groupBy and optional 1-100 limit. No SQL or supplied values.');
  }
  if (value.dateRange !== undefined) {
    const range = value.dateRange;
    const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
    if (!range || typeof range !== 'object' || Array.isArray(range) || Object.keys(range).length !== 2 ||
        !date(range.from) || !date(range.to) || range.from >= range.to) refuse('invalid_source_analysis', 'Use real dateRange {from,to}, from inclusive and to exclusive.');
  }
  return { operation: 'review', observationId: value.observationId, metric: value.metric, groupBy: value.groupBy,
    ...(value.dateRange ? { dateRange: { ...value.dateRange } } : {}), limit: value.limit ?? 20 };
}

export function reviewSource(store: Pick<SourceSemantics,'get'|'records'>, input: unknown) {
  const request = validateSourceReview(input);
  const observation = store.get(request.observationId);
  if (!observation) refuse('unknown_observation', 'That observation is unavailable in this workspace.');
  const metric = observation.metricDefinitions.find(definition => definition.id === request.metric);
  if (!metric) refuse('unsupported_source_metric', 'That metric is not defined for this source.');
  const records = store.records(observation.id);
  const period = metric.basis === 'period';
  if (request.groupBy === 'channel' && !period || request.groupBy === 'contentType' && period) refuse('incompatible_join', 'Use channel for native traffic periods and contentType for published content.');
  const zones = new Set(records.map(record => record.period?.timezone));
  if (period && records.length && (zones.has(undefined) || zones.size !== 1)) refuse('incompatible_metric_periods', 'Traffic reviews require one provider reporting timezone.');
  const included: SourceRecord[] = [], excludedByDate: string[] = [], excludedUndated: string[] = [];
  for (const record of records) {
    const day = period ? record.period?.date : record.publishedAt?.slice(0, 10);
    if (request.dateRange && !day) { excludedUndated.push(record.id); continue; }
    if (request.dateRange && (day! < request.dateRange.from || day! >= request.dateRange.to)) { excludedByDate.push(record.id); continue; }
    included.push(record);
  }
  const aggregate = (values: SourceRecord[]) => {
    const known = values.flatMap(record => record.metrics[request.metric]?.value === null || record.metrics[request.metric]?.value === undefined ? [] : [record.metrics[request.metric]!.value!]);
    const canAdd = metric.additive || values.length === 1;
    const sum = canAdd && known.length ? known.reduce((a, b) => a + b, 0) : null;
    if (sum !== null && !Number.isSafeInteger(sum)) refuse('semantic_overflow', 'Metric totals exceed the exact supported range.');
    return { value: known.length === values.length ? sum : null, knownSum: sum, records: values.length,
      missingRecords: values.length - known.length, nonAdditive: !canAdd };
  };
  const groups = new Map<string, SourceRecord[]>();
  for (const record of included) {
    const group = request.groupBy === 'record' ? record.id : request.groupBy === 'day' ? (record.period?.date ?? record.publishedAt?.slice(0, 10) ?? '(undated)')
      : request.groupBy === 'channel' ? record.period!.channel : record.contentType ?? '(unknown)';
    const groupRecords = groups.get(group) ?? []; groupRecords.push(record); groups.set(group, groupRecords);
  }
  const evidence = (record: SourceRecord) => ({ observationId: observation.id, rawBatchId: observation.rawBatchId, sourceId: observation.sourceId,
    sourceHash: observation.sourceHash, recordId: record.id });
  const rows = [...groups].map(([group, values]) => ({ group, ...aggregate(values),
    ...(request.groupBy === 'record' ? { text: values[0]!.text, url: values[0]!.url, publishedAt: values[0]!.publishedAt } : {}), evidence: values.map(evidence) }))
    .sort((a, b) => a.value === null ? b.value === null ? a.group.localeCompare(b.group) : 1 : b.value === null ? -1 : b.value - a.value || a.group.localeCompare(b.group));
  const warnings = [period ? 'Dates are native reporting days in the property timezone, not UTC publication dates.'
    : 'Dates select when content was published. Values are lifetime counters observed at collection, not engagement earned in that date range.',
    'Coverage describes the collected window, not the whole account. An empty cohort is not proof of zero activity.',
    ...(!metric.additive ? ['This metric cannot be added across records; multi-record totals are withheld.'] : []),
    ...(included.some(record => record.metrics[request.metric]?.value === null) ? ['Missing values are unknown, not zero. Known sums cover only records with returned values.'] : []),
    ...(observation.capped || observation.coverage !== 'complete' ? ['The collected window is partial, capped or has unknown coverage.'] : [])];
  return { operation: 'review' as const, id: `source_analysis_${contentHash(request)}`, request, metric, observations: [observation] as SourceObservation[],
    rows: rows.slice(0, request.limit), totals: aggregate(included), counts: { inputRecords: records.length, includedRecords: included.length,
      excludedByDate: excludedByDate.length, excludedUndated: excludedUndated.length, totalGroups: rows.length, returnedGroups: Math.min(rows.length, request.limit!) },
    dateBasis: period ? 'provider_period' as const : 'publication_utc' as const, timezone: period ? [...zones][0] ?? null : 'UTC',
    evidence: { included: included.map(evidence), excludedByDate, excludedUndated }, warnings };
}
