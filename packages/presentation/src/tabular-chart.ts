import type { ComposeOption } from 'echarts/core';
import type { BarSeriesOption, LineSeriesOption, ScatterSeriesOption } from 'echarts/charts';
import type { AriaComponentOption, GridComponentOption, LegendComponentOption, TooltipComponentOption } from 'echarts/components';
import type { AnalysisResult, AnalysisTableRow, ChartTemplate, MetricId } from '../../data-layer/src/tabular/types';
import { groupPresentation, type PostPresentation } from '../../data-layer/src/tabular/post-presentation';
import { GROUP_LABELS } from '../../data-layer/src/tabular/labels';
export { GROUP_LABELS } from '../../data-layer/src/tabular/labels';
export type PresentedResult = AnalysisResult & { readonly postLabels?: ReadonlyMap<string, PostPresentation> };

export const TABULAR_CHART_LIMIT = 50;
// A metric keeps its color as users switch views; labels, shapes and axes also
// distinguish series, so interpretation never depends on color alone.
export const METRIC_COLORS: Partial<Record<MetricId, string>> = { likes: '#5d83d5', reactions: '#8871b1', comments: '#47958a', shares: '#b56789', impressions: '#4d70b4', clicks: '#36839b', saves: '#7a8a49', interactions: '#5d83d5', engagementRate: '#5d83d5', postCount: '#677b90', reactionInteractions: '#8871b1', reactionEngagementRate: '#5d83d5' };
export function tabularMetricColor(metric: MetricId): string { return METRIC_COLORS[metric] ?? '#5d83d5'; }
export const CHARTS: readonly { id: ChartTemplate; label: string }[] = [{ id: 'bar', label: 'Bar' }, { id: 'horizontalBar', label: 'Horizontal bar' }, { id: 'line', label: 'Line' }, { id: 'area', label: 'Area' }, { id: 'combo', label: 'Bar + line' }, { id: 'scatter', label: 'Scatter' }, { id: 'table', label: 'Table' }];
export type NumericColumn = AnalysisResult['columns'][number] & { id: MetricId };
export type TabularChartOption = ComposeOption<BarSeriesOption | LineSeriesOption | ScatterSeriesOption | GridComponentOption | LegendComponentOption | AriaComponentOption | TooltipComponentOption>;
export interface Selection { readonly group: string | null; readonly metric: MetricId }
export function numericColumns(result: AnalysisResult): readonly NumericColumn[] { return result.columns.filter((column): column is NumericColumn => column.id !== 'group' && column.type === 'number'); }
export function labelFor(result: AnalysisResult, metric: MetricId): string { return result.columns.find(column => column.id === metric)?.label ?? metric; }
export function tabularGroupLabel(result: PresentedResult, group: string): { label: string; context?: string; postId?: string; url?: string } {
  return groupPresentation(result, group, result.postLabels);
}
/** Display keys belong to this immutable result order, never replace source IDs. */
export function tabularChartLabels(result: AnalysisResult): readonly string[] {
  if (result.request.groupBy === 'post') return result.rows.map((_, index) => `Post ${index + 1}`);
  const labels = result.rows.map(row => tabularGroupLabel(result, row.group).label);
  // If any label needs shortening, key the whole set so a real "Group 1" value
  // cannot collide with an abbreviated label. Full names stay in the table.
  const needsKeys = labels.some(label => [...label].length > 16 || /[\r\n\t]/.test(label)) || new Set(labels).size !== labels.length;
  return needsKeys ? labels.map((_, index) => `Group ${index + 1}`) : labels;
}
export function chartLabelNote(result: AnalysisResult): string {
  const labels = tabularChartLabels(result);
  return labels.some((label, index) => label !== tabularGroupLabel(result, result.rows[index].group).label)
    ? `${result.request.groupBy === 'post' ? 'Post' : 'Group'} labels match the complete data table and calculation evidence. ` : '';
}

/** A display label is never used to find source evidence. Scatter keeps its original row index after dropping missing points. */
export function tabularChartSelection(result: AnalysisResult, kind: Exclude<ChartTemplate, 'table'>, metric: MetricId, secondary: MetricId | undefined, event: unknown): Selection | null {
  const point = event as { componentType?: string; dataIndex?: number; seriesIndex?: number; data?: { rowIndex?: number } } | null;
  if (point?.componentType !== 'series') return null;
  const index = kind === 'scatter' ? point.data?.rowIndex : point.data?.rowIndex ?? point.dataIndex;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= Math.min(TABULAR_CHART_LIMIT, result.rows.length)) return null;
  return { group: result.rows[index].group, metric: kind === 'combo' && point.seriesIndex === 1 && secondary ? secondary : metric };
}
export function tabularValue(value: number | null | undefined, unit?: 'count' | 'percent'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value)}${unit === 'percent' ? '%' : ''}`;
}
export function valueOf(row: AnalysisTableRow, metric: MetricId): number | null { const value = row[metric]; return typeof value === 'number' && Number.isFinite(value) ? value : null; }
export type GraphKind = Exclude<ChartTemplate, 'table'>;
export function timelineRows(result: AnalysisResult): { date: number; rowIndex: number }[] | null {
  const grouping = result.request.groupBy;
  if (!['day', 'week', 'month'].includes(grouping) || result.request.sort) return null;
  const rows = result.rows.slice(0, TABULAR_CHART_LIMIT);
  if (!rows.every(row => (grouping === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(row.group))) return null;
  return rows.flatMap((row, rowIndex) => {
    const date = Date.parse(`${row.group}${grouping === 'month' ? '-01' : ''}T00:00:00Z`);
    if (!rowIndex) return [{ date, rowIndex }];
    const previous = new Date(`${rows[rowIndex - 1].group}${grouping === 'month' ? '-01' : ''}T00:00:00Z`);
    if (grouping === 'month') previous.setUTCMonth(previous.getUTCMonth() + 1);
    else previous.setUTCDate(previous.getUTCDate() + (grouping === 'week' ? 7 : 1));
    // A break represents an unobserved interval, not a fabricated zero or evidence row.
    return [...(date > previous.getTime() ? [{ date: previous.getTime(), rowIndex: -1 }] : []), { date, rowIndex }];
  });
}
export function renderedRowIndexes(result: AnalysisResult, kind: GraphKind, metric: MetricId, secondary?: MetricId): number[] {
  return (kind === 'line' || kind === 'area' || kind === 'combo' ? timelineRows(result)?.map(row => row.rowIndex) : undefined)
    ?? tabularChartRowIndexes(result, kind, metric, secondary);
}
export interface ChartPoint { readonly rowIndex: number; readonly metric: MetricId }
export function chartMetrics(kind: GraphKind, metric: MetricId, secondary?: MetricId): MetricId[] {
  return (kind === 'combo' || kind === 'scatter') && secondary && secondary !== metric ? [metric, secondary] : [metric];
}
export function tabularChartRowIndexes(result: AnalysisResult, kind: GraphKind, metric: MetricId, secondary?: MetricId): number[] {
  return result.rows.slice(0, TABULAR_CHART_LIMIT).flatMap((row, index) => kind === 'scatter' && (!secondary || valueOf(row, metric) === null || valueOf(row, secondary) === null) ? [] : [index]);
}
export function tabularChartKeyboardPoint(result: AnalysisResult, kind: GraphKind, metric: MetricId, secondary: MetricId | undefined, current: ChartPoint | null, key: string): ChartPoint | null {
  const indexes = tabularChartRowIndexes(result, kind, metric, secondary), metrics = chartMetrics(kind, metric, secondary);
  if (!indexes.length) return null;
  let row = Math.max(0, indexes.indexOf(current?.rowIndex ?? indexes[0])), column = Math.max(0, metrics.indexOf(current?.metric ?? metric));
  if (key === 'Home') row = 0;
  else if (key === 'End') row = indexes.length - 1;
  else if (key === 'ArrowRight') row = Math.min(indexes.length - 1, row + 1);
  else if (key === 'ArrowLeft') row = Math.max(0, row - 1);
  else if (key === 'ArrowDown') column = Math.min(metrics.length - 1, column + 1);
  else if (key === 'ArrowUp') column = Math.max(0, column - 1);
  return { rowIndex: indexes[row], metric: metrics[column] };
}
export function tabularChartPreview(result: AnalysisResult, rowIndex: number, metrics: readonly MetricId[]) {
  const row = result.rows[rowIndex];
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= TABULAR_CHART_LIMIT || !row) return null;
  const group = tabularGroupLabel(result, row.group), key = tabularChartLabels(result)[rowIndex];
  return { label: key === group.label ? group.label : `${key} · ${group.label}`, context: group.context,
    values: [...new Set(metrics)].map(id => {
      const column = result.columns.find(item => item.id === id);
      return { id, label: column?.label ?? id, value: valueOf(row, id) === null ? 'Missing / undefined' : tabularValue(valueOf(row, id), column?.unit) };
    }),
  };
}
export function escapeTooltipText(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
/** Ignore formatter-supplied values and markup; look up the immutable saved row. */
export function tabularChartTooltip(result: AnalysisResult, kind: GraphKind, metric: MetricId, secondary: MetricId | undefined, params: unknown): string {
  const points = Array.isArray(params) ? params : [params];
  const selections = points.map(point => tabularChartSelection(result, kind, metric, secondary, point)).filter((point): point is Selection => point !== null);
  if (!selections.length) return '';
  const rowIndex = result.rows.findIndex(row => row.group === selections[0].group);
  const metrics = kind === 'scatter' ? chartMetrics(kind, metric, secondary) : selections.filter(point => point.group === selections[0].group).map(point => point.metric);
  const preview = tabularChartPreview(result, rowIndex, metrics);
  if (!preview) return '';
  return `<div class="tabular-tooltip-content"><strong>${escapeTooltipText(preview.label)}</strong>${preview.context ? `<small>${escapeTooltipText(preview.context)}</small>` : ''}${preview.values.map(value => `<div class="tabular-tooltip-value"><span>${escapeTooltipText(value.label)}</span><b>${escapeTooltipText(value.value)}</b></div>`).join('')}</div>`;
}
export function tabularChartTitle(result: AnalysisResult, kind: ChartTemplate, metric: MetricId, secondary?: MetricId): string {
  return kind === 'scatter' && secondary ? `${labelFor(result, metric)} and ${labelFor(result, secondary)}`
    : `${labelFor(result, metric)}${kind === 'combo' && secondary && secondary !== metric ? ` and ${labelFor(result, secondary)}` : ''} by ${GROUP_LABELS[result.request.groupBy]}`;
}

export function tabularDateBasis(result: AnalysisResult): string {
  const range = result.request.dateRange;
  const dateLabel = (value: string) => value.replace(/T00:00:00\.000Z$/, '');
  return range?.from || range?.to
    ? `Publication dates: ${range.from ? `${dateLabel(range.from)} (inclusive)` : 'start of source'} to ${range.to ? `${dateLabel(range.to)} (exclusive)` : 'end of source'} · UTC`
    : 'Publication dates: all dates in the source · UTC';
}
export function tabularFilterBasis(result: AnalysisResult): string {
  return result.request.contentTypes ? `Content types: ${result.request.contentTypes.map(value => JSON.stringify(value)).join(', ')} · exact values` : '';
}
export function tabularAxisValue(value: number, unit?: 'count' | 'percent'): string {
  const text = new Intl.NumberFormat('en-US', Math.abs(value) >= 10_000
    ? { notation: 'compact', maximumFractionDigits: 2 }
    : { maximumFractionDigits: 4, ...(value !== 0 && Math.abs(value) < 0.0001 ? { notation: 'scientific', maximumSignificantDigits: 3 } : {}) }).format(value);
  return `${text}${unit === 'percent' ? '%' : ''}`;
}
export function metricAxisLabel(result: AnalysisResult, metric: MetricId): string {
  const column = result.columns.find(item => item.id === metric);
  return `${column?.label ?? metric} (${column?.unit === 'percent' ? '%' : 'count'})`;
}
export function chartScope(result: AnalysisResult): string {
  const capped = result.rows.length > TABULAR_CHART_LIMIT ? `Showing the first ${TABULAR_CHART_LIMIT} of ${result.rows.length.toLocaleString()} saved groups. The table and CSV contain every saved group. ` : '';
  return `${tabularSelectionBasis(result)}${result.selection ? ' ' : ''}${capped}`;
}
export function tabularSelectionBasis(result: AnalysisResult): string {
  if (!result.selection || !result.request.sort) return '';
  return `${result.selection.returnedGroups.toLocaleString()} of ${result.selection.totalGroups.toLocaleString()} groups, ranked by ${labelFor(result, result.request.sort.metric)} (${result.request.sort.direction === 'desc' ? 'highest first' : 'lowest first'}). Totals cover all ${result.counts.includedRows.toLocaleString()} included source rows, not just the displayed groups.`;
}

/** Chart display only: all numeric points are copied from immutable server result cells. */
export function tabularChartOption(result: AnalysisResult, kind: Exclude<ChartTemplate, 'table'>, metric: MetricId, secondary?: MetricId): TabularChartOption {
  const rows = result.rows.slice(0, TABULAR_CHART_LIMIT), labels = tabularChartLabels(result).slice(0, TABULAR_CHART_LIMIT), column = result.columns.find(item => item.id === metric);
  const other = secondary ? result.columns.find(item => item.id === secondary) : undefined;
  const overlay = kind === 'combo' && secondary === metric;
  const timeline = kind === 'line' || kind === 'area' || kind === 'combo' ? timelineRows(result) : null;
  const data = (id: MetricId) => timeline ? timeline.map(point => ({ value: [point.date, point.rowIndex < 0 ? null : valueOf(rows[point.rowIndex], id)], rowIndex: point.rowIndex })) : rows.map(row => valueOf(row, id));
  const primaryColor = tabularMetricColor(metric);
  const secondaryColor = secondary ? tabularMetricColor(secondary) : '#b96b35';
  const colors = [primaryColor, secondaryColor === primaryColor ? (primaryColor === '#b96b35' ? '#7963b5' : '#b96b35') : secondaryColor];
  const common: TabularChartOption = {
    animation: false, backgroundColor: '#ffffff', color: colors,
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: '#444444', fontSize: 12 },
    aria: { enabled: true, label: { description: `${tabularChartTitle(result, kind, metric, secondary)}. Exact values and calculation evidence are available in the complete data table.` } },
    tooltip: { trigger: kind === 'scatter' ? 'item' : 'axis', triggerOn: 'mousemove', renderMode: 'html', confine: true, enterable: true,
      className: 'tabular-hover-tooltip', transitionDuration: 0, hideDelay: 120,
      backgroundColor: '#ffffff', borderColor: '#d9d9d9', borderWidth: 1, padding: 12,
      textStyle: { color: '#2a2a2a', fontSize: 12 }, axisPointer: { type: 'line', lineStyle: { color: '#8a8a8a', type: 'dashed' } },
      formatter: params => tabularChartTooltip(result, kind, metric, secondary, params),
    },
    grid: { left: 12, right: 12, top: kind === 'combo' ? 46 : 24, bottom: 16, outerBoundsMode: 'same', outerBoundsContain: 'all' },
  };
  const axis = (id: MetricId) => ({ type: 'value' as const, name: metricAxisLabel(result, id), nameLocation: 'middle' as const, nameGap: 12, nameMoveOverlap: true, nameTextStyle: { fontSize: 12, color: '#444444' }, axisLabel: { color: '#555555', formatter: (value: number) => tabularAxisValue(value, result.columns.find(item => item.id === id)?.unit) }, splitLine: { lineStyle: { color: '#e8e8e8' } } });
  if (kind === 'scatter' && secondary) {
    const data = rows.flatMap((row, index) => { const x = valueOf(row, metric), y = valueOf(row, secondary); return x === null || y === null ? [] : [{ name: tabularGroupLabel(result, row.group).label, value: [x, y], rowIndex: index }]; });
    return { ...common,
      xAxis: axis(metric),
      yAxis: axis(secondary),
      series: [{ type: 'scatter', name: `${column?.label ?? metric} / ${other?.label ?? secondary}`, symbolSize: 10, data, itemStyle: { opacity: 0.75, borderColor: '#fff', borderWidth: 1 }, emphasis: { scale: 1.4 } }],
    };
  }
  const primary: BarSeriesOption | LineSeriesOption = kind === 'line' || kind === 'area'
    ? { type: 'line', name: column?.label ?? metric, data: data(metric), connectNulls: false, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2 }, ...(kind === 'area' ? { areaStyle: { opacity: 0.16 } } : {}) }
    : { type: 'bar', name: `${column?.label ?? metric}${overlay ? ' · bar' : ''}`, data: data(metric), barMaxWidth: 36, itemStyle: { borderRadius: [3, 3, 0, 0] } };
  if (kind === 'horizontalBar') return { ...common,
    xAxis: axis(metric),
    yAxis: { type: 'category', inverse: true, name: `${GROUP_LABELS[result.request.groupBy].replace(/^./, letter => letter.toUpperCase())}${['day', 'week', 'month'].includes(result.request.groupBy) ? ' (UTC)' : ''}`, nameLocation: 'middle', nameGap: 12, nameMoveOverlap: true, data: labels, axisLabel: { color: '#555555', hideOverlap: true }, axisTick: { show: false } },
    series: [{ ...primary, type: 'bar', itemStyle: { borderRadius: [0, 3, 3, 0] } }],
  };
  return { ...common,
    ...(timeline ? { useUTC: true } : {}),
    xAxis: { type: timeline ? 'time' : 'category', name: `${GROUP_LABELS[result.request.groupBy].replace(/^./, letter => letter.toUpperCase())}${['day', 'week', 'month'].includes(result.request.groupBy) ? ' (UTC)' : ''}`, nameLocation: 'middle', nameGap: 12, nameMoveOverlap: true, nameTextStyle: { fontSize: 12, color: '#444444' }, ...(timeline ? {} : { data: labels }), axisLabel: { color: '#555555', hideOverlap: true, interval: rows.length <= 6 ? 0 : 'auto', rotate: rows.length > 4 ? 35 : 0 }, axisLine: { lineStyle: { color: '#bdbdbd' } }, axisTick: { show: false } },
    yAxis: kind === 'combo' && secondary && !overlay ? [{ ...axis(metric), position: 'left' }, { ...axis(secondary), position: 'right', splitLine: { show: false } }]
      : axis(metric),
    ...(kind === 'combo' && secondary ? { legend: { top: 0, left: 'center', type: 'scroll' as const, textStyle: { fontSize: 12, color: '#444444' } } } : {}),
    series: kind === 'combo' && secondary ? [primary, { type: 'line', name: `${other?.label ?? secondary}${overlay ? ' · line' : ''}`, yAxisIndex: overlay ? 0 : 1, data: data(secondary), connectNulls: false, symbol: 'diamond', symbolSize: 7, lineStyle: { width: 2.5 } }] : [primary],
  };
}
