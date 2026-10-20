import { workspaceApiPath } from './workspace-scope';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ChartColumn, Table2, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Maximize2, RotateCcw, Search, X } from 'lucide-react';
import type { ComposeOption, EChartsType } from 'echarts/core';
import type { BarSeriesOption, LineSeriesOption, ScatterSeriesOption } from 'echarts/charts';
import type { AriaComponentOption, GridComponentOption, LegendComponentOption, TooltipComponentOption } from 'echarts/components';
import type { AnalysisResult, AnalysisTableRow, ChartTemplate, MetricId } from '../../../packages/data-layer/src/tabular/types';
import { useCalculationVerification } from './calculation-verification';
import { PostPresentationProvider, usePresentedResult, type PresentedResult } from './post-presentation';
import { analysisColumnLabel } from '../../../packages/data-layer/src/tabular/labels';
import { init, renderChartImage } from './tabular-echarts';
import { initialTabularView, tabularInterpretation } from '../../../packages/presentation/src/tabular-interpretation';
import { ReportBody, type ReportNarrative } from './report-body';
import { TabularTakeaways } from './report-takeaways';

export type { TabularAnalysis } from '../../../packages/core/src/tabular-datasets';
import type { TabularAnalysis } from '../../../packages/core/src/tabular-datasets';
export interface TabularAnalysisViewProps { readonly analysis: TabularAnalysis; readonly runId: string; readonly csvHref?: string; readonly sharedSnapshot?: boolean; readonly report?: ReportNarrative; readonly heading?: string; readonly onSource: (sourceId: string) => void }
import { TABULAR_CHART_LIMIT, METRIC_COLORS, tabularMetricColor, GROUP_LABELS, CHARTS, numericColumns, labelFor, tabularGroupLabel, tabularChartLabels, chartLabelNote, tabularChartSelection, tabularValue, valueOf, timelineRows, renderedRowIndexes, chartMetrics, tabularChartRowIndexes, tabularChartKeyboardPoint, tabularChartPreview, escapeTooltipText, tabularChartTooltip, tabularChartTitle, tabularDateBasis, tabularFilterBasis, tabularAxisValue, metricAxisLabel, chartScope, tabularSelectionBasis, tabularChartOption, type NumericColumn, type TabularChartOption, type Selection, type GraphKind, type ChartPoint } from '../../../packages/presentation/src/tabular-chart';
export * from '../../../packages/presentation/src/tabular-chart';

export function TabularMetricSummary({ result, onInspect }: { readonly result: AnalysisResult; readonly onInspect: (selection: Selection, opener: HTMLButtonElement) => void }) {
  return <div className="tabular-metric-summary" aria-label="Calculated metric totals">{numericColumns(result).slice(0, 3).map(column => {
    const coverage = result.metricCoverage[column.id];
    return <button key={column.id} type="button" className="tabular-summary-value" onClick={event => onInspect({ group: null, metric: column.id }, event.currentTarget)} aria-label={`Show source rows for total ${column.label}`}>
      <span>{column.label}</span><strong>{tabularValue(result.totals[column.id], column.unit)}</strong>
      <small>{result.selection ? 'Full cohort · ' : ''}{coverage && coverage.eligibleRows < coverage.totalRows ? `${coverage.eligibleRows.toLocaleString()} of ${coverage.totalRows.toLocaleString()} rows with required inputs` : column.unit === 'percent' ? 'Overall rate · inspect formula' : 'Across included source rows'}</small>
    </button>;
  })}</div>;
}

export const TABULAR_TABLE_PAGE_SIZE = 25;
export function tabularTablePage(result: AnalysisResult, query = '', page = 0) {
  const needle = query.trim().toLocaleLowerCase(), labels = tabularChartLabels(result), columns = numericColumns(result);
  const matched = result.rows.map((row, index) => ({ row, index })).filter(({ row, index }) => {
    if (!needle) return true;
    const group = tabularGroupLabel(result, row.group);
    return [labels[index], group.label, group.context ?? '', group.postId ?? '', ...columns.map(column => tabularValue(row[column.id], column.unit))].some(value => value.toLocaleLowerCase().includes(needle));
  });
  const pages = Math.max(1, Math.ceil(matched.length / TABULAR_TABLE_PAGE_SIZE));
  const current = Math.min(Math.max(0, Number.isSafeInteger(page) ? page : 0), pages - 1);
  return { rows: matched.slice(current * TABULAR_TABLE_PAGE_SIZE, (current + 1) * TABULAR_TABLE_PAGE_SIZE), matched: matched.length, page: current, pages };
}

interface ResultTableProps { readonly result: AnalysisResult; readonly onInspect?: (selection: Selection, opener: HTMLButtonElement) => void }
export function TabularResultTable(props: ResultTableProps) {
  return <PostPresentationProvider result={props.result}><PresentedResultTable {...props} /></PostPresentationProvider>;
}
function PresentedResultTable({ result: savedResult, onInspect }: ResultTableProps) {
  const result = usePresentedResult(savedResult);
  const columns = numericColumns(result), labels = tabularChartLabels(result);
  const hasContext = result.rows.some(row => Boolean(tabularGroupLabel(result, row.group).context));
  const [query, setQuery] = useState(''), [page, setPage] = useState(0), [expanded, setExpanded] = useState(false), [printing, setPrinting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLButtonElement>(null), uid = useId();
  const shown = useMemo(() => tabularTablePage(result, query, page), [result, query, page]);
  useEffect(() => { setQuery(''); setPage(0); }, [result.id]);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true)), after = () => setPrinting(false);
    window.addEventListener('beforeprint', before); window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); };
  }, []);
  useEffect(() => { if (expanded) dialog.current?.showModal(); else if (dialog.current?.open) dialog.current.close(); }, [expanded]);
  function close() { dialog.current?.close(); setExpanded(false); requestAnimationFrame(() => opener.current?.focus()); }
  function inspect(selection: Selection, button: HTMLButtonElement) {
    if (expanded) {
      close();
      requestAnimationFrame(() => onInspect?.(selection, opener.current ?? button));
    } else onInspect?.(selection, button);
  }
  const rows = printing ? result.rows.map((row, index) => ({ row, index })) : shown.rows;
  const tableTitle = { post: 'Post metrics', account: 'Account metrics', platform: 'Platform metrics', contentType: 'Content metrics', day: 'Daily metrics', week: 'Weekly metrics', month: 'Monthly metrics', all: 'Performance metrics' }[result.request.groupBy];
  const table = <div className="tabular-table-browser">
    <div className="tabular-table-toolbar"><label className="search-field"><Search size={15} /><input aria-label="Search calculated rows" placeholder="Search rows" maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><span role="status">{shown.matched.toLocaleString()}{query.trim() ? ` of ${result.rows.length.toLocaleString()}` : ''} groups</span>{!expanded && <button ref={opener} type="button" className="icon-button" aria-label="Expand calculated table" title="Expand table" onClick={() => setExpanded(true)}><Maximize2 size={16} /></button>}</div>
    <div className="source-csv-scroll tabular-table-viewport" role="region" aria-label="Complete analysis data table" tabIndex={0}>
      <table className="source-csv-table tabular-result-table">
        <caption>{printing ? `All ${result.rows.length.toLocaleString()} saved groups` : `Rows ${shown.matched ? shown.page * TABULAR_TABLE_PAGE_SIZE + 1 : 0}–${Math.min((shown.page + 1) * TABULAR_TABLE_PAGE_SIZE, shown.matched)} of ${shown.matched.toLocaleString()}`}</caption>
        <thead><tr><th scope="col" className="tabular-result-index" aria-label="Result row" title="Saved result row number, not an original CSV row">Row</th><th scope="col">{analysisColumnLabel(result.columns[0], result.request.groupBy)}</th>{hasContext && <th scope="col" className="tabular-result-context">Context</th>}{columns.map(column => <th key={column.id} scope="col">{column.label}</th>)}</tr></thead>
        <tbody>{rows.map(({ row, index }) => {
          const group = tabularGroupLabel(result, row.group);
          return <tr key={row.group}>
            <td className="tabular-result-index">{index + 1}</td>
            <th scope="row"><div className="tabular-result-post"><span className="source-csv-cell" title={labels[index] !== group.label ? `${labels[index]} · ${group.label}` : group.label}>{group.label}</span>{group.url && <a className="tabular-post-link" href={group.url} target="_blank" rel="noopener noreferrer" aria-label={`Open original ${labels[index]}`} title="Open post"><ExternalLink size={14} /><span className="sr-only">Open post</span></a>}</div></th>
            {hasContext && <td className="tabular-result-context"><span className="source-csv-cell">{group.context || '—'}</span></td>}
            {columns.map(column => <td key={column.id}>{onInspect ? <button type="button" aria-label={`Show source rows for ${column.label} for ${group.label}${group.context ? ` (${group.context})` : ''}`} onClick={event => inspect({ group: row.group, metric: column.id }, event.currentTarget)}>{tabularValue(row[column.id], column.unit)}</button> : tabularValue(row[column.id], column.unit)}</td>)}
          </tr>;
        })}{!rows.length && <tr><td colSpan={result.columns.length + 1 + Number(hasContext)}>No rows match{query.trim() ? ' your search' : ' this saved calculation'}.</td></tr>}</tbody>
        <tfoot><tr><td className="tabular-result-index" /><th scope="row" colSpan={hasContext ? 2 : 1}>{result.selection ? 'Full cohort total' : 'All included rows'}</th>{columns.map(column => <td key={column.id}>{onInspect ? <button type="button" aria-label={`Show source rows for total ${column.label}`} onClick={event => inspect({ group: null, metric: column.id }, event.currentTarget)}>{tabularValue(result.totals[column.id], column.unit)}</button> : tabularValue(result.totals[column.id], column.unit)}</td>)}</tr></tfoot>
      </table>
    </div>
    <nav className="tabular-pagination" aria-label="Calculated row pages"><button type="button" aria-label="Previous calculated rows" title="Previous page" disabled={shown.page === 0} onClick={() => setPage(shown.page - 1)}><ChevronLeft size={16} /></button><span>{shown.page + 1} / {shown.pages}</span><button type="button" aria-label="Next calculated rows" title="Next page" disabled={shown.page === shown.pages - 1} onClick={() => setPage(shown.page + 1)}><ChevronRight size={16} /></button></nav>
  </div>;
  return <>{(!expanded || printing) && table}<dialog ref={dialog} className="tabular-chart-dialog tabular-table-dialog" aria-labelledby={`${uid}-title`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }} onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}><header><h2 id={`${uid}-title`}>{tableTitle}</h2><button type="button" className="icon-button" aria-label="Close expanded table" onClick={close}><X size={18} /></button></header>{expanded && !printing && <div className="tabular-chart-dialog-body">{table}</div>}</dialog></>;
}

interface TabularChartProps { result: AnalysisResult; kind: Exclude<ChartTemplate, 'table'>; metric: MetricId; secondary?: MetricId; downloadHref?: string; onInspect: (selection: Selection, opener?: HTMLElement) => void; onExpand?: (opener: HTMLButtonElement) => void }
function TabularChart({ result, kind, metric, secondary, downloadHref, onInspect, onExpand }: TabularChartProps) {
  const host = useRef<HTMLDivElement>(null), wrap = useRef<HTMLDivElement>(null), chart = useRef<EChartsType | null>(null), inspect = useRef(onInspect);
  const pointerType = useRef('mouse'), uid = useId();
  const [point, setPoint] = useState<ChartPoint | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [downloadState, setDownloadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const option = useMemo(() => tabularChartOption(result, kind, metric, secondary), [result, kind, metric, secondary]);
  const preview = point ? tabularChartPreview(result, point.rowIndex, chartMetrics(kind, metric, secondary)) : null;
  inspect.current = onInspect;
  useEffect(() => {
    let observer: ResizeObserver | undefined;
    const hideTip = () => chart.current?.dispatchAction({ type: 'hideTip' });
    const resize = () => { hideTip(); chart.current?.resize(); };
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') hideTip(); };
    setState('loading'); setPoint(null);
    try {
      if (!host.current) return;
      const instance = init(host.current, undefined, { renderer: 'svg' }); chart.current = instance;
      instance.setOption(option, { notMerge: true });
      instance.on('click', (event: unknown) => {
        const selection = tabularChartSelection(result, kind, metric, secondary, event);
        if (!selection) return;
        hideTip();
        if (pointerType.current !== 'mouse') setPoint({ rowIndex: result.rows.findIndex(row => row.group === selection.group), metric: selection.metric });
        else { setPoint(null); inspect.current(selection, wrap.current ?? undefined); }
      });
      instance.on('legendselectchanged', () => { hideTip(); setPoint(null); });
      if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(resize); observer.observe(host.current); }
      window.addEventListener('resize', resize); window.addEventListener('keydown', dismiss); setState('ready');
    } catch {
      observer?.disconnect(); chart.current?.dispose(); chart.current = null;
      setState('error');
    }
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize); window.removeEventListener('keydown', dismiss); chart.current?.dispose(); chart.current = null; };
  }, [option, result, kind, metric, secondary, renderAttempt]);
  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    instance.dispatchAction({ type: 'downplay' });
    instance.dispatchAction({ type: 'hideTip' });
    instance.setOption({ tooltip: { showContent: !point } });
    if (point) {
      const dataIndex = renderedRowIndexes(result, kind, metric, secondary).indexOf(point.rowIndex);
      instance.dispatchAction({ type: 'highlight', seriesIndex: kind === 'combo' && secondary !== metric && point.metric === secondary ? 1 : 0, dataIndex });
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.verification-panel')) return;
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) setPoint(null);
    };
    if (point) document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [point, state, result, kind, metric, secondary]);
  async function downloadImage() {
    setDownloadState('loading');
    try {
      const currentOption = chart.current?.getOption() as TabularChartOption | undefined;
      if (downloadHref) {
        const params = new URLSearchParams({kind,metric,...(secondary ? {secondary} : {})});
        const legend = Array.isArray(currentOption?.legend) ? currentOption.legend[0] : currentOption?.legend;
        for (const [name,selected] of Object.entries(legend?.selected ?? {})) if (!selected) params.append('hidden',name);
        const link = document.createElement('a'); link.href = workspaceApiPath(`${downloadHref}?${params}`); link.download = '';
        document.body.append(link); link.click(); link.remove(); setDownloadState('idle'); return;
      }
      const svg = renderChartImage(currentOption ?? option, tabularChartTitle(result, kind, metric, secondary), `${tabularDateBasis(result)}\n${tabularFilterBasis(result)}${tabularFilterBasis(result) ? '\n' : ''}${chartScope(result)}${chartScope(result) ? '\n' : ''}Source-export counts may be lifetime totals.`);
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `analysis-${kind}-${metric}${secondary && (kind === 'combo' || kind === 'scatter') ? `-${secondary}` : ''}.svg`;
      try { document.body.append(link); link.click(); }
      finally {
        link.remove();
        // Keep the blob alive until the browser has started the download.
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setDownloadState('idle');
    } catch { setDownloadState('error'); }
  }
  return <div className="tabular-chart-block">
    <div className="tabular-chart-actions">{onExpand && <button type="button" className="text-button" onClick={event => onExpand(event.currentTarget)}><Maximize2 size={14} />Expand chart</button>}<button type="button" className="text-button" disabled={downloadState === 'loading'} onClick={() => void downloadImage()} aria-label="Download chart as SVG image"><Download size={14} />{downloadState === 'loading' ? 'Preparing image…' : 'Download image'}</button></div>
    {downloadState === 'error' && <p className="tabular-chart-note" role="alert">The image could not be downloaded. Try again or use the CSV download.</p>}
    <div ref={wrap} className="tabular-chart-wrap" role="group" tabIndex={state === 'ready' ? 0 : -1} aria-label={tabularChartTitle(result, kind, metric, secondary)} aria-describedby={`${uid}-keys`}
      onFocus={event => { if (event.target === event.currentTarget && event.currentTarget.matches(':focus-visible')) setPoint(previous => previous ?? tabularChartKeyboardPoint(result, kind, metric, secondary, null, 'Home')); }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !(event.relatedTarget instanceof Element && event.relatedTarget.closest('.verification-panel'))) setPoint(null); }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          chart.current?.dispatchAction({ type: 'hideTip' });
          if (point) { event.preventDefault(); event.stopPropagation(); setPoint(null); }
          return;
        }
        if (event.target !== event.currentTarget) return;
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); setPoint(previous => tabularChartKeyboardPoint(result, kind, metric, secondary, previous, event.key));
        } else if ((event.key === 'Enter' || event.key === ' ') && point) {
          event.preventDefault(); event.stopPropagation(); inspect.current({ group: result.rows[point.rowIndex].group, metric: point.metric }, event.currentTarget);
        }
      }}>
      <span id={`${uid}-keys`} className="sr-only">Use left and right arrows for groups, up and down for metrics, Home and End for the first and last group. Enter opens source rows. Escape dismisses values. Use the complete data table to inspect all values.</span>
      <div ref={host} className="tabular-chart" role="img" aria-label={tabularChartTitle(result, kind, metric, secondary)} aria-busy={state === 'loading'}
        onPointerDownCapture={event => { pointerType.current = event.pointerType; if (event.pointerType === 'mouse') setPoint(null); }} />
      {state !== 'ready' && <div className="tabular-chart-status" role="status">{state === 'loading' ? 'Loading chart… Saved values are available in the data table.' : <><p>The chart could not render. Your saved values are still available in the data table.</p><button type="button" className="text-button" onClick={() => setRenderAttempt(value => value + 1)}><RotateCcw size={14} />Retry chart</button></>}</div>}
      {preview && point && <div className="tabular-point-preview">
        <div className="tabular-tooltip-content" role="status" aria-live="polite" aria-atomic="true"><strong>{preview.label}</strong>{preview.context && <small>{preview.context}</small>}{preview.values.map(value => <div key={value.id} className="tabular-tooltip-value"><span>{value.label}</span><b>{value.value}</b></div>)}</div>
        <div className="tabular-point-actions"><button type="button" className="text-button" aria-label={`Show source rows for ${labelFor(result, point.metric)}`} onClick={event => inspect.current({ group: result.rows[point.rowIndex].group, metric: point.metric }, event.currentTarget)}><FileText size={14} />Source rows</button><button type="button" className="icon-button" aria-label="Dismiss chart values" title="Dismiss values" onClick={() => { wrap.current?.focus({ preventScroll: true }); setPoint(null); }}><X size={14} /></button></div>
      </div>}
    </div>
  </div>;
}

function ExpandedTabularChart({ open, onClose, onTable, ...props }: TabularChartProps & { open: boolean; onClose: () => void; onTable: () => void }) {
  const uid = useId(), dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) { dialog.current?.showModal(); heading.current?.focus(); }
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  function close() { dialog.current?.close(); onClose(); }
  return <dialog ref={dialog} className="tabular-chart-dialog" aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-scope`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }} onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2 ref={heading} tabIndex={-1} id={`${uid}-title`}>{tabularChartTitle(props.result, props.kind, props.metric, props.secondary)}</h2><button type="button" className="icon-button" aria-label="Close expanded chart" onClick={close}><X size={18} /></button></header>
    {open && <div className="tabular-chart-dialog-body"><p id={`${uid}-scope`} className="tabular-chart-note" style={{ overflowWrap: 'anywhere' }}>{tabularDateBasis(props.result)}{tabularFilterBasis(props.result) && <><br />{tabularFilterBasis(props.result)}</>}</p><TabularChart {...props} /><p className="tabular-chart-note">{chartScope(props.result)}{chartLabelNote(props.result)}Select a mark to inspect its evidence. Open Data to inspect the complete table.</p><button type="button" className="text-button" onClick={() => { close(); onTable(); }}>Close and view complete data table</button></div>}
  </dialog>;
}

export { tabularMetricEvidence } from './verification-calculation-detail';

export function TabularAnalysisView(props: TabularAnalysisViewProps) {
  return <PostPresentationProvider result={props.analysis.result} labels={props.analysis.postLabels} snapshot={props.sharedSnapshot}><PresentedTabularAnalysis {...props} /></PostPresentationProvider>;
}

function PresentedTabularAnalysis({ analysis, runId, onSource, csvHref, sharedSnapshot, report, heading = 'Social performance' }: TabularAnalysisViewProps) {
  const result = usePresentedResult(analysis.result), uid = useId(), columns = numericColumns(result);
  const openVerification = useCalculationVerification(analysis.result.id, runId);
  const defaultMetric = columns.find(column => column.id === result.request.sort?.metric)?.id ?? columns[0]?.id ?? 'postCount';
  const initialKind = initialTabularView(result, defaultMetric);
  const chartAvailable = result.rows.slice(0, TABULAR_CHART_LIMIT).some(row => columns.some(column => valueOf(row, column.id) !== null));
  const [view, setView] = useState<'chart' | 'data'>(() => chartAvailable ? 'chart' : 'data');
  const [kind, setKind] = useState<Exclude<ChartTemplate, 'table'>>(() => initialKind === 'table' ? 'bar' : initialKind), [metric, setMetric] = useState<MetricId>(defaultMetric);
  const [secondary, setSecondary] = useState<MetricId | undefined>(columns.find(column => column.id !== defaultMetric)?.id);
  const [expanded, setExpanded] = useState(false);
  const chartControls = useRef<HTMLSelectElement>(null);
  const expandOpener = useRef<HTMLButtonElement | null>(null), chartTab = useRef<HTMLButtonElement>(null), dataTab = useRef<HTMLButtonElement>(null);
  const safeMetric = columns.some(column => column.id === metric) ? metric : defaultMetric;
  const safeSecondary = columns.find(column => column.id === secondary && (kind === 'combo' || column.id !== safeMetric))?.id ?? columns.find(column => column.id !== safeMetric)?.id ?? (kind === 'combo' ? safeMetric : undefined);
  const safeKind = kind === 'scatter' && !safeSecondary ? 'bar' : kind;
  const activeView = chartAvailable ? view : 'data';
  const title = tabularChartTitle(result, safeKind, safeMetric, safeSecondary);
  const limitedCoverage = columns.some(column => { const coverage = result.metricCoverage[column.id]; return coverage && (coverage.missingRows > 0 || coverage.zeroDenominatorRows > 0); });
  function inspect(selection: Selection, opener?: HTMLElement) {
    if (expanded) {
      setExpanded(false);
      requestAnimationFrame(() => openVerification({ kind: 'tabular', analysis: { ...analysis, result }, runId, selection, sharedSnapshot }, expandOpener.current ?? undefined));
    } else openVerification({ kind: 'tabular', analysis: { ...analysis, result }, runId, selection, sharedSnapshot }, opener ?? chartControls.current ?? undefined);
  }
  function closeExpanded() { setExpanded(false); expandOpener.current?.focus({ preventScroll: true }); }
  function openData() {
    setView('data');
    requestAnimationFrame(() => dataTab.current?.focus());
  }
  const scope = <><p>{tabularDateBasis(result)}</p><p>{result.counts.includedRows.toLocaleString()} of {result.counts.inputRows.toLocaleString()} source rows included</p>{tabularFilterBasis(result) && <p>{tabularFilterBasis(result)}</p>}{limitedCoverage && <p>Some metrics have missing inputs or zero denominators.</p>}</>;
  const visual = <section className="tabular-analysis" aria-labelledby={`${uid}-title`}>
    <header className="tabular-analysis-header"><div><h2 id={`${uid}-title`}>{heading}</h2>{!report && scope}</div><a className="text-button" href={workspaceApiPath(csvHref ?? `/api/runs/${encodeURIComponent(runId)}/tabular.csv`)} download aria-label="Download complete analysis as CSV"><Download size={15} />CSV</a></header>
    {result.selection && <p className="tabular-chart-note">{tabularSelectionBasis(result)}</p>}
    {!report && <><TabularMetricSummary result={result} onInspect={inspect} />
    <p className="tabular-interpretation" aria-label="Result interpretation">{tabularInterpretation(result, safeMetric)}</p></>}
    <section className="tabular-visual" aria-label="Analysis views">
      <header className="tabular-view-header">
      <h3>{title}</h3>
      <div className="tabular-view-tabs" role="tablist" aria-label="Analysis view" onKeyDown={event => {
        if (!chartAvailable || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'chart' : event.key === 'End' ? 'data' : activeView === 'chart' ? 'data' : 'chart';
        setView(next); (next === 'chart' ? chartTab : dataTab).current?.focus();
      }}>
        <button ref={chartTab} type="button" role="tab" id={`${uid}-chart-tab`} aria-controls={`${uid}-chart-panel`} aria-selected={activeView === 'chart'} tabIndex={activeView === 'chart' ? 0 : -1} disabled={!chartAvailable} onClick={() => setView('chart')} aria-label="Chart" title="Chart"><ChartColumn size={16} aria-hidden="true" /></button>
        <button ref={dataTab} type="button" role="tab" id={`${uid}-data-tab`} aria-controls={`${uid}-data-panel`} aria-selected={activeView === 'data'} tabIndex={activeView === 'data' ? 0 : -1} onClick={() => setView('data')} aria-label="Data" title="Data"><Table2 size={16} aria-hidden="true" /></button>
      </div>
      </header>
      <div role="tabpanel" id={`${uid}-chart-panel`} aria-labelledby={`${uid}-chart-tab`} hidden={activeView !== 'chart'} tabIndex={0}>
      {activeView === 'chart' && <>
        <div className="tabular-chart-controls"><label><span>View</span><select ref={chartControls} value={safeKind} onChange={event => setKind(event.target.value as Exclude<ChartTemplate, 'table'>)}>{CHARTS.filter(item => item.id !== 'table').map(item => <option key={item.id} value={item.id} disabled={item.id === 'scatter' && columns.length < 2}>{item.label}</option>)}</select></label><label><span>{safeKind === 'scatter' ? 'X metric' : safeKind === 'combo' ? 'Bar metric' : 'Metric'}</span><select value={safeMetric} onChange={event => setMetric(event.target.value as MetricId)}>{columns.map(column => <option key={column.id} value={column.id}>{column.label}</option>)}</select></label>{(safeKind === 'combo' || safeKind === 'scatter') && <label><span>{safeKind === 'scatter' ? 'Y metric' : 'Line metric'}</span><select value={safeSecondary} onChange={event => setSecondary(event.target.value as MetricId)}>{columns.filter(column => safeKind === 'combo' || column.id !== safeMetric).map(column => <option key={column.id} value={column.id}>{column.label}</option>)}</select></label>}</div>
        <TabularChart downloadHref={sharedSnapshot ? undefined : `/api/runs/${encodeURIComponent(runId)}/tabular.svg`} result={result} kind={safeKind} metric={safeMetric} secondary={safeSecondary} onInspect={inspect} onExpand={opener => { expandOpener.current = opener; setExpanded(true); }} />
        {result.rows.length > TABULAR_CHART_LIMIT && <p className="tabular-chart-note">First {TABULAR_CHART_LIMIT} of {result.rows.length.toLocaleString()} saved groups shown in the chart.</p>}
        <ExpandedTabularChart downloadHref={sharedSnapshot ? undefined : `/api/runs/${encodeURIComponent(runId)}/tabular.svg`} open={expanded} onClose={closeExpanded} onTable={openData} result={result} kind={safeKind} metric={safeMetric} secondary={safeSecondary} onInspect={inspect} />
      </>}
      </div>
      <div className="tabular-data-panel" role="tabpanel" id={`${uid}-data-panel`} aria-labelledby={`${uid}-data-tab`} hidden={activeView !== 'data'} tabIndex={0}>
        {!result.rows.length && <p className="tabular-empty" role="status">No rows matched this saved analysis.</p>}
        <TabularResultTable result={result} onInspect={inspect} />
        <p className="tabular-chart-note">“—” means missing or undefined, not zero.</p>
      </div>
    </section>
  </section>;
  return report ? <ReportBody {...report} onSource={onSource} scope={scope} takeaways={<TabularTakeaways result={result} onInspect={inspect}/>}>{visual}</ReportBody> : visual;
}
