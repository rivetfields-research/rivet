import type { TabularAnalysis } from '../../core/src/tabular-datasets';
import { exportGroupLabel } from '../../data-layer/src/tabular/post-presentation';
import { analysisColumnLabel } from '../../data-layer/src/tabular/labels';

/** Export the saved cells; never recompute values during document export. */
export function tabularReportMarkdown(analysis: TabularAnalysis): string {
  const {result} = analysis;
  const cell = (value: unknown) => String(value ?? '—').replaceAll('\\','\\\\').replaceAll('|','\\|').replace(/[\r\n]+/g,' ');
  return [
    '## Saved calculation',
    result.timeBasis.description,
    `Publication filter: ${result.request.dateRange?.from ?? 'unbounded'} (inclusive) to ${result.request.dateRange?.to ?? 'unbounded'} (exclusive).`,
    ...(result.request.contentTypes ? [`Content types: ${result.request.contentTypes.map(cell).join(', ')} (exact values).`] : []),
    ...(result.selection ? [`Showing ${result.selection.returnedGroups} of ${result.selection.totalGroups} groups ranked by ${result.request.sort?.metric} (${result.request.sort?.direction}). Totals and evidence cover all ${result.counts.includedRows} included source rows, including groups omitted by the ranking limit.`] : []),
    `| ${result.columns.map(column => cell(`${analysisColumnLabel(column, result.request.groupBy)}${column.unit === 'percent' ? ' (%)' : ''}`)).join(' | ')} |`,
    `| ${result.columns.map(()=>'---').join(' | ')} |`,
    ...result.rows.map(row => `| ${result.columns.map(column=>cell(column.id === 'group' ? exportGroupLabel(result, row.group, new Map(Object.entries(analysis.postLabels ?? {}))) : row[column.id])).join(' | ')} |`),
    `| ${result.selection ? 'Full cohort total' : 'Total'} | ${result.columns.slice(1).map(column=>cell(result.totals[column.id as keyof typeof result.totals])).join(' | ')} |`,
    '', 'A dash means unknown, not zero. Counts are values in the uploaded export, not necessarily engagement earned in the publication period.',
    ...result.definitions.map(definition => `- ${definition.label}: ${definition.formula}`),
    ...result.warnings.map(warning=>`- ${warning.message}`),
  ].join('\n');
}
