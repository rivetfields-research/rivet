import { runTitle, taskTitle } from './run-presentation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUp, ArrowDown, CornerDownLeft, BookOpen, Check, CircleAlert, CirclePause, Clock3, FileText, ListChecks, Search, Settings2, ShieldCheck, Table2, RefreshCw, X } from 'lucide-react';
import type { RunSummary, Source, WorkspaceStatus } from '../../../packages/core/src/types';
import { sidebarViewIds, workspaceDestinations, type View } from './navigation';
import { useSavedTables } from './saved-tables';
export { appendSavedTablePage, type SavedTableSummary, type SavedTablesPage } from './saved-tables';

const statusLabels: Record<string,string> = { queued: 'Queued', running: 'Working', completed: 'Complete', cancelled: 'Stopped', failed: 'Failed', interrupted: 'Interrupted' };
const date = (value:string) => new Date(value).toLocaleDateString([], { month:'short',day:'numeric' });

export function AgentResources({workspace,onKnowledge}:{workspace:WorkspaceStatus|null;onKnowledge:()=>void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const healthcare = workspace?.profile.id === 'healthcare-operations';
  return <div className="agent-resources">
    <button type="button" onClick={onKnowledge}><BookOpen size={14}/><span>{healthcare ? 'Knowledge' : 'Files'}</span><span className="resource-count">{workspace?.sources.length ?? '—'}</span></button>
    <button type="button" onClick={() => dialog.current?.showModal()}><Settings2 size={14}/><span>Tools</span><span className="resource-count">{workspace?.profile.tools.length ?? '—'}</span></button>
    <dialog ref={dialog} className="agent-tools-dialog" aria-labelledby="agent-tools-title" onClick={event => { if(event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if(event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.current?.close(); } }}>
      <header><h2 id="agent-tools-title">Agent tools</h2><button type="button" className="icon-button" onClick={() => dialog.current?.close()} aria-label="Close agent tools"><X size={16}/></button></header>
      <div className="agent-tools-body"><p>Available for tasks using this workspace’s approved notes.</p>
        <div className="agent-tool-rows">{workspace?.profile.tools.map(tool => <div key={tool}><Settings2 size={17}/><span><strong>{tool === 'workspace.search' ? 'Search notes' : tool === 'workspace.read' ? 'Read a source' : tool === 'workspace.calculate_usage' ? 'Calculate usage' : tool === 'workspace.calculate_financial' ? 'Calculate financials' : tool}</strong><code>{tool}</code></span><span>Available</span></div>)}</div>
        <div className="agent-model-status"><span className={`status-dot ${workspace?.provider.available ? 'ready' : 'failed'}`}/><strong>{workspace?.provider.available ? 'Rivet available' : 'Rivet unavailable'}</strong></div>
        <p>Your agent can search these sources and prepare a brief. {healthcare ? 'Other app connections are available to explore in Connectors.' : 'Connection status is available in Settings.'}</p>
      </div>
    </dialog>
  </div>;
}

function TaskNotice({ run }: { run: RunSummary }) {
  if (run.status === 'completed') return null;
  const active = run.status === 'queued' || run.status === 'running';
  const stopped = run.status === 'cancelled';
  const Icon = active ? Clock3 : stopped ? CirclePause : CircleAlert;
  const label = active ? statusLabels[run.status] : run.hasSavedCalculation ? 'Calculation saved; explanation incomplete' : stopped ? 'Stopped' : 'Needs attention';
  return <small className={`task-notice ${active ? 'active' : stopped ? 'stopped' : 'attention'}`} title={statusLabels[run.status]}><Icon size={13} aria-hidden="true"/>{label}</small>;
}

export function TaskLibrary({runs,kind,onOpen,onNew,onExample,hasMore=false,loadingMore=false,loadError='',onLoadMore,healthcare=false}:{runs:RunSummary[];kind:'tasks'|'reports'|'artifacts';onOpen:(id:string)=>void;onNew:()=>void;onExample?:()=>void;hasMore?:boolean;loadingMore?:boolean;loadError?:string;onLoadMore?:()=>void;healthcare?:boolean}) {
  const [query,setQuery]=useState('');
  const tasks = kind === 'tasks';
  const noun = tasks && !healthcare ? 'conversation' : 'task';
  const title = tasks ? healthcare ? 'Tasks' : 'Conversations' : kind === 'artifacts' ? 'Artifacts' : 'Reports';
  const searchLabel = tasks ? `${noun}s` : kind;
  const search = query.trim().toLowerCase();
  const filtered=runs.filter(run => (tasks || run.artifactTitle) && `${run.task} ${run.artifactTitle??''}`.toLowerCase().includes(search));
  return <div className={`standard-page library-page${tasks ? ' task-history' : ''}`}>
    <div className="page-heading"><div><h1>{title}</h1>{!tasks && <p>{kind === 'artifacts' ? 'Reports and visual analyses from your tasks.' : 'Saved reports from your tasks.'}</p>}</div><button className="button primary" onClick={onNew}>New {noun} <ArrowRight size={14}/></button></div>
    <div className="library-toolbar">
      {!tasks && <span className="small muted">{filtered.length} {filtered.length === 1 ? 'report' : 'reports'}</span>}
      <label className="search-field"><Search size={14} aria-hidden="true"/><input aria-label={`Search ${searchLabel}`} placeholder={`Search ${searchLabel}…`} value={query} onChange={event => setQuery(event.target.value)}/></label>
      {tasks && <span className="small muted task-count" role="status">{search ? `${filtered.length} of ` : ''}{runs.length} {hasMore ? 'loaded ' : ''}{noun}{runs.length === 1 ? '' : 's'}</span>}
    </div>
    <div className="library-table">
      <div className="library-columns" aria-hidden="true"><span>{tasks ? healthcare ? 'Task' : 'Conversation' : kind === 'artifacts' ? 'Artifact' : 'Report'}</span>{!tasks && <span>Status</span>}<span>Created</span></div>
      {filtered.map(run => <button className="library-record" key={run.id} onClick={() => onOpen(run.id)}>
        <span className="library-name"><FileText size={17} aria-hidden="true"/><span>
          <strong title={runTitle(run)}>{runTitle(run)}</strong>
          {run.artifactTitle && (!tasks || run.workflowId) && <small>{run.workflowId ? `Workflow run · v${run.workflowVersion}` : taskTitle(run)}</small>}
          {tasks && <TaskNotice run={run}/>}
        </span></span>
        {!tasks && <span className={`pill ${run.status}`}>{run.hasReply ? 'Replied' : statusLabels[run.status]}</span>}
        <time dateTime={run.createdAt}>{date(run.createdAt)}</time>
      </button>)}
      {!filtered.length && <div className="intentional-empty"><ListChecks size={25}/><h2>{search ? 'No matching work' : kind === 'artifacts' ? 'Your artifacts will live here' : kind === 'reports' ? 'Your reports will live here' : `No ${noun}s yet`}</h2>{!tasks && <p>{search ? 'Try another title or clear the search.' : 'Start with your notes. Completed work stays available to inspect and reuse.'}</p>}{search ? <button className="text-button" onClick={() => setQuery('')}>Clear search</button> : <button className="button secondary" onClick={onNew}>Start a {noun} <ArrowRight size={14}/></button>}</div>}
    </div>
    {!runs.length && onExample && <button className="text-button empty-example-link" onClick={onExample}>Explore an example workspace <ArrowRight size={13}/></button>}
    {hasMore && <div className="library-more"><p className="small muted">Showing loaded work. Load earlier tasks to include older results in your search.</p><button className="button secondary" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load earlier work'}</button></div>}
    {loadError && <p role="alert">{loadError}</p>}
  </div>;
}

export function ReviewPage({runs,onOpen}:{runs:RunSummary[];onOpen:(id:string)=>void}) {
  const completed=runs.filter(run=>run.artifactTitle);
  return <div className="standard-page library-page"><div className="page-heading"><div><span className="eyebrow">Human judgment, in the loop</span><h1>Review</h1><p>Read the result, inspect its evidence, and decide what happens next.</p></div></div><div className="review-inbox"><ShieldCheck size={25}/><div><h2>No action requests</h2><p>Connected actions will appear here before an agent sends, publishes, or changes something. Action approvals are not connected yet.</p></div><span className="pill">Preview</span></div><div className="section-label review-heading"><h2>Saved outputs to inspect</h2><span>{completed.length}</span></div>{completed.map(run=><button className="review-output" key={run.id} onClick={()=>onOpen(run.id)}><FileText size={20}/><span><strong>{run.artifactTitle}</strong><small>Open the brief and its source evidence</small></span><ArrowRight size={15}/></button>)}{!completed.length&&<p className="empty-note">Your first completed brief will appear here.</p>}</div>;
}

export function WorkspaceSearch({open,onClose,runs,sources,onNavigate,onRun,onSource,healthcare=false}:{healthcare?:boolean;open:boolean;onClose:()=>void;runs:RunSummary[];sources:Source[];onNavigate:(view:View)=>void;onRun:(id:string)=>void;onSource:(id:string)=>void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const q = query.trim().toLowerCase();
  const pages = workspaceDestinations(healthcare).filter(item => q || (healthcare ? item.id !== 'assistant' : sidebarViewIds.includes(item.id)));
  const candidates = [
    ...pages.map(item => ({ id: `view-${item.id}`, label: item.label, keywords: item.description, detail: '', icon: item.icon, group: 'Pages', action: () => onNavigate(item.id) })),
    ...runs.map(run => ({ id: `run-${run.id}`, label: runTitle(run), keywords: run.task, detail: run.hasReply ? 'Replied' : statusLabels[run.status], icon: FileText, group: q ? 'Tasks' : 'Recent work', action: () => onRun(run.id) })),
    ...sources.map(source => ({ id: `source-${source.id}`, label: source.title, keywords: source.path, detail: 'File', icon: BookOpen, group: healthcare ? 'Knowledge' : 'Files', action: () => onSource(source.id) })),
  ];
  const results = candidates.filter(item => `${item.label} ${item.keywords}`.toLowerCase().includes(q)).slice(0, 40);
  const selectedIndex = Math.min(index, Math.max(0, results.length - 1));
  const groups = [...new Set(results.map(item => item.group))];
  useEffect(() => {
    if (open) { setQuery(''); setIndex(0); dialog.current?.showModal(); input.current?.focus(); }
    else dialog.current?.close();
  }, [open]);
  useEffect(() => { if (open) document.getElementById(`workspace-result-${selectedIndex}`)?.scrollIntoView({ block: 'nearest' }); }, [selectedIndex, open, query]);
  function choose(item: typeof results[number]) { onClose(); item.action(); }
  return <dialog ref={dialog} className="workspace-search" aria-label="Search workspace" onCancel={onClose} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <div className="command-input"><Search size={19} aria-hidden="true"/>
      <input ref={input} autoFocus role="combobox" aria-expanded={open} aria-controls="workspace-results" aria-activedescendant={results[selectedIndex] ? `workspace-result-${selectedIndex}` : undefined} aria-autocomplete="list" placeholder="Search workspace…" aria-label="Search workspace" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          if (results.length) setIndex((selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
        }
        if (event.key === 'Enter' && results[selectedIndex]) { event.preventDefault(); choose(results[selectedIndex]); }
      }}/>
      <button className="command-close" onClick={onClose} aria-label="Close search"><kbd>esc</kbd></button>
    </div>
    <div className="command-results" role="listbox" aria-label="Workspace search results" id="workspace-results">
      {groups.map(group => <div className="command-group" role="group" aria-label={group} key={group}>
        <div className="command-group-title" aria-hidden="true">{group}</div>
        {results.map((item, i) => item.group !== group ? null : <button type="button" role="option" aria-selected={selectedIndex === i} tabIndex={-1} id={`workspace-result-${i}`} className={`command-result${selectedIndex === i ? ' highlighted' : ''}`} key={item.id} onClick={() => choose(item)} onPointerMove={() => setIndex(i)}>
          <item.icon size={17} aria-hidden="true"/><span className="command-label">{item.label}</span>
          {item.detail && <span className="command-meta">{item.detail}</span>}
          <CornerDownLeft size={14} className="command-enter" aria-hidden="true"/>
        </button>)}
      </div>)}
      {!results.length && <div className="command-empty"><Search size={23}/><strong>No results for “{query}”</strong><p>Try a page, task or source name.</p><button onClick={() => { setQuery(''); input.current?.focus(); }}>Clear search</button></div>}
    </div>
    <footer><span><kbd><ArrowUp size={11}/><ArrowDown size={11}/></kbd> Navigate</span><span><kbd><CornerDownLeft size={12}/></kbd> Open</span><span className="command-scope">This workspace</span></footer>
    <span className="sr-only" role="status">{results.length} results</span>
  </dialog>;
}


export function SavedTablesLibrary({ onOpenRun, onNew, legacy }: { onOpenRun: (id: string) => void; onNew: () => void; legacy: ReactNode }) {
  const { page, loading, loadingMore, error, pageError, loadEarlier, refresh } = useSavedTables();
  const tables = page.tables;
  const [query, setQuery] = useState('');
  const [showLegacy, setShowLegacy] = useState(false);
  if (showLegacy) return <><div className="module-legacy-back"><button className="text-button" onClick={() => setShowLegacy(false)}>Back to saved tables</button></div>{legacy}</>;
  const visible = tables.filter(table => `${table.title} ${table.sourceName}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="module-page module-tables"><div className="module-page-heading"><div><h1>Tables</h1><p>Saved calculations, with their source rows.</p></div><button className="button module-primary" onClick={onNew}>Analyze a file <ArrowRight size={14}/></button></div>
    <div className="module-library-heading"><span className="module-library-count">{tables.length} {page.nextCursor ? 'loaded' : 'saved'} {tables.length === 1 ? 'table' : 'tables'}</span><label className="module-search"><Search size={14}/><input aria-label="Search saved tables" placeholder="Search tables" value={query} onChange={event => setQuery(event.target.value)}/></label><button className="icon-button" aria-label="Refresh saved tables" onClick={refresh} disabled={loading}><RefreshCw size={14}/></button></div>
    {error && <div className="module-alert" role="alert"><span>{error}</span><button onClick={refresh}>Retry</button></div>}
    {loading ? <p role="status" className="empty-note">Loading saved tables…</p> : visible.length ? <div className="module-table-wrap"><table className="module-library"><thead><tr><th>Table</th><th>Rows</th><th>Saved</th><th><span className="sr-only">Open table</span></th></tr></thead><tbody>{visible.map(table => <tr key={table.runId}><td><button className="module-row-title" onClick={() => onOpenRun(table.runId)}><span className="module-row-icon"><Table2 size={18}/></span><span><strong>{table.title}</strong><small>{table.sourceName}</small></span></button></td><td>{table.groupCount.toLocaleString()}<small>{table.rowCount.toLocaleString()} input rows</small></td><td><time dateTime={table.createdAt}>{date(table.createdAt)}</time></td><td><button className="module-open-row" aria-label={`Open ${table.title}, table, export and evidence`} onClick={() => onOpenRun(table.runId)}><ArrowRight size={15}/></button></td></tr>)}</tbody></table></div> : !error && <div className="module-empty"><Table2 size={25}/><h2>{query ? 'No matching tables' : page.nextCursor ? 'No tables in the loaded work' : 'No saved tables yet'}</h2><p>{query ? 'Try another name or load earlier work.' : page.nextCursor ? 'Load earlier work to find older saved calculations.' : 'Analyze an attached file to save a table here.'}</p></div>}
    {page.nextCursor && <div className="library-more"><button className="button secondary" disabled={loading || loadingMore} onClick={() => void loadEarlier()}>{loadingMore ? 'Loading…' : 'Load earlier tables'}</button></div>}
    {pageError && <p role="alert">{pageError} <button className="module-link" disabled={loadingMore} onClick={() => void loadEarlier()}>Retry earlier tables</button></p>}
    <details className="module-template-disclosure"><summary>Earlier table briefs</summary><p className="module-tiny">Your browser drafts are still available.</p><button className="module-link" onClick={() => setShowLegacy(true)}>Open browser drafts <ArrowRight size={13}/></button></details>
  </section>;
}
