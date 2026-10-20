import { useId, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, BarChart3, Check, ChevronDown, Download, FileText, Info, LineChart, Table2, X } from 'lucide-react';
import type { WeeklyUsageAnalysis, UsageComparison } from '../../../packages/core/src/reporting-analysis';
import { metricValue, changeLabel, analysisCsv, analysisMarkdown } from '../../../packages/presentation/src/visual-analysis';
export { metricValue, changeLabel, analysisCsv, analysisMarkdown } from '../../../packages/presentation/src/visual-analysis';
function downloadData(analysis: WeeklyUsageAnalysis) {
  const url = URL.createObjectURL(new Blob([analysisCsv(analysis)], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `usage-${analysis.current.period.from}.csv`; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type ChartMetric = 'events' | 'activeUsers';
type ChartKind = 'line' | 'bar' | 'table';
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function UsageChart({ analysis, kind, metric }: { analysis: WeeklyUsageAnalysis; kind: 'line' | 'bar'; metric: ChartMetric }) {
  const label = metric === 'events' ? 'Events' : 'Active users';
  const current = analysis.daily.current, previous = analysis.daily.previous;
  const values = [...current, ...(previous ?? [])].map(day => day[metric]).filter((value): value is number => value !== null);
  const max = Math.max(1, ...values), ceiling = Math.max(1, Math.ceil(max / 4) * 4);
  const x = (index: number) => 62 + index * 97;
  const y = (value: number) => 215 - value / ceiling * 175;
  function series(days: typeof current, secondary: boolean) {
    let connected = false;
    const path = days.map((day, index) => {
      const value = day[metric];
      if (value === null) { connected = false; return ''; }
      const command = `${connected ? 'L' : 'M'}${x(index)},${y(value)}`; connected = true; return command;
    }).join(' ');
    return <g className={secondary ? 'usage-series previous' : 'usage-series current'}>
      {kind === 'line' && <path d={path} fill="none" strokeWidth={secondary ? 1.8 : 2.6} strokeDasharray={secondary ? '5 5' : undefined} />}
      {days.map((day, index) => day[metric] === null ? null : <g key={day.date}>
        {kind === 'bar' ? <rect x={x(index) + (secondary ? -20 : 1)} y={y(day[metric]!)} width={18} height={215 - y(day[metric]!)} rx={3}><title>{`${secondary ? 'Previous' : 'Current'} · ${day.date}: ${day[metric]} ${label.toLowerCase()}`}</title></rect>
          : <circle cx={x(index)} cy={y(day[metric]!)} r={secondary ? 3 : 4} strokeWidth={2}><title>{`${day.date}: ${day[metric]} ${label.toLowerCase()}`}</title></circle>}
      </g>)}
    </g>;
  }
  return <svg className="usage-chart-svg" viewBox="0 0 710 255" role="img" aria-label={`${label} by UTC date, ${analysis.current.period.from} through ${analysis.current.period.through}. ${previous ? 'Previous week aligned by day.' : ''} Unknown values are gaps. Exact values are available in the Table view.`}>
    {Array.from({ length: 5 }, (_, index) => <g key={index}><line className="usage-gridline" x1={48} x2={663} y1={y(ceiling * index / 4)} y2={y(ceiling * index / 4)} /><text x={37} y={y(ceiling * index / 4) + 4} textAnchor="end">{metricValue(ceiling * index / 4)}</text></g>)}
    {previous && series(previous, true)}{series(current, false)}
    {current.map((day, index) => <text key={day.date} x={x(index)} y={243} textAnchor="middle">{shortDate(day.date)}</text>)}
  </svg>;
}

export function UsageAnalysisView({ analysis, onSource }: { analysis: WeeklyUsageAnalysis; onSource: (id: string) => void }) {
  const id = useId();
  const [kind, setKind] = useState<ChartKind>('line');
  const [metric, setMetric] = useState<ChartMetric>('events');
  const [selected, setSelected] = useState<UsageComparison['key'] | null>(null);
  const [checksOpen, setChecksOpen] = useState(false);
  const evidenceRef = useRef<HTMLDivElement>(null);
  const activeMetric = analysis.current.metrics.find(item => item.key === selected);
  const comparison = analysis.comparisons.find(item => item.key === selected);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const declared = analysis.coverage.current.status === 'declared-complete';
  function inspect(key: UsageComparison['key'], button: HTMLButtonElement) {
    const next = selected === key ? null : key; setSelected(next); selectedButton.current = button;
    if (next) requestAnimationFrame(() => evidenceRef.current?.focus({ preventScroll: true }));
  }
  function closeEvidence() { setSelected(null); requestAnimationFrame(() => selectedButton.current?.focus()); }
  return <section className="usage-analysis" aria-label="Calculated usage report">
    <div className="usage-analysis-meta"><span><span className="usage-calculated-dot" />Calculated from your CSV</span><span>{shortDate(analysis.current.period.from)} – {shortDate(analysis.current.period.through)} · UTC</span></div>
    <div className="usage-metrics">{analysis.comparisons.map(item => <button type="button" key={item.key} className={`usage-metric ${selected === item.key ? 'selected' : ''}`} aria-expanded={selected === item.key} aria-controls={`${id}-metric`} onClick={event => inspect(item.key, event.currentTarget)}>
      <span className="usage-metric-label">{item.label}<Info size={13} /></span><strong>{metricValue(item.current)}</strong>
      <span className="usage-metric-change">{item.percentChange !== null && (item.percentChange < 0 ? <ArrowDownRight size={13} /> : <ArrowUpRight size={13} />)}{changeLabel(item)}</span>
    </button>)}</div>
    {activeMetric && <div id={`${id}-metric`} ref={evidenceRef} tabIndex={-1} className="usage-metric-evidence" role="region" aria-label={`${activeMetric.label} calculation`}>
      <header><strong>{activeMetric.label}</strong><button className="icon-button" aria-label="Close calculation details" onClick={closeEvidence}><X size={14} /></button></header>
      <p>{activeMetric.definition}</p><p>{comparison?.reason ?? `Change: (${metricValue(comparison?.current ?? null)} − ${metricValue(comparison?.previous ?? null)}) ÷ ${metricValue(comparison?.previous ?? null)} × 100 = ${metricValue(comparison?.percentChange ?? null)}%, using the two displayed UTC periods.`}</p>
      <div><span>{activeMetric.evidence.records.length.toLocaleString()} source records · {activeMetric.evidence.columns.join(', ')}</span><button type="button" data-source-id={analysis.sourceId} onClick={() => onSource(analysis.sourceId)}>Open calculation source <FileText size={13} /></button></div>
    </div>}
    <p className="usage-coverage-note"><Info size={13} /><span>{declared ? 'Coverage was declared complete by the uploader; it has not been independently verified.' : 'These are counts from supplied records. Full coverage is unknown, so growth comparisons are withheld.'}</span></p>
    <section className="usage-visual-card" aria-labelledby={`${id}-chart-title`}>
      <header><div><h2 id={`${id}-chart-title`}>Activity over the week</h2></div><button type="button" className="icon-button" title="Download chart data as CSV" aria-label="Download chart data as CSV" onClick={() => downloadData(analysis)}><Download size={15} /></button></header>
      <div className="usage-chart-controls"><label><span className="sr-only">Chart metric</span><select value={metric} onChange={event => setMetric(event.target.value as ChartMetric)}><option value="events">Events</option><option value="activeUsers">Active users</option></select></label><div className="usage-view-switch" aria-label="Visualization type">{([{ id: 'line', title: 'Line', icon: LineChart }, { id: 'bar', title: 'Bar', icon: BarChart3 }, { id: 'table', title: 'Table', icon: Table2 }] as const).map(option => <button type="button" key={option.id} aria-pressed={kind === option.id} aria-label={`${option.title} view`} title={`${option.title} view`} onClick={() => setKind(option.id)}><option.icon size={15} /><span>{option.title}</span></button>)}</div></div>
      {kind === 'table' ? <div className="usage-data-scroll" tabIndex={0} role="region" aria-label="Daily usage data"><table><thead><tr><th>Date (UTC)</th><th>Events</th><th>Active users</th>{analysis.previous && <><th>Prior date</th><th>Prior events</th><th>Prior users</th></>}</tr></thead><tbody>{analysis.daily.current.map((day, index) => <tr key={day.date}><th scope="row">{day.date}</th><td>{metricValue(day.events)}</td><td>{metricValue(day.activeUsers)}</td>{analysis.previous && <><td>{analysis.daily.previous?.[index]?.date ?? '—'}</td><td>{metricValue(analysis.daily.previous?.[index]?.events ?? null)}</td><td>{metricValue(analysis.daily.previous?.[index]?.activeUsers ?? null)}</td></>}</tr>)}</tbody></table></div> : <UsageChart analysis={analysis} kind={kind} metric={metric} />}
      <footer><span className="usage-legend current">Current week</span>{analysis.previous && <span className="usage-legend previous">Previous week</span>}<span>Gaps and “—” mean unknown or undefined.</span></footer>
    </section>
    <section className="usage-comparison" aria-labelledby={`${id}-comparison-title`}><h2 id={`${id}-comparison-title`}>Week in numbers</h2><div className="usage-data-scroll" tabIndex={0} role="region" aria-label="Weekly comparison table"><table><thead><tr><th>Metric</th><th>Current</th><th>Previous</th><th>Change</th></tr></thead><tbody>{analysis.comparisons.map(item => <tr key={item.key}><th scope="row"><button type="button" onClick={event => inspect(item.key, event.currentTarget)} aria-label={`Inspect ${item.label} calculation`}>{item.label}</button></th><td>{metricValue(item.current)}</td><td>{metricValue(item.previous)}</td><td title={item.reason ?? undefined}>{item.percentChange === null ? '—' : `${item.percentChange > 0 ? '+' : ''}${metricValue(item.percentChange)}%`}</td></tr>)}</tbody></table></div>{analysis.previous && <p className="usage-period-caption">Previous period: {analysis.previous.period.from} – {analysis.previous.period.through} UTC</p>}</section>
    <section className="usage-checks"><button type="button" className="usage-checks-toggle" aria-expanded={checksOpen} aria-controls={`${id}-checks`} onClick={() => setChecksOpen(value => !value)}><span><Check size={15} />Calculation checks</span><span>View evidence<ChevronDown size={14} className={checksOpen ? 'rotated' : ''} /></span></button>{checksOpen && <div id={`${id}-checks`}><ul>{analysis.checks.map(check => <li key={check.id}>{check.status === 'passed' ? <Check size={14} /> : <Info size={14} />}<span>{check.message}</span></li>)}</ul><dl><dt>Input file</dt><dd>{analysis.sourceName}</dd><dt>Calculator</dt><dd>{analysis.calculatorVersion}</dd><dt>Input SHA-256</dt><dd><code>{analysis.contentHash}</code></dd></dl><button type="button" className="text-button" data-source-id={analysis.sourceId} onClick={() => onSource(analysis.sourceId)}><FileText size={14} />Open saved calculation source</button></div>}<p>Checks cover these calculations. Narrative claims and business interpretation still need review.</p></section>
  </section>;
}
