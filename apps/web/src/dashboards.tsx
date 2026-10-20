import { ShareButton, SharedReports } from './team-sharing';
import { customerOrganization } from './workspace-scope';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, LayoutDashboard, RefreshCw, Search } from 'lucide-react';
import type { Run } from '../../../packages/core/src/types';
import { api, message } from './api';
import { useSavedTables, type SavedTableSummary } from './saved-tables';
import { TabularAnalysisView } from './tabular-analysis';
import { taskTitle } from './run-presentation';
import { DataAsOfText, useRunFreshness } from './connection-freshness';
import { reportBody } from './report-body';
import { savedReportAnalysis } from '../../../packages/core/src/saved-report';
import { SourceAnalysisView, sourceNarrative } from './source-analysis-view';

export function selectedReport(search: string): string | null {
  const params = new URLSearchParams(search);
  const id = params.get('report');
  return params.get('view') === 'dashboards' && id && /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : null;
}

export function Dashboards({ onRun, onSource, onNew, connectionsEnabled = false }: { onRun:(id:string)=>void; onSource:(id:string)=>void; onNew:()=>void; connectionsEnabled?: boolean }) {
  const { page, loading, loadingMore, error, pageError, loadEarlier, refresh } = useSavedTables();
  const [shared,setShared] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() => typeof location === 'undefined' ? null : selectedReport(location.search));
  const [selected, setSelected] = useState<Run | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailRevision, setDetailRevision] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const lastSelectedId = useRef<string | null>(null);
  const selectReport = (id: string | null) => {
    if (id) lastSelectedId.current = id;
    setSelectedId(id);
    const url = new URL(location.href);
    if (id) url.searchParams.set('report', id);
    else url.searchParams.delete('report');
    history.pushState(history.state, '', url);
  };
  useEffect(() => {
    const read = () => setSelectedId(selectedReport(location.search));
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  useEffect(() => {
    if (!selectedId && lastSelectedId.current) {
      listRef.current?.querySelector<HTMLButtonElement>(`[data-run-id="${CSS.escape(lastSelectedId.current)}"]`)?.focus();
    }
  }, [selectedId]);
  const dataAsOf = useRunFreshness(selected?.id === selectedId ? selectedId : null, Boolean(selected) && !['queued', 'running'].includes(selected?.status ?? ''), connectionsEnabled);
  useEffect(() => {
    setSelected(null); setDetailError('');
    if (!selectedId) { setDetailLoading(false); return; }
    const controller = new AbortController();
    setDetailLoading(true);
    void api<Run>(`/api/runs/${encodeURIComponent(selectedId)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(run => { if (!controller.signal.aborted) setSelected(run); })
      .catch(cause => { if (!controller.signal.aborted) setDetailError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId, detailRevision]);
  const analysis = selected ? savedReportAnalysis(selected) : undefined;
  if (shared) return <><div className="sharing-scope-tabs"><button className="text-button" onClick={() => setShared(false)}>My reports</button><button className="text-button" aria-current="page">Shared</button></div><SharedReports onSource={onSource}/></>;
  if (selectedId) return <section className="standard-page dashboard-page">
    <button className="text-button" onClick={() => selectReport(null)}><ArrowLeft size={14} />All reports</button>
    <header className="page-heading"><div><h1>{selected ? selected.result?.title ?? taskTitle(selected) : 'Saved analysis'}</h1><p>{selected ? `Saved ${new Date(selected.createdAt).toLocaleString()}` : detailError ? 'Report could not be opened' : 'Opening report'}</p>{dataAsOf && <p className="data-as-of"><DataAsOfText summary={dataAsOf} /></p>}</div><button className="button secondary" onClick={() => onRun(selectedId)}>Open conversation <ArrowRight size={14} /></button></header>
    {analysis?.kind === 'tabular' && customerOrganization() && <div className="team-share-actions"><ShareButton kind="report" id={`report_${selectedId}`} name={selected ? selected.result?.title ?? taskTitle(selected) : 'Report'} data={{runId:selectedId}}/>{analysis.datasetId.startsWith('team_') && <ShareButton kind="metric" id={`metric_${selectedId}`} name={selected ? selected.result?.title ?? taskTitle(selected) : 'Metric'} data={{datasetId:analysis.datasetId,request:analysis.result.request}}/>}</div>}
    {selected && analysis && !selected.result && !selected.reply && <p className="empty-note">Calculation saved. The explanation is {['queued', 'running'].includes(selected.status) ? 'in progress' : 'incomplete'}.</p>}
    {detailLoading ? <p role="status">Loading saved chart...</p> : detailError ? <p className="module-alert" role="alert">{detailError} <button className="text-button" onClick={() => setDetailRevision(value => value + 1)}>Retry</button></p> : selected && analysis ? <SavedReportContent key={analysis.result.id} run={selected} onSource={onSource} /> : <p className="empty-note">This task has no saved analysis.</p>}
  </section>;
  const search = query.trim().toLowerCase();
  const visible = page.tables.filter(item => `${item.title} ${item.sourceName}`.toLowerCase().includes(search));
  return <section className="module-page module-dashboards">
    {customerOrganization() && <div className="sharing-scope-tabs"><button className="text-button" aria-current="page">My reports</button><button className="text-button" onClick={() => setShared(true)}>Shared</button></div>}
    <div className="module-page-heading"><h1>Reports</h1><button className="button module-primary" onClick={onNew}>Choose sources <ArrowRight size={14} /></button></div>
    <div className="module-library-heading">
      <label className="module-search"><Search size={14} /><input aria-label="Search reports" placeholder="Search reports" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {!loading && !error && <span className="module-library-count" role="status">{search ? `${visible.length} of ` : ''}{page.tables.length} {page.nextCursor ? 'loaded ' : ''}{page.tables.length === 1 ? 'analysis' : 'analyses'}</span>}
      <button className="icon-button" title="Refresh reports" aria-label="Refresh reports" disabled={loading} onClick={refresh}><RefreshCw size={14} /></button>
    </div>
    {error && <p className="module-alert" role="alert">{error} <button className="text-button" onClick={refresh}>Retry</button></p>}
    {loading ? <p className="empty-note" role="status">Loading reports...</p> : visible.length ? <div ref={listRef}>
      <DashboardList items={visible} onOpen={selectReport} />
    </div> : !error && <div className="module-empty"><LayoutDashboard size={25} /><h2>{search ? 'No matching reports' : page.nextCursor ? 'No analyses in this page' : 'No saved analyses yet'}</h2>{search && <button className="text-button" onClick={() => setQuery('')}>Clear search</button>}</div>}
    {page.nextCursor && <div className="library-more"><button className="button secondary" disabled={loading || loadingMore} onClick={() => void loadEarlier()}>{loadingMore ? 'Loading...' : 'Load earlier analyses'}</button></div>}
    {pageError && <p className="module-alert" role="alert">{pageError}<button className="text-button" disabled={loadingMore} onClick={() => void loadEarlier()}>Retry</button></p>}
  </section>;
}

export function SavedReportContent({ run, onSource }: { run: Run; onSource: (id: string) => void }) {
  const answer = run.result ?? run.reply;
  const analysis = savedReportAnalysis(run);
  if (!analysis) return null;
  const report = { content: answer ? reportBody(analysis.kind === 'source' ? sourceNarrative(answer.content) : answer.content, run.result?.title ?? taskTitle(run)) : '', citations: answer?.citations ?? [] };
  return analysis.kind === 'source'
    ? <SourceAnalysisView analysis={analysis} runId={run.id} onSource={onSource} report={report}/>
    : <TabularAnalysisView analysis={analysis} runId={run.id} onSource={onSource} report={report}/>;
}

export function DashboardList({ items, onOpen }: { items: SavedTableSummary[]; onOpen: (id: string) => void }) {
  return <table className="module-library dashboard-library">
    <thead><tr><th scope="col">Analysis</th><th scope="col">Saved</th></tr></thead>
    <tbody>{items.map(item => {
      const filename = item.sourceName.replace(/^(Calculated social CSV|Social CSV) · /, '');
      return <tr key={item.runId}>
        <td><button className="module-row-title" data-run-id={item.runId} aria-label={item.title} title={item.title} onClick={() => onOpen(item.runId)}>
          <span className="module-row-icon"><LayoutDashboard size={18} /></span>
          <span className="dashboard-row-text"><strong>{item.title}</strong><small title={filename}>{filename}</small></span>
        </button></td>
        <td><time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time></td>
      </tr>;
    })}</tbody>
  </table>;
}
