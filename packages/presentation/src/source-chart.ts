import type { SourceAnalysis } from '../../core/src/source-analysis';
import { tabularValue, type TabularChartOption } from './tabular-chart';

export type Result = SourceAnalysis['result'];
export type SourceChartKind = 'horizontalBar' | 'bar' | 'line' | 'area' | 'scatter' | 'table';
export type Evidence = { observationId: string; rawBatchId: string; sourceId: string | null; sourceHash: string; recordId: string };
export interface DisplayRow { key: string; label: string; values: (number | null)[]; evidence: Evidence[]; date?: string; }
export function sourceChartRows(result: Result): DisplayRow[] {
  if (result.operation === 'review') return result.rows.map(row => ({ key: row.group, label: row.text || row.group,
    values: [row.value], evidence: row.evidence, ...(result.request.groupBy === 'day' ? { date: row.group } : {}) }));
  if (result.operation === 'compare') return result.rows.map(row => ({ key: row.recordId, label: row.recordId,
    values: [row.before, row.after, row.delta], evidence: row.evidence.filter((value): value is Evidence => value !== null) }));
  return result.rows.map(row => ({ key: JSON.stringify([row.leftRecordId, row.rightRecordId]), label: `${row.leftRecordId} / ${row.rightRecordId}`,
    values: [row.left, row.right], evidence: row.evidence }));
}
export function chronological(result: Result) {
  return result.operation === 'review' && result.request.groupBy === 'day' && result.counts.returnedGroups === result.counts.totalGroups
    && result.rows.length <= 50 && result.rows.every(row => /^\d{4}-\d{2}-\d{2}$/.test(row.group));
}
export function sourceChartChoices(result: Result): SourceChartKind[] {
  if (result.operation === 'join' || result.operation === 'correlate') return ['scatter', 'table'];
  return ['horizontalBar', 'bar', ...(chronological(result) ? ['line', 'area'] as const : []), 'table'];
}
export function recommendedSourceChart(result: Result): SourceChartKind {
  if (result.operation === 'review') {
    if (!result.rows.some(row => row.value !== null)) return 'table';
    if (chronological(result) && result.rows.length > 1) return 'line';
    return 'horizontalBar';
  }
  if (result.operation === 'compare') return result.rows.some(row => row.delta !== null) ? 'horizontalBar' : 'table';
  return result.eligiblePairs >= 3 ? 'scatter' : 'table';
}
export function columns(result: Result) {
  return result.operation === 'review' ? [result.metric.label] : result.operation === 'compare'
    ? ['Before', 'After', 'Net change'] : result.metrics.map((metric, index) => `${index === 0 ? 'Left' : 'Right'}: ${metric.label}`);
}
export function title(result: Result) {
  return result.operation === 'review' ? result.metric.label : result.operation === 'compare'
    ? `${result.metric.label}: matched counter change` : result.metrics.map(metric => metric.label).join(' / ');
}
export function sourceReportTitle(result: Result): string {
  const providers = new Set(result.observations.map(item => item.provider));
  if (providers.size === 1 && providers.has('google-analytics')) return 'Website performance';
  if (providers.size === 1 && providers.has('mailchimp')) return 'Email performance';
  if (providers.size && [...providers].every(provider => ['facebook', 'instagram', 'youtube'].includes(provider))) return 'Social performance';
  return providers.size > 1 ? 'Social & data review' : 'Source performance';
}
export function displayedRows(result: Result, kind: SourceChartKind) {
  const rows = sourceChartRows(result);
  return kind === 'line' || kind === 'area' ? rows.sort((a, b) => a.key.localeCompare(b.key)) : rows;
}
export function sourceChartOption(result: Result, kind: Exclude<SourceChartKind, 'table'>): TabularChartOption {
  const rows = displayedRows(result, kind).slice(0, 50), names = columns(result);
  const common: TabularChartOption = { animation: false, backgroundColor: '#fff', color: ['#5d83d5', '#47958a'],
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: '#444', fontSize: 12 },
    grid: { left: 12, right: 12, top: 24, bottom: 16, outerBoundsMode: 'same', outerBoundsContain: 'all' },
    aria: { enabled: true, label: { description: `${title(result)}. Exact saved values and source evidence follow in the table.` } },
    // Rich text stays inside SVG/canvas text, never interpreted as HTML.
    tooltip: { trigger: 'item', renderMode: 'richText', confine: true, formatter: params => {
      const point = params as { data?: { rowIndex?: number }; dataIndex?: number };
      const index = point.data?.rowIndex ?? point.dataIndex;
      const row = typeof index === 'number' ? rows[index] : undefined;
      return row ? [`Record ${index! + 1}`, ...names.map((name, i) => `${name}: ${tabularValue(row.values[i])}`)].join('\n') : '';
    } },
  };
  const axis = (name: string) => ({ type: 'value' as const, name: `${name} (count)`, nameLocation: 'middle' as const, nameGap: 15, nameMoveOverlap: true,
    splitLine: { lineStyle: { color: '#e8e8e8' } } });
  if (kind === 'scatter') return { ...common, xAxis: axis(names[0]!), yAxis: axis(names[1]!),
    series: [{ type: 'scatter', symbolSize: 10, data: rows.flatMap((row, rowIndex) => row.values[0] === null || row.values[1] === null
      ? [] : [{ value: [row.values[0]!, row.values[1]!], rowIndex }]) }] };
  const valueIndex = result.operation === 'compare' ? 2 : 0;
  const temporal = kind === 'line' || kind === 'area';
  const labels = rows.map((row, index) => temporal ? row.date! : `Record ${index + 1}`);
  if (temporal) {
    // Missing calendar days are unknown, not zero; break the line across gaps.
    const data = rows.flatMap((row, index) => {
      const date = Date.parse(row.date!), previous = rows[index - 1]?.date;
      return [...(previous && date - Date.parse(previous) > 86_400_000 ? [{ value: [date - 1, null], rowIndex: -1 }] : []), { value: [date, row.values[0]], rowIndex: index }];
    });
    return { ...common, useUTC: true, xAxis: { type: 'time', name: result.operation === 'review' && result.dateBasis === 'provider_period' ? 'Reporting day' : 'Publication day (UTC)', nameLocation: 'middle', nameGap: 15, nameMoveOverlap: true },
      yAxis: axis(names[0]!), series: [{ type: 'line', data, connectNulls: false, symbolSize: 6, ...(kind === 'area' ? { areaStyle: { opacity: 0.16 } } : {}) }] };
  }
  const category = { type: 'category' as const, data: labels, axisLabel: { hideOverlap: true }, ...(kind === 'horizontalBar' ? { inverse: true } : {}) };
  return { ...common, xAxis: kind === 'horizontalBar' ? axis(names[valueIndex]!) : category,
    yAxis: kind === 'horizontalBar' ? category : axis(names[valueIndex]!),
    series: [{ type: 'bar', barMaxWidth: 32, data: rows.map(row => row.values[valueIndex]) }] };
}
