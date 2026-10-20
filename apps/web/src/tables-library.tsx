import { ShareButton } from './team-sharing';
import { allowsManualImports, customerOrganization } from './workspace-scope';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Cable, FileText, Plus, RefreshCw, Search, Table2 } from 'lucide-react';
import type { SourceDocument, WorkspaceStatus } from '../../../packages/core/src/types';
import { sourceCalculationId, sourceTableKind } from '../../../packages/core/src/source-table';
import { CalculatedSourceTable } from './calculated-source';
import { api, message } from './api';
import { connectionNames, useSourceFreshness, type SourceFreshness } from './connection-freshness';
import { localTime } from './connection-model';
import { useConnections } from './use-connections';
import { SourceConnectPage } from './source-connect-page';
import { rememberConnectStep, sourceConnectStep } from './source-connect-options';
import { SourceConnectionDetail } from './source-connection-detail';
import { sourceLibraryEntries, visibleSourceEntries, selectedSourceConnection, rememberSourceConnection, type SourceLibraryEntry } from './source-connections';
import { FileUpload } from './file-upload';
import { Markdown } from './markdown';
import { SourceDatasetView } from './source-dataset-view';
import { canManageSources, type WorkspaceSession } from './session-access';
import { rememberTableSource, selectedTableSource } from './table-source-navigation';
import { libraryFileName, libraryItems, type LibraryCategory, type LibrarySort } from './tables-library-items';
import { RestoreSourceButton, type RestoreSource } from './restore-source';
import { PlatformIcon } from './platform-icon';
import './tables-library.css';

/**
 * A connection badge and its newest acquisition time. Names are shown only to people who manage connections; when
 * several connections produced identical data (one shared table), all of them are named, or counted past three.
 */
export function ConnectionBadge({ fresh }: { fresh: SourceFreshness }) {
  const names = connectionNames(fresh);
  return <small className="tables-connection" title={fresh.connections && fresh.connections.length > 3 ? fresh.connections.map(item => item.displayName).join(', ') : undefined}><Cable size={12} aria-hidden="true"/>{names ?? 'Connected source'} · Data as of <time dateTime={fresh.observedAt}>{localTime(fresh.observedAt)}</time></small>;
}
/**
 * Connection health is separate from this: the file page says only where its data came from and how current it is.
 * "Does not refresh itself" is said only after freshness was read successfully and did not include this file.
 */
export function FileFreshness({ fresh, csv, checked }: { fresh?: SourceFreshness; csv: boolean; checked: boolean }) {
  if (fresh) return <p className="data-as-of">From {connectionNames(fresh) ?? 'a connected source'} · Data as of <time dateTime={fresh.observedAt}>{localTime(fresh.observedAt)}</time></p>;
  return csv && checked ? <p className="data-as-of">Uploaded file · No automatic updates</p> : null;
}

export function TablesLibrary({ workspace, session, onRefresh, onSource, onUsePrompt, onAskSource, onRestoreSource, readOnly = false }: {
  workspace: WorkspaceStatus | null; onRefresh: () => Promise<void>; onSource: (id:string) => void;
  onUsePrompt: (prompt:string, sourceIds?:string[]) => void; onAskSource: (sourceId:string) => void;
  readOnly?:boolean;
  onRestoreSource?: RestoreSource;
  session?: WorkspaceSession | null;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<LibraryCategory | 'connections' | 'archived'>('all');
  const [sort, setSort] = useState<LibrarySort>('newest');
  const [selectedId, setSelectedId] = useState<string|null>(() => typeof location === 'undefined' ? null : selectedTableSource(location.search));
  const [connectStep, setConnectStep] = useState(() => typeof location === 'undefined' ? null : sourceConnectStep(location.search));
  const [connectionId, setConnectionId] = useState(() => typeof location === 'undefined' ? null : selectedSourceConnection(location.search));
  const [source, setSource] = useState<SourceDocument|null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [revision, setRevision] = useState(0);
  const [freshnessRevision, setFreshnessRevision] = useState(0);
  const manualImports = allowsManualImports();
  const managesConnections = workspace?.connectionsEnabled === true && canManageSources(session) && !readOnly;
  const canOpenSourceSetup = managesConnections || Boolean(workspace && manualImports && canManageSources(session) && !readOnly);
  const feedbackScope = connectStep ? `connect:${connectStep}` : connectionId ? `connection:${connectionId}` : selectedId ? `source:${selectedId}` : 'library';
  const connections = useConnections(session, freshnessRevision, canOpenSourceSetup, feedbackScope);
  const latestVersions = JSON.stringify(connections.data?.connections.map(item => item.latestVersion) ?? []);
  const refreshSources = useRef(onRefresh);
  refreshSources.current = onRefresh;
  const lastVersions = useRef('[]');
  useEffect(() => {
    if (latestVersions === lastVersions.current) return;
    lastVersions.current = latestVersions;
    void refreshSources.current().catch(cause => setRefreshError(message(cause)));
  }, [latestVersions]);
  useEffect(() => {
    if (!connections.focusConnection) return;
    connections.keepNoticeOnNextScope(`connection:${connections.focusConnection}`);
    setConnectionId(connections.focusConnection);
    rememberSourceConnection(connections.focusConnection);
  }, [connections.focusConnection]);
  useEffect(() => {
    const read = () => { setSelectedId(selectedTableSource(location.search)); setConnectionId(selectedSourceConnection(location.search)); setConnectStep(sourceConnectStep(location.search)); };
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  // Only connection-backed CSV tables have a "Data as of"; uploads keep the version they were saved with. Nothing is
  // requested when this runtime serves no connections.
  const { freshness, state: freshnessState } = useSourceFreshness((workspace?.sources ?? []).filter(item => sourceTableKind(item) && !item.path.startsWith('calculations/')).map(item => item.id),
    workspace?.connectionsEnabled === true, freshnessRevision);
  const heading = useRef<HTMLHeadingElement>(null);
  const lastOpened = useRef<string|null>(null);
  const archived = workspace?.archivedSources?.find(item => item.source.id === selectedId);
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setLoading(true); setSource(null); setError('');
    void api<SourceDocument>(`/api/sources/${encodeURIComponent(selectedId)}`, {signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])})
      .then(value => {
        if (value.id !== selectedId) throw new Error('The selected file could not be confirmed.');
        if (!controller.signal.aborted) setSource(value);
      })
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selectedId, revision]);
  useEffect(() => { if (selectedId) heading.current?.focus(); }, [selectedId]);
  function open(id:string) { setConnectionId(null); rememberSourceConnection(null); lastOpened.current = `source-${id}`; setSource(null); setError(''); setLoading(true); setSelectedId(id); rememberTableSource(id); }
  function back() {
    setSelectedId(null);
    setConnectionId(null);
    rememberSourceConnection(null);
    rememberTableSource(null);
    requestAnimationFrame(() => (document.getElementById(`library-file-${lastOpened.current}`) ?? document.getElementById('tables-library-heading'))?.focus());
  }
  function connect(step: string | null) {
    if (!step) connections.keepNoticeOnNextScope('library');
    setConnectStep(step);
    rememberConnectStep(step);
    if (!step) requestAnimationFrame(() => document.getElementById('tables-connect-accounts')?.focus());
  }
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true); setRefreshError('');
    try { await onRefresh(); } catch (cause) { setRefreshError(message(cause)); } finally { setRefreshing(false); setFreshnessRevision(value => value + 1); }
  }
  function useFile(file:SourceDocument) {
    onAskSource(file.id);
  }
  function openItem(item: SourceLibraryEntry) {
    if (item.kind === 'connection') {
      lastOpened.current = item.id;
      setSelectedId(null); setConnectionId(item.connection.id); rememberSourceConnection(item.connection.id);
    } else if (item.kind === 'source') open(item.source.id);
  }
  const upload = manualImports ? <FileUpload disabled={!workspace || readOnly} onSaved={onRefresh} onOpen={id => { setConnectStep(null); rememberConnectStep(null, false); open(id); }} onUse={useFile} onPrepareTask={(prompt, file) => onUsePrompt(prompt, [file.id])}/> : undefined;
  if (canOpenSourceSetup && (connectStep || connections.choice || connections.broker?.pending)) return <SourceConnectPage step={connectStep}
    controller={connections} session={session} onStep={connect} onBack={() => connect(null)} upload={upload}/>;
  if (connectionId && managesConnections) {
    const connection = connections.data?.connections.find(item => item.id === connectionId);
    return connection ? <SourceConnectionDetail connection={connection} controller={connections} onBack={back} onSource={onSource} onAskSource={onAskSource}
      archived={Boolean(workspace?.archivedSources?.some(item => item.source.id === connection.latestVersion?.sourceId))}/>
      : <section className="standard-page tables-file-page"><button className="text-button" onClick={back}><ArrowLeft size={14}/>All sources</button>
        {connections.loadError ? <p role="alert">{connections.loadError} <button className="text-button" onClick={() => void connections.refresh()}>Retry connections</button></p>
          : connections.data ? <p role="status">This connection is not available in this workspace.</p> : <p role="status">Loading source...</p>}</section>;
  }
  const sourceConnection = source ? freshness.get(source.id) : undefined;
  const canShareConnection = source && !archived && !readOnly && customerOrganization() && !source.id.startsWith('team_') && new URLSearchParams(location.search).get('data') !== 'team' && sourceConnection?.connectionId && session?.mode === 'authenticated' && ['owner','operator'].includes(session.role);
  const canSharePrivate = source && !archived && !readOnly && customerOrganization() && !source.id.startsWith('team_') && new URLSearchParams(location.search).get('data') !== 'team' && (source.path.startsWith('uploads/') || (sourceTableKind(source) === 'tabular' && ['loaded','off'].includes(freshnessState) && !freshness.has(source.id))) && session?.mode === 'authenticated' && ['owner','operator'].includes(session.role);
  if (selectedId) return <section className="standard-page tables-file-page">
    <div className="tables-detail-navigation"><button className="text-button" onClick={back}><ArrowLeft size={14}/>All sources</button></div>
    <header className="page-heading"><div><h1 ref={heading} tabIndex={-1}>{source ? libraryFileName(source) : 'Opening file'}</h1>{source && <FileFreshness fresh={freshness.get(source.id)} csv={Boolean(sourceTableKind(source)) && !sourceCalculationId(source)} checked={freshnessState === 'loaded'}/>}</div><div className="tables-detail-actions">{canShareConnection && <ShareButton privateConnection kind="source" id={sourceConnection!.connectionId!} name={sourceConnection!.displayName ?? source!.title} data={{}}/>}{canSharePrivate && <ShareButton privateSource kind="source" id={source.id} name={source.title} data={{}}/>}{source && !source.id.startsWith('team_person_') && customerOrganization() && new URLSearchParams(location.search).get('data') === 'team' && session?.mode === 'authenticated' && session.role === 'owner' && <ShareButton kind="source" id={source.id.startsWith('team_') ? source.id.slice(5) : source.id} name={source.title} data={{}}/>}<button className="button secondary" disabled={!source || readOnly || Boolean(archived)} onClick={() => {try {if(source)useFile(source);}catch(cause){setRefreshError(message(cause));}}}>Ask Rivet <ArrowRight size={14}/></button></div></header>
    {archived && <div className="source-archive-notice"><p>Archived file. Saved reports and evidence are unchanged.</p><RestoreSourceButton archived={archived} onRestore={onRestoreSource}/></div>}
    {refreshError && <p className="module-alert" role="alert">{refreshError}</p>}
    {loading ? <p role="status">Loading file...</p> : error ? <p className="module-alert" role="alert">{error} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Retry</button></p> : source && (sourceCalculationId(source) ? <CalculatedSourceTable key={source.id} source={source} onSource={onSource}/> : sourceTableKind(source) ? <SourceDatasetView key={source.id} source={source} onSource={onSource}/> : <div className="tables-document"><div className="markdown">{/\.txt$/i.test(source.path) ? <pre>{source.content}</pre> : <Markdown content={source.content} onSource={onSource}/>}</div></div>)}
  </section>;
  const archivedItems = libraryItems((workspace?.archivedSources ?? []).map(item => item.source));
  const items = category === 'archived' ? archivedItems : sourceLibraryEntries(libraryItems(workspace?.sources ?? []), connections.data?.connections ?? [], connections.data?.providers ?? []);
  const visible = visibleSourceEntries(items, query, category === 'archived' ? 'all' : category, sort);
  const filtered = Boolean(query.trim()) || category !== 'all';
  const incomplete = !workspace || (category !== 'archived' && managesConnections && (!connections.data || connections.loadError));
  return <section className="module-page tables-library" data-file-drop>
    <div className="module-page-heading"><div><h1 id="tables-library-heading" tabIndex={-1}>Sources</h1><p>Your connected accounts and source files</p></div><div className="tables-heading-actions">{canOpenSourceSetup && <button id="tables-connect-accounts" className="button primary" onClick={() => connect('data')}><Plus size={16}/>Connect source</button>}{!managesConnections && upload}</div></div>
    <div className="module-library-heading tables-toolbar">
      <label className="module-search"><Search size={14}/><input aria-label="Search sources" placeholder="Search sources" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <label className="tables-file-filter"><span className="sr-only">Item type</span><select aria-label="Item type" value={category} onChange={event => setCategory(event.target.value as LibraryCategory | 'connections' | 'archived')}><option value="all">All sources</option>{managesConnections && <option value="connections">Connected accounts</option>}<option value="csv">{manualImports ? 'CSV files' : 'Source tables'}</option><option value="documents">Documents</option><option value="archived">Archived files ({archivedItems.length})</option></select></label>
      <label className="tables-file-filter"><span className="sr-only">Sort by</span><select aria-label="Sort by" value={sort} onChange={event => setSort(event.target.value as LibrarySort)}><option value="name">Name</option><option value="type">Type</option><option value="newest">Recently updated</option></select></label>
      <button className="icon-button" aria-label="Refresh library" title="Refresh library" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={15}/></button>
    </div>
    <p className="tables-item-count" role="status">{filtered ? `${visible.length} of ` : ''}{items.length} {incomplete ? 'loaded ' : ''}{items.length === 1 ? 'item' : 'items'}</p>
    {managesConnections && connections.loadError && <p className="module-alert" role="alert">{connections.loadError} <button className="text-button" onClick={() => void connections.refresh()}>Retry connections</button></p>}
    {managesConnections && !connections.data && !connections.loadError && <p role="status">Loading connected sources...</p>}
    {connections.actionError && <p className="module-alert" role="alert">{connections.actionError}</p>}
    {connections.notice && <p className="module-notice" role="status">{connections.notice}</p>}
    {refreshError && <p className="module-alert" role="alert">{refreshError}</p>}
    {visible.length ? <div className="module-table-wrap"><table className="module-library tables-files"><thead><tr><th scope="col">Name</th><th scope="col">Status / type</th><th scope="col">Updated</th></tr></thead><tbody>{visible.map(item => {
      const Icon = item.kind === 'connection' ? Cable : item.category === 'documents' ? FileText : Table2;
      const fresh = item.kind === 'source' ? freshness.get(item.source.id) : undefined;
      return <tr key={item.id}><td><button id={`library-file-${item.id}`} aria-label={item.title} title={item.title} className="module-row-title" onClick={() => openItem(item)}><span className="module-row-icon">{item.kind === 'connection' ? <PlatformIcon provider={item.connection.provider} size={22}/> : <Icon size={18} aria-hidden="true"/>}</span><span><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}{fresh && <ConnectionBadge fresh={fresh}/>}<small className="tables-mobile-meta">{item.label}{item.kind !== 'connection' ? ` · ${item.size}` : ''}{item.date ? ` · ${new Date(item.date).toLocaleDateString([], { month:'short', day:'numeric' })}` : ''}</small></span></button></td><td><span className={item.kind === 'connection' ? 'source-sync-status' : undefined}>{item.label}</span></td><td>{item.date ? <time dateTime={item.date}>{new Date(item.date).toLocaleDateString([], { month:'short', day:'numeric' })}</time> : <span aria-label="Save date not recorded">—</span>}</td></tr>;
    })}</tbody></table></div> : !incomplete && <div className="module-empty compact"><Table2 size={25}/><h2>{category === 'archived' && !query.trim() ? 'No archived files' : filtered ? 'No matching items' : 'No sources yet'}</h2>{filtered && <button className="text-button" onClick={() => { setQuery(''); setCategory('all'); }}>Clear filters</button>}</div>}
  </section>;
}
