import type { WeeklyUsageAnalysis, UsageComparison } from '../../core/src/reporting-analysis';

export function metricValue(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}
export function changeLabel(metric: UsageComparison): string {
  return metric.percentChange === null ? 'Comparison unavailable' : `${metric.percentChange > 0 ? '+' : ''}${metricValue(metric.percentChange)}% vs previous week`;
}
export function analysisCsv(analysis: WeeklyUsageAnalysis): string {
  const rows = [['period', 'date_utc', 'events', 'active_users', 'coverage'],
    ...analysis.daily.current.map(day => ['current', day.date, day.events ?? '', day.activeUsers ?? '', analysis.coverage.current.status]),
    ...(analysis.daily.previous ?? []).map(day => ['previous', day.date, day.events ?? '', day.activeUsers ?? '', analysis.coverage.previous?.status ?? 'unknown'])];
  return rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n';
}
export function analysisMarkdown(analysis: WeeklyUsageAnalysis): string {
  return [`## Calculated usage`, '', `Current period: ${analysis.current.period.from} – ${analysis.current.period.through} UTC.`,
    ...(analysis.previous ? [`Previous period: ${analysis.previous.period.from} – ${analysis.previous.period.through} UTC.`] : []), '',
    '| Metric | Current | Previous | Change |', '| --- | ---: | ---: | --- |',
    ...analysis.comparisons.map(metric => `| ${metric.label} | ${metricValue(metric.current)} | ${metricValue(metric.previous)} | ${changeLabel(metric)} |`), '',
    '### Daily records', '', '| Date (UTC) | Events | Active users |', '| --- | ---: | ---: |',
    ...analysis.daily.current.map(day => `| ${day.date} | ${metricValue(day.events)} | ${metricValue(day.activeUsers)} |`), '',
    '### Calculation checks', '', ...analysis.checks.map(check => `- ${check.status === 'passed' ? 'Checked' : 'Note'}: ${check.message}`), '',
    ...analysis.current.metrics.map(metric => `- ${metric.label}: ${metric.definition}`), '',
    `Source: ${analysis.sourceName.replaceAll('\n', ' ')}`, `Input SHA-256: ${analysis.contentHash}`, `Calculator: ${analysis.calculatorVersion}`,
    'A dash means unknown or undefined. These checks cover saved calculations, not the correctness of every narrative claim.', ''].join('\n');
}
