import type { Run } from '../../../packages/core/src/types.ts';
import { HarnessError } from '../../../packages/core/src/errors.ts';
import { CHART_TEMPLATES, type ChartTemplate, type MetricId } from '../../../packages/data-layer/src/tabular/types.ts';
import { tabularChartOption, tabularChartTitle, tabularDateBasis, tabularFilterBasis, chartScope } from '../../../packages/presentation/src/tabular-chart.ts';
import { sourceChartOption, sourceChartChoices, title, type SourceChartKind } from '../../../packages/presentation/src/source-chart.ts';
import { renderChartImage } from '../../../packages/presentation/src/tabular-echarts.ts';

/** Accept display choices, never client-supplied data, markup or chart code. */
export function chartDownload(run: Run, type: 'tabular'|'source', params: URLSearchParams): string {
  const invalid = () => new HarnessError('Choose a saved chart view and its available metrics.',400,'invalid_chart');
  for (const key of params.keys()) if (!['kind','metric','secondary','hidden'].includes(key) || (key !== 'hidden' && params.getAll(key).length !== 1)) throw invalid();
  if ([...params.values()].some(value => value.length > 200) || params.getAll('hidden').length > 2) throw invalid();
  const kind = params.get('kind');
  const output = run.result ?? run.reply;
  if (type === 'source') {
    const analysis = output?.sourceAnalysis ?? run.savedSourceAnalysis;
    if (!analysis) throw new HarnessError('That task has no saved source chart.',404,'export_not_found');
    if (!sourceChartChoices(analysis.result).includes(kind as SourceChartKind) || kind === 'table' || [...params.keys()].some(key => key !== 'kind')) throw invalid();
    return renderChartImage(sourceChartOption(analysis.result,kind as Exclude<SourceChartKind,'table'>),title(analysis.result),
      `Saved observation: ${analysis.result.observations.map(item => item.observedAt).join(' / ')}`);
  }
  const analysis = output?.tabularAnalysis ?? run.savedCalculation?.analysis;
  if (!analysis) throw new HarnessError('That task has no saved chart.',404,'export_not_found');
  const result = {...analysis.result,postLabels:new Map(Object.entries(analysis.postLabels ?? {}))};
  const metric = params.get('metric') as MetricId, secondary = params.get('secondary') as MetricId | null;
  const available = (id: string) => result.columns.some(column => column.id === id && column.type === 'number');
  if (!CHART_TEMPLATES.includes(kind as ChartTemplate) || kind === 'table' || !available(metric) || (secondary && !available(secondary))) throw invalid();
  if ((kind === 'scatter' || kind === 'combo') && (!secondary || (kind === 'scatter' && secondary === metric))) throw invalid();
  const option = tabularChartOption(result,kind as Exclude<ChartTemplate,'table'>,metric,secondary ?? undefined);
  const hidden = params.getAll('hidden'), series = Array.isArray(option.series) ? option.series : [];
  if (hidden.some(name => !series.some(item => item.name === name))) throw invalid();
  if (hidden.length) option.legend = {...(Array.isArray(option.legend) ? option.legend[0] : option.legend),selected:Object.fromEntries(hidden.map(name => [name,false]))};
  return renderChartImage(option,tabularChartTitle(result,kind as ChartTemplate,metric,secondary ?? undefined),
    [tabularDateBasis(result),tabularFilterBasis(result),chartScope(result),'Source-export counts may be lifetime totals.'].filter(Boolean).join('\n'));
}
