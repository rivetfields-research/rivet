import type { ChartTemplate, MetricId } from '../../data-layer/src/tabular/types';
import { TABULAR_CHART_LIMIT, labelFor, tabularChartLabels, tabularGroupLabel, tabularValue, valueOf, type PresentedResult } from './tabular-chart';

export function initialTabularView(result: PresentedResult, metric: MetricId): ChartTemplate {
  return result.request.chart === 'table' && result.rows.slice(0, TABULAR_CHART_LIMIT).some(row => valueOf(row, metric) !== null)
    ? 'bar' : result.request.chart;
}

/** Describe only the saved calculation, never infer performance benchmarks or causation. */
export function tabularInterpretation(result: PresentedResult, metric: MetricId): string {
  if (!result.counts.includedRows) return 'No source rows matched these dates and filters. This is not a measured zero.';
  const column = result.columns.find(item => item.id === metric);
  const total = result.totals[metric], label = labelFor(result, metric);
  const coverage = result.metricCoverage[metric];
  if (total == null || !Number.isFinite(total)) return `${label} could not be calculated from the available inputs. Missing values are unknown, not zero.`;
  const definition = result.definitions.find(item => item.id === metric);
  const eligible = coverage?.eligibleRows;
  const scope = eligible === undefined ? 'the included source rows'
    : `${eligible.toLocaleString('en-US')} ${eligible === 1 ? 'source row with' : 'source rows with'} the required inputs`;
  const sentences = [`${label}${column?.unit === 'percent' ? ' is' : ' total'} ${tabularValue(total, column?.unit)} across ${scope}.`];
  if (definition?.aggregation === 'ratio_of_sums') {
    sentences.push(metric === 'engagementRate' || metric === 'reactionEngagementRate'
      ? `It uses total ${metric === 'reactionEngagementRate' ? 'reactions' : 'likes'}, comments and shares divided by total impressions, not an average of individual post rates.`
      : 'This is a ratio of totals, not an average of individual post rates.');
  }
  const available = result.rows.filter(row => valueOf(row, metric) !== null);
  if (available.length > 1) {
    const maximum = Math.max(...available.map(row => valueOf(row, metric)!));
    const leaders = available.filter(row => valueOf(row, metric) === maximum);
    const groups = `${available.length.toLocaleString('en-US')} saved groups with a value`;
    if (leaders.length === available.length) sentences.push(`All ${groups} have the same recorded value: ${tabularValue(maximum, column?.unit)}.`);
    else if (leaders.length > 1) sentences.push(`${leaders.length.toLocaleString('en-US')} of ${groups} tie for the highest recorded ${label.toLowerCase()} (${tabularValue(maximum, column?.unit)}).`);
    else {
      const index = result.rows.indexOf(leaders[0]);
      const display = tabularGroupLabel(result, leaders[0].group).label;
      const key = tabularChartLabels(result)[index];
      sentences.push(`Among ${groups}, ${display}${key !== display ? ` (${key})` : ''} has the highest recorded ${label.toLowerCase()} (${tabularValue(maximum, column?.unit)}).`);
    }
  }
  if (coverage && (coverage.missingRows || coverage.zeroDenominatorRows)) {
    const excluded = coverage.missingRows + coverage.zeroDenominatorRows;
    sentences.push(`${excluded.toLocaleString('en-US')} included source ${excluded === 1 ? 'row' : 'rows'} could not contribute to this metric; missing inputs are not zero.`);
  }
  if (result.selection?.omittedGroups) sentences.push('The total includes groups outside this selection.');
  if (definition?.unit === 'count' && definition.aggregation === 'sum') {
    sentences.push(result.timeBasis.metricObservation === 'api_lifetime_counts'
      ? 'These are lifetime counts for the selected posts, not activity earned within the selected dates.'
      : 'These source counts may be lifetime values, not activity earned within the selected dates.');
  }
  return sentences.join(' ');
}
