import { useId, useRef, useState } from 'react';
import { BarChart3, Check, ChevronDown, Download, FileText, Info, Table2, X } from 'lucide-react';
import type { FinancialAnalysis, FinancialCurrency, FinancialMetricComparison, FinancialPeriodReport, FinancialTotals } from '../../../packages/core/src/financial-reporting';
import { METRICS, LABELS, DEFINITIONS, PAGE_SIZE, CHART_LIMIT, validNumber, financialMoney, metricValue, totalValue, financialChange, relativeChange, reasonText, periodText, financialAnalysisCsv, financialAnalysisMarkdown } from '../../../packages/presentation/src/financial-analysis';
export { METRICS, LABELS, DEFINITIONS, PAGE_SIZE, CHART_LIMIT, validNumber, financialMoney, metricValue, totalValue, financialChange, relativeChange, reasonText, periodText, financialAnalysisCsv, financialAnalysisMarkdown } from '../../../packages/presentation/src/financial-analysis';
type Metric = FinancialMetricComparison['key'];
function downloadData(analysis: FinancialAnalysis) {
  const url = URL.createObjectURL(new Blob([financialAnalysisCsv(analysis)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `financial-${analysis.current.period.from}.csv`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FinancialCategoryChart({ analysis, metric }: { analysis: FinancialAnalysis; metric: Metric }) {
  const categories = analysis.current.categories.slice(0, CHART_LIMIT);
  const values = categories.map(category => totalValue(category.totals, metric)).filter(validNumber);
  const min = Math.min(0, ...values), max = Math.max(0, ...values), range = max - min || 1;
  const x = (value: number) => 185 + (value - min) / range * 350;
  const zero = x(0), height = Math.max(110, categories.length * 42 + 45);
  return <svg className="financial-chart-svg" viewBox={`0 0 710 ${height}`} role="img" aria-label={`${LABELS[metric]} by observed category, ${periodText(analysis.current)}. Bars start at zero; losses extend left. First ${Math.min(CHART_LIMIT, categories.length)} categories in label order. Exact values are in Table view.`}>
    <line className="financial-zero-line" x1={zero} x2={zero} y1={14} y2={height - 30} />
    <text x={zero} y={height - 11} textAnchor="middle">0</text>
    {categories.map((category, index) => {
      const value = totalValue(category.totals, metric), y = 17 + index * 42;
      const text = metricValue(metric, value, analysis.currency), letters = Array.from(category.category);
      return <g key={category.category}><title>{`${category.category}: ${text}`}</title>
        <text className="financial-chart-category" x={174} y={y + 17} textAnchor="end">{letters.length > 23 ? `${letters.slice(0, 22).join('')}…` : category.category}</text>
        {validNumber(value) && <rect className={value < 0 ? 'financial-bar is-loss' : 'financial-bar'} x={Math.min(zero, x(value))} y={y} width={Math.abs(x(value) - zero)} height={25} rx={2} />}
        <text className="financial-chart-value" x={693} y={y + 17} textAnchor="end">{text}</text>
      </g>;
    })}
    {!categories.length && <text x={355} y={45} textAnchor="middle">No category records in this period</text>}
  </svg>;
}
export function FinancialCategoryTable({ analysis, page = 0 }: { analysis: FinancialAnalysis; page?: number }) {
  const categories = analysis.current.categories.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return <div className="financial-data-scroll" tabIndex={0} role="region" aria-label="Current financial category data"><table><caption>{periodText(analysis.current)} · {analysis.currency} · observed categories</caption><thead><tr><th>Category</th>{METRICS.map(key => <th key={key}>{LABELS[key]}</th>)}</tr></thead><tbody>{categories.map(category => <tr key={category.category}><th scope="row">{category.category}</th>{METRICS.map(key => <td key={key}>{metricValue(key, totalValue(category.totals, key), analysis.currency)}</td>)}</tr>)}{!categories.length && <tr><td colSpan={5}>No category records in this period.</td></tr>}</tbody></table></div>;
}

export function FinancialAnalysisView({ analysis, onSource }: { analysis: FinancialAnalysis; onSource: (id: string) => void }) {
  const id = useId();
  const [kind, setKind] = useState<'bar' | 'table'>('bar');
  const [metric, setMetric] = useState<Metric>('revenue');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Metric | null>(null);
  const selectedButton = useRef<HTMLButtonElement | null>(null), evidence = useRef<HTMLDivElement>(null);
  const comparison = analysis.comparisons.find(item => item.key === selected);
  const pageCount = Math.ceil(analysis.current.categories.length / PAGE_SIZE), safePage = Math.min(page, Math.max(0, pageCount - 1));
  function inspect(key: Metric, button: HTMLButtonElement) {
    const next = selected === key ? null : key; setSelected(next); selectedButton.current = button;
    if (next) requestAnimationFrame(() => evidence.current?.focus({ preventScroll: true }));
  }
  function closeEvidence() { setSelected(null); requestAnimationFrame(() => selectedButton.current?.focus()); }
  return <section className="financial-analysis" aria-label="Calculated financial report">
    <div className="financial-analysis-meta"><span>Calculated from your CSV</span><span>{periodText(analysis.current)} · {analysis.currency}</span></div>
    <div className="financial-metrics">{analysis.comparisons.map(item => <button type="button" key={item.key} className={`financial-metric ${selected === item.key ? 'selected' : ''}`} aria-expanded={selected === item.key} aria-controls={`${id}-metric`} onClick={event => inspect(item.key, event.currentTarget)}><span>{LABELS[item.key]}<Info size={13} /></span><strong>{metricValue(item.key, item.current, analysis.currency)}</strong><small>{item.absoluteChange === null ? 'Comparison unavailable' : `${financialChange(item, analysis.currency)} vs prior period`}</small></button>)}</div>
    {selected && comparison && <div ref={evidence} id={`${id}-metric`} tabIndex={-1} className="financial-metric-evidence" role="region" aria-label={`${LABELS[selected]} calculation`}><header><strong>{LABELS[selected]}</strong><button type="button" className="icon-button" aria-label="Close financial calculation details" onClick={closeEvidence}><X size={14} /></button></header><p>{DEFINITIONS[selected]}</p><p>{reasonText(comparison)}</p><button type="button" className="text-button" data-source-id={analysis.sourceId} onClick={() => onSource(analysis.sourceId)}>Open calculation source<FileText size={13} /></button></div>}
    <p className="financial-coverage-note"><Info size={13} /><span>{analysis.current.coverage.status === 'declared-complete' ? `Coverage was declared complete by the uploader; it has not been independently verified.${analysis.previous && analysis.previous.coverage.status !== 'declared-complete' ? ' Prior coverage is incomplete, so comparisons are withheld.' : ''}` : 'These totals reflect supplied records. Full coverage is unknown, so growth comparisons are withheld.'}</span></p>
    <section className="financial-visual-card" aria-labelledby={`${id}-chart-title`}><header><div><h2 id={`${id}-chart-title`}>Current period by category</h2><p>{analysis.current.recordsIncluded.toLocaleString()} included records · {analysis.current.recordsExcluded.toLocaleString()} outside this period</p></div><button type="button" className="icon-button" title="Download financial data as CSV" aria-label="Download financial data as CSV" onClick={() => downloadData(analysis)}><Download size={15} /></button></header>
      <div className="financial-chart-controls"><label><span className="sr-only">Financial chart metric</span><select value={metric} onChange={event => setMetric(event.target.value as Metric)}>{METRICS.map(key => <option key={key} value={key}>{LABELS[key]}</option>)}</select></label><div className="financial-view-switch" aria-label="Financial visualization type">{([{ id: 'bar', title: 'Bar', icon: BarChart3 }, { id: 'table', title: 'Table', icon: Table2 }] as const).map(option => <button type="button" key={option.id} aria-pressed={kind === option.id} aria-label={`${option.title} view`} onClick={() => setKind(option.id)}><option.icon size={15} /><span>{option.title}</span></button>)}</div></div>
      {kind === 'bar' ? <div className="financial-chart-scroll" tabIndex={0} role="region" aria-label="Financial category chart"><FinancialCategoryChart analysis={analysis} metric={metric} /></div> : <><FinancialCategoryTable analysis={analysis} page={safePage} />{pageCount > 1 && <div className="financial-pagination"><button type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Previous</button><span>Page {safePage + 1} of {pageCount}</span><button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>Next</button></div>}</>}
      <footer>{kind === 'bar' && analysis.current.categories.length > CHART_LIMIT && <span>First {CHART_LIMIT} of {analysis.current.categories.length.toLocaleString()} categories in label order. Use Table or download the complete CSV.</span>}<span>Only observed categories appear. “—” means unknown or undefined.</span></footer>
    </section>
    <section className="financial-comparison" aria-labelledby={`${id}-comparison-title`}><h2 id={`${id}-comparison-title`}>Period comparison</h2><p>Current: {periodText(analysis.current)}</p><p>{analysis.previous ? `Previous: ${periodText(analysis.previous)}` : 'No previous period requested.'}</p><div className="financial-data-scroll" tabIndex={0} role="region" aria-label="Financial period comparison"><table><thead><tr><th>Metric</th><th>Current</th><th>Previous</th><th>Change</th><th>Growth</th></tr></thead><tbody>{analysis.comparisons.map(item => <tr key={item.key}><th scope="row"><button type="button" aria-label={`Inspect ${LABELS[item.key]} calculation`} onClick={event => inspect(item.key, event.currentTarget)}>{LABELS[item.key]}</button></th><td>{metricValue(item.key, item.current, analysis.currency)}</td><td>{metricValue(item.key, item.previous, analysis.currency)}</td><td title={reasonText(item)}>{financialChange(item, analysis.currency)}</td><td title={reasonText(item)}>{item.key === 'gross_margin' ? 'n/a' : relativeChange(item)}</td></tr>)}</tbody></table></div><p>Margin changes use percentage points (pp). Growth is undefined for a zero or negative prior value. Unequal periods are not adjusted for length.</p></section>
    <details className="financial-checks"><summary><span><Check size={15} />Calculation checks</span><span>View evidence<ChevronDown size={14} /></span></summary><div><ul>{analysis.checks.map(check => <li key={check.id}>{check.status === 'passed' ? <Check size={14} /> : <Info size={14} />}<span>{check.message}</span></li>)}</ul><dl><dt>Input file</dt><dd>{analysis.sourceName}</dd><dt>Current coverage</dt><dd>{analysis.current.coverage.message}</dd>{analysis.previous && <><dt>Prior coverage</dt><dd>{analysis.previous.coverage.message}</dd></>}<dt>Declaration</dt><dd>{analysis.coverageDeclaration ? `${analysis.coverageDeclaration.from} through ${analysis.coverageDeclaration.through} UTC · ${analysis.coverageDeclaration.complete ? 'declared complete' : 'not complete'}` : 'No complete-coverage declaration'}</dd><dt>Calculator</dt><dd>{analysis.calculatorVersion}</dd><dt>Dataset version</dt><dd><code>{analysis.datasetId}</code></dd><dt>Input SHA-256</dt><dd><code>{analysis.contentHash}</code></dd><dt>Calculated at</dt><dd>{analysis.createdAt}</dd></dl>
      <details className="financial-records"><summary>CSV record references</summary><p>Numbers refer to CSV records, including the header as record 1. They are not physical line numbers.</p><p>Current: {analysis.current.totals.evidence.records.join(', ') || 'None'}</p>{analysis.previous && <p>Previous: {analysis.previous.totals.evidence.records.join(', ') || 'None'}</p>}</details><button type="button" className="text-button" data-source-id={analysis.sourceId} onClick={() => onSource(analysis.sourceId)}><FileText size={14} />Open saved calculation source</button></div></details>
    <p className="financial-checks-note">Checks cover these calculations. Narrative claims and business interpretation still need review.</p>
  </section>;
}
