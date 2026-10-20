import type { Run, Source } from '../../../packages/core/src/types';
import { estimateText } from '../../../packages/core/src/answers';
import type { VerificationItem } from './verification-summary';

const dateLabel = (value: string) => value.replace(/T00:00:00(?:\.000)?Z$/, '');
const range = (dates?: { from?: string; to?: string }) => dates
  ? `${dates.from ? dateLabel(dates.from) : 'Start of saved data'} (inclusive) to ${dates.to ? dateLabel(dates.to) : 'end of saved data'}${dates.to ? ' (exclusive)' : ''}`
  : 'All records in the saved data';

/** Read saved facts only. Input completeness is not whole-account coverage or claim verification. */
export function calculationItems(run: Run, sources: Map<string, Source>): VerificationItem[] | undefined {
  const output = run.result ?? run.reply;
  if (!output) return;
  const link = (sourceId: string | null) => sourceId && sources.has(sourceId) ? { sourceId } : {};
  const receipt = (sourceId: string, technical: string): VerificationItem => ({
    id: 'calculation-provenance', title: 'Saved calculation', status: sources.has(sourceId) ? 'recorded' : 'warning',
    evidence: sources.has(sourceId) ? `Saved as ${sources.get(sourceId)!.title}. Opening it requires current workspace access.` : 'The saved calculation is attached, but its source link is unavailable.',
    technical, ...link(sourceId),
  });
  const tabular = output.tabularAnalysis;
  if (tabular) {
    const result = tabular.result;
    return [
      ...result.definitions.map((metric): VerificationItem => ({ id: `metric:${metric.id}`, title: metric.label, status: 'recorded',
        evidence: `Saved value: ${result.totals[metric.id] ?? 'Unknown'} (${metric.unit}).\nCalculation: ${metric.formula}${metric.countingPeriod ? '\nLifetime counter, not activity earned within the selected dates.' : ''}`, ...link(tabular.sourceId) })),
      ...result.definitions.map((metric): VerificationItem => {
        const coverage = result.metricCoverage[metric.id];
        return { id: `inputs:${metric.id}`, title: `${metric.label}: required inputs`,
          status: !coverage ? 'not-checked' : !coverage.totalRows || coverage.missingRows || coverage.zeroDenominatorRows ? 'warning' : 'passed',
          evidence: coverage ? `${coverage.eligibleRows} of ${coverage.totalRows} selected rows have usable inputs. ${coverage.missingRows} missing; ${coverage.zeroDenominatorRows} with a zero denominator.\nThis checks the selected rows only. It does not establish that the source contains every relevant record.` : 'Input coverage was not recorded.', ...link(tabular.sourceId) };
      }),
      { id: 'calculation-dates', title: 'Dates and measurement', status: 'recorded',
        evidence: `Date filter: ${range(result.request.dateRange)}.\nDates refer to ${result.timeBasis.grouping === 'publication_time' ? 'post publication' : 'source reporting periods'}; timezone: ${result.timeBasis.timezone}.\nMetric observation time: ${result.timeBasis.observedAt ?? 'unknown'}. Import time is not measurement time.\n${result.timeBasis.description}` },
      { id: 'calculation-scope', title: 'Included and excluded data', status: 'recorded',
        evidence: `${result.counts.includedRows} of ${result.counts.inputRows} rows included. ${result.counts.excludedByDate} outside the dates; ${result.counts.excludedUndated} without a usable date; ${result.counts.excludedByContentType ?? 0} excluded by content type.\n${result.selection ? `${result.selection.returnedGroups} of ${result.selection.totalGroups} groups displayed. Totals retain the full filtered set.` : 'Totals use the filtered set, not just the visible page.'}` },
      { id: 'calculation-coverage', title: 'Requested period coverage', status: 'not-checked',
        evidence: 'A date filter selects saved rows; it does not prove that every day or every post in the requested period was collected.' },
      ...result.warnings.map((warning, index): VerificationItem => ({ id: `limit:${index}`, title: 'Data limitation', status: 'warning', evidence: warning.message })),
      receipt(tabular.sourceId, `Calculation: ${result.id}\nDataset: ${result.datasetId}\nDataset hash: ${result.datasetHash}\nSource hash: ${result.sourceHash}\nVersion: ${result.version}`),
    ];
  }
  const native = output.sourceAnalysis;
  if (native) {
    const result = native.result;
    const metrics = result.metric ? [result.metric] : result.metrics;
    const items: VerificationItem[] = metrics.map((metric, index) => ({ id: `metric:${index}:${metric.id}`, title: metric.label, status: 'recorded',
      evidence: `Unit: ${metric.unit}. Measurement: ${metric.basis === 'lifetime' ? 'lifetime counter at collection' : 'provider reporting period'}.\nCan be added across records: ${metric.additive ? 'yes' : 'no'}.`, technical: `Provider field: ${metric.sourceField}`, ...link(native.sourceId) }));
    for (const [index, observation] of result.observations.entries()) {
      items.push({ id: `observation:${index}`, title: sources.get(observation.sourceId ?? '')?.title ?? observation.provider,
        status: observation.capped || observation.coverage === 'partial' ? 'warning' : observation.coverage === 'unknown' ? 'not-checked' : 'recorded',
        evidence: `Collected: ${observation.observedAt}. Provider measurement time: ${observation.providerMeasuredAt ?? 'unknown'}.\nCollected window: ${observation.coverage}${observation.capped ? ', capped' : ''}; ${observation.recordCount} records. This does not establish whole-account or requested-period coverage.`,
        technical: `Account: ${observation.accountId}\nObservation: ${observation.id}\nBatch: ${observation.rawBatchId}\nSource hash: ${observation.sourceHash}`, ...link(observation.sourceId) });
    }
    if (result.operation === 'review') {
      items.push({ id: 'metric-inputs', title: 'Required metric inputs', status: !result.totals.records || result.totals.missingRecords ? 'warning' : 'passed',
        evidence: `${result.totals.records - result.totals.missingRecords} of ${result.totals.records} selected records contain ${result.metric.label}. Missing values are not zero.\nSaved total: ${result.totals.value ?? 'Unknown or not additive'}. ${result.totals.nonAdditive ? 'A combined total is withheld because this metric cannot be added across records.' : ''}`, ...link(native.sourceId) },
      { id: 'calculation-dates', title: 'Dates and measurement', status: 'recorded',
        evidence: `Date filter: ${range(result.request.dateRange)}.\nDates refer to ${result.dateBasis === 'provider_period' ? 'provider reporting days' : 'content publication'}; timezone: ${result.timezone ?? 'unknown'}.\n${result.counts.excludedByDate} records outside dates; ${result.counts.excludedUndated} without a usable date.\n${result.counts.returnedGroups} of ${result.counts.totalGroups} groups displayed; totals retain the full filtered set.` });
    } else if (result.operation === 'compare') {
      items.push({ id: 'counter-comparison', title: 'Snapshot comparison', status: 'recorded',
        evidence: `${result.matchedRecords} matched records. Net counter change: ${result.matchedNetChange ?? 'Unknown'}.\nCompares the collection times shown above. This is not a complete log of activity between those times.` },
      { id: 'metric-inputs', title: 'Matched metric inputs', status: !result.matchedRecords || result.rows.some(row => row.status !== 'matched') ? 'warning' : 'passed',
        evidence: `${result.matchedRecords} of ${result.rows.length} records have comparable values in both snapshots. New, absent and missing records are not treated as zero.`, ...link(native.sourceId) });
    } else {
      const explicit = result.request.on.kind === 'explicit';
      items.push({ id: 'relationships', title: 'How records were paired', status: explicit ? 'not-checked' : 'recorded',
        evidence: explicit ? 'Caller-supplied record pairs. These relationships have not been independently verified as campaign or registration links.'
          : result.request.on.kind === 'identity' ? 'Matched stable record IDs within the same provider and account. This is not registration attribution.'
            : 'Matched reporting date, timezone and channel. Records sharing a period do not establish campaign attribution.' },
      { id: 'metric-inputs', title: 'Paired metric inputs', status: !result.eligiblePairs || result.missingPairs || result.unmatchedLeft || result.unmatchedRight ? 'warning' : 'passed',
        evidence: `${result.eligiblePairs} complete pairs; ${result.missingPairs} with missing metrics. ${result.unmatchedLeft} unmatched records on the left; ${result.unmatchedRight} on the right. Excluded records are not zero.`, ...link(native.sourceId) });
      if (result.operation === 'correlate') items.push({ id: 'correlation', title: 'Correlation', status: result.correlation == null ? 'warning' : 'recorded',
        evidence: `Pearson correlation: ${result.correlation ?? 'Not calculable'}. Association is not causation; no significance test was performed.` });
    }
    items.push(...result.warnings.map((warning, index): VerificationItem => ({ id: `limit:${index}`, title: 'Data limitation', status: 'warning', evidence: warning })),
      receipt(native.sourceId, `Calculation: ${result.id}\nRequest: ${JSON.stringify(result.request)}`));
    return items;
  }
  const answer = output.answer;
  if (answer?.kind === 'hypothetical' && answer.estimate) return [
    { id: 'estimate', title: 'Hypothetical calculation', status: 'recorded', evidence: estimateText(answer.estimate) },
    { id: 'assumptions', title: 'Assumptions', status: 'recorded', evidence: answer.estimate.assumptions.join('\n') },
    { id: 'estimate-inputs', title: 'Input provenance', status: 'not-checked', evidence: 'The saved base and rate are assumptions for this estimate, not verified registration measurements. A correct percentage calculation does not verify those assumptions.' },
  ];
  if (answer?.kind === 'missing-data') return [{ id: 'missing-inputs', title: 'Reported missing data', status: 'warning',
    evidence: `${answer.missing?.join('\n') ?? 'Missing inputs were not listed.'}\nThese gaps were reported in the answer; no independent completeness check ran.` }];
}
