import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { workspaceApiPath } from './workspace-scope';
import { flushSync } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, FileText, RotateCcw, ShieldCheck } from 'lucide-react';
import type { EChartsType } from 'echarts/core';
import type { SourceAnalysis } from '../../../packages/core/src/source-analysis';
import { init, renderChartImage } from './tabular-echarts';
import { tabularValue, type TabularChartOption } from './tabular-analysis';
import { ReportBody, type ReportNarrative } from './report-body';
import { SourceTakeaways } from './report-takeaways';
import { useCalculationVerification } from './calculation-verification';

import { type Result, type SourceChartKind, type Evidence, type DisplayRow, sourceChartRows, chronological, sourceChartChoices, recommendedSourceChart, columns, title, displayedRows, sourceChartOption } from '../../../packages/presentation/src/source-chart';
export * from '../../../packages/presentation/src/source-chart';

/** The server appends a checked text receipt for portable exports; the UI renders that saved result directly. */
export function sourceNarrative(content: string): string {
  const appendix = content.lastIndexOf('\n\n## Checked source review\n');
  return appendix < 0 ? content : content.slice(0, appendix);
}
const CHART_NAMES: Record<SourceChartKind, string> = { horizontalBar: 'Horizontal bar', bar: 'Bar', line: 'Line', area: 'Area', scatter: 'Scatter', table: 'Table' };

function SourceChart({ result, kind, runId, onEvidence }: { result: Result; kind: Exclude<SourceChartKind, 'table'>; runId?: string; onEvidence: () => void }) {
  const host = useRef<HTMLDivElement>(null), chart = useRef<EChartsType | null>(null);
  const [failed, setFailed] = useState(false), [retry, setRetry] = useState(0), [exportFailed, setExportFailed] = useState(false);
  const option = useMemo(() => sourceChartOption(result, kind), [result, kind]);
  useEffect(() => {
    let observer: ResizeObserver | undefined;
    setFailed(false);
    try {
      if (!host.current) return;
      const instance = init(host.current, undefined, { renderer: 'svg' }); chart.current = instance;
      instance.setOption(option);
      observer = new ResizeObserver(() => instance.resize()); observer.observe(host.current);
    } catch { observer?.disconnect(); chart.current?.dispose(); chart.current = null; setFailed(true); }
    return () => { observer?.disconnect(); chart.current?.dispose(); chart.current = null; };
  }, [option, retry]);
  function download() {
    try {
      if (runId) {
        const link = document.createElement('a');
        link.href = workspaceApiPath(`/api/runs/${encodeURIComponent(runId)}/source.svg?kind=${encodeURIComponent(kind)}`);
        link.download = ''; document.body.append(link); link.click(); link.remove(); setExportFailed(false); return;
      }
      const svg = renderChartImage(option, title(result), `Saved observation: ${result.observations.map(item => item.observedAt).join(' / ')}`);
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'source-analysis.svg'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setExportFailed(false);
    } catch { setExportFailed(true); }
  }
  return <div className="tabular-chart-block">
    <div className="tabular-chart-actions"><button type="button" className="text-button" onClick={onEvidence}><ShieldCheck size={14}/>Verification Hub</button><button type="button" className="text-button" onClick={download} aria-label="Download source chart as SVG"><Download size={14}/>Download image</button></div>
    {exportFailed && <p role="alert">The image could not be prepared. Your saved data is unchanged.</p>}
    <div className="tabular-chart-wrap"><div ref={host} className="tabular-chart" role="img" aria-label={title(result)}/>
      {failed && <div className="tabular-chart-status" role="status"><p>The chart could not render. The saved table is still available.</p><button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}><RotateCcw size={14}/>Retry chart</button></div>}
    </div>
  </div>;
}

export function SourceAnalysisView({ analysis, runId, onSource, report }: { analysis: SourceAnalysis; runId?: string; onSource: (id: string) => void; report?: ReportNarrative }) {
  const result = analysis.result, uid = useId();
  const [kind, setKind] = useState<SourceChartKind>(() => recommendedSourceChart(result)), [page, setPage] = useState(0);
  const [printing, setPrinting] = useState(false);
  const openVerification = useCalculationVerification(analysis.result.id, runId);
  function inspect(row?: DisplayRow) { openVerification({ kind: 'source', analysis, runId, row }); }
  const rows = displayedRows(result, kind), names = columns(result), pages = Math.max(1, Math.ceil(rows.length / 25));
  const currentPage = Math.min(page, pages - 1);
  const shown = printing ? rows : rows.slice(currentPage * 25, (currentPage + 1) * 25);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true)), after = () => setPrinting(false);
    window.addEventListener('beforeprint', before); window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); };
  }, []);
  const rowNumber = (index: number) => (printing ? 0 : currentPage * 25) + index + 1;
  const scope = <><p>{result.operation === 'review' ? `${result.counts.includedRecords} collected ${result.counts.includedRecords === 1 ? 'record' : 'records'} included · ${result.timezone ?? 'Timezone unknown'}` : `${rows.length} saved ${result.operation === 'compare' ? 'records' : 'pairs'}`}</p>{result.operation === 'review' && <p>{result.request.dateRange ? `${result.request.dateRange.from} (inclusive) to ${result.request.dateRange.to} (exclusive)` : 'All dates in the saved source'} · {result.dateBasis === 'publication_utc' ? 'Publication dates' : 'Provider reporting periods'}</p>}</>;
  const visual = <section className="tabular-analysis source-analysis" aria-labelledby={`${uid}-title`}>
    <header className="tabular-analysis-header"><div><h2 id={`${uid}-title`}>{report ? 'Source performance' : title(result)}</h2>{!report && scope}</div></header>
    <div className="tabular-chart-controls"><label><span>View</span><select aria-label="Source chart view" value={kind} onChange={event => { setKind(event.target.value as SourceChartKind); setPage(0); }}>{sourceChartChoices(result).map(choice => <option key={choice} value={choice}>{CHART_NAMES[choice]}</option>)}</select></label></div>
    {rows.length === 0 ? <p className="tabular-empty" role="status">No records matched this saved analysis.</p> : kind !== 'table' && <SourceChart result={result} kind={kind} runId={runId} onEvidence={() => inspect()}/>}
    {rows.length > 50 && kind !== 'table' && <p className="tabular-chart-note">First 50 of {rows.length} saved rows shown. The table retains all saved rows.</p>}
    {result.operation === 'review' && result.counts.returnedGroups < result.counts.totalGroups && <p className="tabular-chart-note">{result.counts.returnedGroups} of {result.counts.totalGroups} groups shown, ranked by known values. Totals cover the full filtered cohort.</p>}
    <details className="source-supporting-table" open={!report || kind === 'table' || printing}><summary>Supporting data</summary><div className="tabular-scroll" role="region" aria-label="Saved source analysis table" tabIndex={0}><table>
      <thead><tr><th>Record / group</th>{names.map((name, index) => <th key={index}>{name}</th>)}<th>Evidence</th></tr></thead>
      <tbody>{shown.map((row, index) => <tr key={row.key}><th scope="row"><small className="tabular-group-context">Record {rowNumber(index)}</small>{row.label}</th>{row.values.map((value, index) => <td key={index}>{tabularValue(value)}</td>)}<td><button type="button" className="text-button" onClick={() => inspect(row)} aria-label={`Inspect source record ${rowNumber(index)}`}><FileText size={14}/>Inspect</button></td></tr>)}</tbody>
    </table></div>
    {pages > 1 && <div className="tabular-pagination"><span>{currentPage + 1} of {pages}</span><button type="button" aria-label="Previous source rows" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14}/></button><button type="button" aria-label="Next source rows" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={14}/></button></div>}
    <p className="tabular-chart-note">“—” means unknown or not additive, not zero.</p></details>
    <p className="tabular-chart-note">{result.operation === 'compare' ? 'Net change between saved snapshots, not a complete activity log.' : result.operation === 'correlate' || result.operation === 'join' ? 'Matched saved records; a relationship is not proof of attribution or causation.' : result.operation === 'review' && result.metric.basis === 'lifetime' ? 'Lifetime counts at collection; dates select when content was published.' : 'Values use the saved provider reporting periods.'}{result.operation === 'review' && result.totals.missingRecords > 0 && ' Some records have missing inputs.'}{result.observations.some(item => item.capped || item.coverage !== 'complete') && ' Collection coverage is limited or unknown.'}</p>
  </section>;
  return report ? <ReportBody {...report} onSource={onSource} scope={scope} takeaways={result.operation === 'review' ? <SourceTakeaways result={result} sourceId={analysis.sourceId} onTotal={() => inspect()} onRecord={inspect}/> : undefined}>{visual}</ReportBody> : visual;
}
