import type { FinancialAnalysis, FinancialCurrency, FinancialMetricComparison, FinancialPeriodReport, FinancialTotals } from '../../core/src/financial-reporting';

type Metric = FinancialMetricComparison['key'];
export const METRICS: readonly Metric[] = ['revenue', 'cost', 'gross_profit', 'gross_margin'];
export const LABELS: Record<Metric, string> = { revenue: 'Revenue', cost: 'Cost', gross_profit: 'Gross profit', gross_margin: 'Gross margin' };
export const DEFINITIONS: Record<Metric, string> = {
  revenue: 'Sum of recognized revenue in the displayed period, in the original currency.',
  cost: 'Sum of the corresponding costs supplied for those revenue records.',
  gross_profit: 'Recognized revenue minus its corresponding costs. A negative value is a gross loss.',
  gross_margin: 'Gross profit divided by recognized revenue × 100. Undefined when revenue is zero. This is gross margin, not net profit margin.',
};
export const PAGE_SIZE = 40;
export const CHART_LIMIT = 12;
const number = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
export const validNumber = (value: number | null): value is number => value !== null && Number.isFinite(value);
function decimalMinor(value: number | null): string | null {
  if (value === null || !Number.isSafeInteger(value)) return null;
  const exact = BigInt(value), absolute = exact < 0n ? -exact : exact;
  return `${exact < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
export function financialMoney(value: number | null, currency: FinancialCurrency): string {
  const decimal = decimalMinor(value);
  if (decimal === null) return '—';
  const [whole, cents] = decimal.replace('-', '').split('.');
  return `${value! < 0 ? '−' : ''}${{ USD: '$', EUR: '€', GBP: '£' }[currency]}${new Intl.NumberFormat('en-US').format(BigInt(whole))}.${cents}`;
}
export function metricValue(key: Metric, value: number | null, currency: FinancialCurrency): string {
  return key === 'gross_margin' ? validNumber(value) ? `${number(value)}%` : '—' : financialMoney(value, currency);
}
export function totalValue(totals: FinancialTotals, key: Metric): number | null {
  return ({ revenue: totals.revenueMinor, cost: totals.costMinor, gross_profit: totals.grossProfitMinor, gross_margin: totals.grossMarginPercent })[key];
}
export function financialChange(item: FinancialMetricComparison, currency: FinancialCurrency): string {
  if (!validNumber(item.absoluteChange)) return '—';
  const prefix = item.absoluteChange > 0 ? '+' : '';
  return item.key === 'gross_margin' ? `${prefix}${number(item.absoluteChange)} pp` : `${prefix}${financialMoney(item.absoluteChange, currency)}`;
}
export function relativeChange(item: FinancialMetricComparison): string {
  return validNumber(item.percentChange) ? `${item.percentChange > 0 ? '+' : ''}${number(item.percentChange)}%` : '—';
}
export function reasonText(item: FinancialMetricComparison): string {
  return ({ comparison_not_requested: 'No comparison period requested.', incomplete_coverage: 'A complete export was not declared for both periods. Changes are withheld.', undefined_metric: 'This metric is unknown or has a zero-revenue denominator.', nonpositive_baseline: 'Percentage growth is undefined when the prior value is zero or negative.', margin_uses_percentage_points: 'Margin changes are percentage points, not percentage growth.' } as const)[item.reason!] ?? 'Change compares the two displayed periods, without adjusting for their length.';
}
export const periodText = (report: FinancialPeriodReport) => `${report.period.from} – ${report.period.through} UTC`;

type CsvCell = string | number | null | { numeric: string | null };
function csvCell(cell: CsvCell): string {
  let value = typeof cell === 'object' && cell !== null ? cell.numeric ?? '' : cell === null ? '' : String(cell);
  // Only untrusted text receives a spreadsheet formula guard; calculated negatives stay numeric.
  if (typeof cell === 'string' && (/^\s*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value))) value = `'${value}`;
  return `"${value.replaceAll('"', '""')}"`;
}
/** Long-form export uses exact saved values and explicit units; blank numeric cells are unknown. */
export function financialAnalysisCsv(analysis: FinancialAnalysis): string {
  const rows: CsvCell[][] = [['kind', 'period', 'from_utc', 'through_utc', 'category', 'metric', 'value', 'unit', 'coverage_or_comparison_reason', 'source_records', 'source_file', 'input_sha256', 'calculator', 'dataset_id']];
  function appendPeriod(report: FinancialPeriodReport, label: string) {
    const append = (totals: FinancialTotals, category: string, kind: string) => {
      for (const key of METRICS) {
        const value = totalValue(totals, key);
        rows.push([kind, label, report.period.from, report.period.through, category, key,
          key === 'gross_margin' ? value : { numeric: decimalMinor(value) }, key === 'gross_margin' ? 'percent' : analysis.currency,
          report.coverage.status, totals.evidence.records.join(';'), analysis.sourceName, analysis.contentHash, analysis.calculatorVersion, analysis.datasetId]);
      }
    };
    append(report.totals, '', 'total');
    report.categories.forEach(category => append(category.totals, category.category, 'category'));
  }
  appendPeriod(analysis.current, 'current');
  if (analysis.previous) appendPeriod(analysis.previous, 'previous');
  for (const comparison of analysis.comparisons) {
    rows.push(['absolute_change', 'current_minus_previous', analysis.current.period.from, analysis.current.period.through, '', comparison.key,
      comparison.key === 'gross_margin' ? comparison.absoluteChange : { numeric: decimalMinor(comparison.absoluteChange) },
      comparison.key === 'gross_margin' ? 'percentage_points' : analysis.currency, comparison.reason ?? '', '', analysis.sourceName, analysis.contentHash, analysis.calculatorVersion, analysis.datasetId]);
    if (comparison.key !== 'gross_margin') rows.push(['percent_change', 'current_vs_previous', analysis.current.period.from, analysis.current.period.through, '', comparison.key,
      comparison.percentChange, 'percent', comparison.reason ?? '', '', analysis.sourceName, analysis.contentHash, analysis.calculatorVersion, analysis.datasetId]);
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
const markdownText = (text: string) => text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\r\n]/g, ' ');
export function financialAnalysisMarkdown(analysis: FinancialAnalysis): string {
  return ['## Calculated financial report', '', `Current: ${periodText(analysis.current)}.`,
    ...(analysis.previous ? [`Previous: ${periodText(analysis.previous)}.`] : []), `Currency: ${analysis.currency}.`, '',
    '| Metric | Current | Previous | Change | Growth |', '| --- | ---: | ---: | ---: | ---: |',
    ...analysis.comparisons.map(item => `| ${LABELS[item.key]} | ${metricValue(item.key, item.current, analysis.currency)} | ${metricValue(item.key, item.previous, analysis.currency)} | ${financialChange(item, analysis.currency)} | ${item.key === 'gross_margin' ? 'Not applicable' : relativeChange(item)} |`), '',
    '### Current period by category', '', '| Category | Revenue | Cost | Gross profit | Gross margin |', '| --- | ---: | ---: | ---: | ---: |',
    ...analysis.current.categories.map(category => `| ${markdownText(category.category)} | ${METRICS.map(key => metricValue(key, totalValue(category.totals, key), analysis.currency)).join(' | ')} |`), '',
    '### Coverage and evidence', '', `Current: ${analysis.current.coverage.message}`,
    ...(analysis.previous ? [`Previous: ${analysis.previous.coverage.message}`] : []),
    ...analysis.checks.map(check => `- ${check.status === 'passed' ? 'Checked' : 'Note'}: ${check.message}`), '',
    ...METRICS.map(key => `- ${LABELS[key]}: ${DEFINITIONS[key]}`), '',
    `Source: ${markdownText(analysis.sourceName)}`, `Input SHA-256: ${analysis.contentHash}`, `Calculator: ${analysis.calculatorVersion}`,
    `Current CSV records (header is record 1): ${analysis.current.totals.evidence.records.join(', ') || 'None'}`,
    ...(analysis.previous ? [`Previous CSV records: ${analysis.previous.totals.evidence.records.join(', ') || 'None'}`] : []),
    'A dash means unknown or undefined. Margin changes use percentage points. Percentage growth is undefined for a zero or negative prior value.',
    'Complete coverage is an uploader declaration, not an independent check. Calculation checks do not verify narrative claims or prove the source data is correct.', ''].join('\n');
}
