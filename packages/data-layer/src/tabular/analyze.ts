import { refuse } from '../errors.ts';
import { allowedKeys, contentHash, freeze, object, parseDate, TABULAR_LIMITS } from './input.ts';
import { TIME_BASIS } from './normalize.ts';
import { compactEvidence } from './evidence.ts';
import { analysisColumnLabel } from './labels.ts';
import { providerMetricDefinition, providerTimeBasis, validateMetricSource } from './provider-metrics.ts';
import { CHART_TEMPLATES, COUNT_METRICS, GROUPINGS, METRIC_IDS, TABULAR_VERSION, type AnalysisRequest, type AnalysisResult, type AnalysisValues, type CountMetric, type MetricCoverage, type MetricDefinition, type MetricEvidence, type MetricId, type NormalizedDataset, type NormalizedRow, type RowReference } from './types.ts';

const labels: Record<MetricId, string> = { likes: 'Likes', reactions: 'Reactions', comments: 'Comments', shares: 'Shares', impressions: 'Impressions', clicks: 'Clicks', saves: 'Saves', interactions: 'Interactions', engagementRate: 'Engagement rate', postCount: 'Post count', reactionInteractions: 'Interactions from reactions', reactionEngagementRate: 'Engagement rate from reactions' };
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const HASH_SIZE_PLACEHOLDER = '0'.repeat(64);
const isRate = (metric: MetricId) => metric === 'engagementRate' || metric === 'reactionEngagementRate';
const interactionBasis = (metric: MetricId): CountMetric | undefined => ['reactionInteractions', 'reactionEngagementRate'].includes(metric) ? 'reactions' : ['interactions', 'engagementRate'].includes(metric) ? 'likes' : undefined;

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = freeze(METRIC_IDS.map((id): MetricDefinition => {
  const basis = interactionBasis(id);
  return {
    id, label: labels[id], unit: isRate(id) ? 'percent' : 'count',
    formula: id === 'postCount' ? 'count(distinct platform, account, postId)' : isRate(id) ? `100 * sum(${basis} + comments + shares) / sum(impressions), over the same rows with all four counts present and impressions > 0` : basis ? `sum(${basis} + comments + shares), only rows with all three counts present` : `sum(${id}), only rows with ${id} present`,
    aggregation: isRate(id) ? 'ratio_of_sums' : id === 'postCount' ? 'count' : 'sum',
    requiredFields: basis ? [basis, 'comments', 'shares', ...(isRate(id) ? ['impressions'] : [])] as CountMetric[] : id === 'postCount' ? [] : [id as CountMetric],
  };
}));

export function validateAnalysisRequest(input: AnalysisRequest): AnalysisRequest {
  const request = object(input, 'Analysis request');
  allowedKeys(request, ['metrics', 'groupBy', 'chart', 'dateRange', 'contentTypes', 'timezone', 'sort', 'limit'], 'Analysis request');
  if (!Array.isArray(request.metrics) || !request.metrics.length || request.metrics.length > METRIC_IDS.length || request.metrics.some(metric => !METRIC_IDS.includes(metric)) || new Set(request.metrics).size !== request.metrics.length) refuse('invalid_metrics', 'Select one or more distinct supported metric IDs.');
  if (!GROUPINGS.includes(request.groupBy as never)) refuse('invalid_grouping', 'Select a supported grouping.');
  if (!CHART_TEMPLATES.includes(request.chart as never)) refuse('invalid_chart', 'Select a supported chart template.');
  if (request.timezone !== undefined && request.timezone !== 'UTC') refuse('unsupported_timezone', 'This version supports UTC analysis only.');
  if (request.chart === 'scatter' && request.metrics.length < 2) refuse('invalid_chart', 'Scatter charts need at least two metrics.');
  let dateRange: AnalysisRequest['dateRange'];
  if (request.dateRange !== undefined) {
    const range = object(request.dateRange, 'Date range');
    allowedKeys(range, ['from', 'to'], 'Date range');
    if (range.from === undefined && range.to === undefined) refuse('invalid_date_range', 'A date range needs a from or to boundary.');
    for (const key of ['from', 'to'] as const) if (range[key] !== undefined && typeof range[key] !== 'string') refuse('invalid_date_range', 'Date boundaries must be ISO strings.');
    const from = range.from === undefined ? undefined : parseDate(range.from as string, true, 'from').iso;
    const to = range.to === undefined ? undefined : parseDate(range.to as string, true, 'to').iso;
    if (from && to && from >= to) refuse('invalid_date_range', 'The from boundary must precede the exclusive to boundary.');
    dateRange = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  }
  let contentTypes: string[] | undefined;
  if (request.contentTypes !== undefined) {
    if (!Array.isArray(request.contentTypes) || !request.contentTypes.length || request.contentTypes.length > 20 || Array.from(request.contentTypes).some(value => typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) || new Set(request.contentTypes).size !== request.contentTypes.length) refuse('invalid_content_types', 'Select 1–20 distinct exact content-type values, each 1–256 characters without control characters.');
    contentTypes = [...request.contentTypes].sort();
  }
  let sort: AnalysisRequest['sort'];
  if (request.sort !== undefined) {
    const value = object(request.sort, 'Sort');
    allowedKeys(value, ['metric', 'direction'], 'Sort');
    if (!request.metrics.includes(value.metric) || !['asc', 'desc'].includes(value.direction as string)) refuse('invalid_sort', 'Sort needs a metric included in metrics and direction asc or desc. When changing metrics, update sort too or explicitly clear sort and limit in a follow-up.');
    sort = { metric: value.metric as MetricId, direction: value.direction as 'asc' | 'desc' };
  }
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || (request.limit as number) < 1 || (request.limit as number) > 100 || !sort)) refuse('invalid_limit', 'Limit must be an integer from 1 to 100 with an explicit metric sort. Clear both sort and limit to return to unranked groups.');
  return { metrics: [...request.metrics] as MetricId[], groupBy: request.groupBy as AnalysisRequest['groupBy'], chart: request.chart as AnalysisRequest['chart'], timezone: 'UTC', ...(dateRange ? { dateRange } : {}), ...(contentTypes ? { contentTypes } : {}), ...(sort ? { sort } : {}), ...(request.limit !== undefined ? { limit: request.limit as number } : {}) };
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) refuse('aggregate_overflow', 'The selected count total exceeds the exact integer range. Use a smaller publication period.');
  }
  return total;
}

function aggregate(rows: readonly NormalizedRow[], metrics: readonly MetricId[]): { values: AnalysisValues; coverage: Partial<Record<MetricId, MetricCoverage>>; evidence: Partial<Record<MetricId, MetricEvidence>> } {
  const values: Partial<Record<MetricId, number | null>> = {}, coverage: Partial<Record<MetricId, MetricCoverage>> = {}, evidence: Partial<Record<MetricId, MetricEvidence>> = {};
  for (const metric of metrics) {
    const definition = METRIC_DEFINITIONS.find(item => item.id === metric)!;
    const eligible: NormalizedRow[] = [], missing: RowReference[] = [], excluded: RowReference[] = [];
    for (const row of rows) {
      if (definition.requiredFields.some(field => row.metrics[field] == null)) missing.push(row.provenance);
      else if (isRate(metric) && row.metrics.impressions === 0) excluded.push(row.provenance);
      else eligible.push(row);
    }
    if (metric === 'postCount') values[metric] = eligible.length;
    else if (!eligible.length) values[metric] = null;
    else if (interactionBasis(metric)) {
      const basis = interactionBasis(metric)!;
      const interactions = sum(eligible.map(row => sum([row.metrics[basis]!, row.metrics.comments!, row.metrics.shares!])));
      values[metric] = isRate(metric) ? (interactions / sum(eligible.map(row => row.metrics.impressions!))) * 100 : interactions;
    } else values[metric] = sum(eligible.map(row => row.metrics[metric as CountMetric]!));
    coverage[metric] = { totalRows: rows.length, eligibleRows: eligible.length, missingRows: missing.length, zeroDenominatorRows: excluded.length };
    evidence[metric] = { formula: definition.formula, eligible: eligible.map(row => row.provenance), missing, excluded };
  }
  return { values, coverage, evidence };
}

function groupKey(row: NormalizedRow, grouping: AnalysisRequest['groupBy'], missingContentType: string): string {
  if (grouping === 'post') return JSON.stringify([row.platform, row.account, row.postId]);
  if (grouping === 'platform') return row.platform;
  if (grouping === 'account') return JSON.stringify([row.platform, row.account]);
  if (grouping === 'contentType') return row.contentType ?? missingContentType;
  const date = new Date(row.publishedAt!);
  if (grouping === 'month') return date.toISOString().slice(0, 7);
  if (grouping === 'week') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/** Verify the stored immutable snapshot, so a stale or edited object cannot masquerade as imported data. */
function verifyDataset(dataset: NormalizedDataset): void {
  const value = object(dataset, 'Dataset');
  if (value.version !== TABULAR_VERSION || typeof value.hash !== 'string' || value.id !== `dataset_${value.hash}` || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > TABULAR_LIMITS.rows) refuse('invalid_dataset', 'Use a normalized CSV dataset from this version.');
  const { id: _id, hash: _hash, ...body } = value;
  if (contentHash(body) !== value.hash) refuse('dataset_integrity', 'The normalized dataset changed after import. Import the original CSV again.');
  if (dataset.metricSource !== undefined) {
    const source = validateMetricSource(dataset.metricSource, dataset.mapping);
    if (contentHash(dataset.timeBasis) !== contentHash(providerTimeBasis(source))) refuse('invalid_metric_source', 'The dataset time basis does not match its connector.');
  } else if (contentHash(dataset.timeBasis) !== contentHash(TIME_BASIS)) refuse('invalid_metric_source', 'Uploaded counts must retain their unknown counting period and measurement time.');
  // The hash detects accidental mutation, not authority. Still validate all execution-bearing fields.
  const identities = new Set<string>();
  for (const raw of value.rows) {
    const row = object(raw, 'Dataset row');
    if (typeof row.id !== 'string' || (row.account !== null && typeof row.account !== 'string') || typeof row.postId !== 'string' || typeof row.platform !== 'string' || (row.contentType !== null && typeof row.contentType !== 'string')) refuse('invalid_dataset', 'Dataset rows must have normalized identifiers.');
    const identity = JSON.stringify([row.platform, row.account, row.postId]);
    if (identities.has(identity)) refuse('duplicate_post', 'The dataset contains duplicate posts.');
    identities.add(identity);
    const counts = object(row.metrics, 'Dataset metrics');
    for (const metric of COUNT_METRICS) if (!(metric === 'saves' && !dataset.mapping.columns.saves && counts[metric] === undefined) && counts[metric] !== null && (typeof counts[metric] !== 'number' || !Number.isSafeInteger(counts[metric]) || (counts[metric] as number) < 0)) refuse('invalid_dataset', 'Dataset counts must be non-negative integers or null.');
    if (row.publishedAt !== null && (typeof row.publishedAt !== 'string' || parseDate(row.publishedAt, false, 'publishedAt').iso !== row.publishedAt)) refuse('invalid_dataset', 'Dataset publication dates must be normalized ISO timestamps.');
    const provenance = object(row.provenance, 'Row provenance');
    if (provenance.rowId !== row.id || provenance.sourceHash !== value.sourceHash || !Number.isInteger(provenance.record) || (provenance.record as number) < 2 || !Number.isInteger(provenance.line) || (provenance.line as number) < 2) refuse('invalid_dataset', 'Dataset source references are invalid.');
  }
}

export function analyzeDataset(dataset: NormalizedDataset, requestInput: AnalysisRequest): AnalysisResult {
  if (dataset.mapping.kind === 'source-table') refuse('unsupported_table_analysis', 'This source is synced and can be previewed or exported. Its native metric calculations are not available yet.');
  verifyDataset(dataset);
  const request = validateAnalysisRequest(requestInput);
  const dated = ['day', 'week', 'month'].includes(request.groupBy) || !!request.dateRange;
  const knownContentTypes = new Set(dataset.rows.map(row => row.contentType));
  const selectedContentTypes = request.contentTypes ? new Set(request.contentTypes) : undefined;
  if (selectedContentTypes) {
    if (!dataset.mapping.columns.contentType) refuse('unmapped_content_type', 'Content-type filtering requires a confirmed contentType column mapping.');
    if (request.contentTypes!.some(value => !knownContentTypes.has(value))) refuse('unknown_content_type', 'A requested content type is absent from this dataset. Select exact mapped values; aliases and missing-value labels are not inferred.');
  }
  let missingContentType = '(missing content type)';
  while (knownContentTypes.has(missingContentType)) missingContentType += ' (unmapped)';
  const excludedByDate: RowReference[] = [], excludedUndated: RowReference[] = [], excludedByContentType: RowReference[] = [], included: NormalizedRow[] = [];
  const groups = new Map<string, NormalizedRow[]>();
  for (const row of dataset.rows) {
    if (dated && row.publishedAt === null) { excludedUndated.push(row.provenance); continue; }
    if (row.publishedAt && ((request.dateRange?.from && row.publishedAt < request.dateRange.from) || (request.dateRange?.to && row.publishedAt >= request.dateRange.to))) { excludedByDate.push(row.provenance); continue; }
    if (selectedContentTypes && (row.contentType === null || !selectedContentTypes.has(row.contentType))) { excludedByContentType.push(row.provenance); continue; }
    included.push(row);
    const key = groupKey(row, request.groupBy, missingContentType);
    const values = groups.get(key) ?? []; values.push(row); groups.set(key, values);
  }
  const totals = aggregate(included, request.metrics);
  const grouped = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([group, rows]) => ({ group, ...aggregate(rows, request.metrics) }));
  // Rank only after calculating every group. Selection never changes the cohort
  // behind totals, metric coverage, warnings or exact source-row evidence.
  const ordered = request.sort ? [...grouped].sort((a, b) => {
    const left = a.values[request.sort!.metric] ?? null, right = b.values[request.sort!.metric] ?? null;
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    if (left !== null && right !== null && left !== right) return (left < right ? -1 : 1) * (request.sort!.direction === 'asc' ? 1 : -1);
    return a.group < b.group ? -1 : a.group > b.group ? 1 : 0;
  }) : grouped;
  const returned = request.limit === undefined ? ordered : ordered.slice(0, request.limit);
  const definitions = request.metrics.map(metric => providerMetricDefinition(METRIC_DEFINITIONS.find(definition => definition.id === metric)!, dataset.metricSource));
  const incomplete = request.metrics.filter(metric => totals.coverage[metric]!.missingRows || totals.coverage[metric]!.zeroDenominatorRows);
  const warnings = [...dataset.warnings,
    ...(incomplete.length ? [{ code: 'incomplete_metrics', message: `Some rows are missing or ineligible for ${incomplete.join(', ')}. Values use only each metric's eligible rows; inspect metric coverage and evidence.` }] : []),
    ...(excludedUndated.length ? [{ code: 'undated_excluded', message: `${excludedUndated.length} rows lack publication time and are excluded from this dated analysis.`, count: excludedUndated.length }] : []),
    ...(!included.length ? [{ code: 'empty_cohort', message: selectedContentTypes ? 'No rows match the selected content types and publication period. Metric totals remain missing; post count is zero.' : 'No rows match this publication period. Metric totals remain missing; post count is zero.' }] : []),
  ];
  let body: Omit<AnalysisResult, 'id' | 'hash'> = {
    version: TABULAR_VERSION, datasetId: dataset.id, datasetHash: dataset.hash, sourceHash: dataset.sourceHash, request,
    ...(dataset.metricSource ? { metricSource: dataset.metricSource } : {}),
    columns: [{ id: 'group', label: analysisColumnLabel({ id: 'group', label: request.groupBy }, request.groupBy), type: 'string' }, ...definitions.map(definition => ({ id: definition.id, label: definition.label, type: 'number' as const, unit: definition.unit }))],
    rows: returned.map(group => ({ group: group.group, ...group.values })), totals: totals.values, metricCoverage: totals.coverage, definitions,
    ...(request.sort ? { selection: { totalGroups: grouped.length, returnedGroups: returned.length, omittedGroups: grouped.length - returned.length, totalsScope: 'full_cohort' as const, evidenceScope: 'full_cohort' as const, tieBreak: 'group_ascending' as const, missingValues: 'last' as const } } : {}),
    evidence: { totals: totals.evidence, groups: grouped.map(group => ({ group: group.group, metrics: group.evidence })), excludedByDate, excludedUndated, ...(selectedContentTypes ? { excludedByContentType } : {}) },
    counts: { inputRows: dataset.rows.length, includedRows: included.length, excludedByDate: excludedByDate.length, excludedUndated: excludedUndated.length, ...(selectedContentTypes ? { excludedByContentType: excludedByContentType.length } : {}) }, warnings, timeBasis: dataset.timeBasis,
  };
  // Evidence appears once per metric and group: a small CSV can produce a much larger
  // report. Measure the exact final JSON shape before hashing, persisting or returning it.
  // Placeholder identities have the same byte length as the real SHA-256 identities.
  const resultBytes = () => Buffer.byteLength(JSON.stringify({ ...body, hash: HASH_SIZE_PLACEHOLDER, id: `analysis_${HASH_SIZE_PLACEHOLDER}` }), 'utf8');
  // Preserve existing small-result hashes. Large results keep every evidence row.
  if (resultBytes() > MAX_RESULT_BYTES) body = {...body,evidence:compactEvidence(body.evidence,dataset.sourceHash)};
  if (resultBytes() > MAX_RESULT_BYTES) refuse('analysis_result_limit', 'This analysis exceeds the 4 MiB saved-result limit. No values or evidence were truncated or saved. Choose fewer metrics or a narrower publication-date window, then retry. Do not silently narrow the user\'s requested scope. Ask which metrics or publication window to use.');
  const hash = contentHash(body);
  return freeze({ ...body, hash, id: `analysis_${hash}` });
}
