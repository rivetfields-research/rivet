import { ShareButton } from './team-sharing';
import { customerOrganization } from './workspace-scope';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react';
import type { ConnectionListEntry } from '../../../packages/core/src/sync-jobs';
import type { SourceDocument } from '../../../packages/core/src/types';
import type { WorkflowSchedule } from '../../../packages/core/src/workflow-schedules';
import { api, message } from './api';
import { apifyReads, connectionState, localTime, reconnectSoon, type ConnectionAttempt } from './connection-model';
import { AttemptHistory, DisconnectConfirm, SyncScheduleForm } from './connection-controls';
import { SourceDatasetView } from './source-dataset-view';
import { sourceTableKind } from '../../../packages/core/src/source-table';
import { Markdown } from './markdown';
import { sourceConnectionStatus } from './source-connections';
import type { ConnectionsController } from './use-connections';
import { PlatformIcon } from './platform-icon';
import type { SourceObservation } from '../../../packages/data-layer/src/source-semantics';

function SavedSnapshots({ connection, onSource }: { connection: ConnectionListEntry; onSource: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<{ id: string; sourceId: string; observedAt: string }[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void api<{ snapshots: NonNullable<typeof snapshots> }>(`/api/connections/${connection.id}/snapshots`, { signal: abort.signal })
      .then(result => { if (!abort.signal.aborted) { setSnapshots(result.snapshots); setError(''); } })
      .catch(cause => { if (!abort.signal.aborted) setError(message(cause)); });
    return () => abort.abort();
  }, [open, connection.id, connection.lastAttempt?.at, revision]);
  return <details className="source-connection-options" onToggle={event => setOpen(event.currentTarget.open)}><summary>Saved snapshots</summary>
    {error ? <p role="alert">{error} <button className="text-button" onClick={() => setRevision(value => value + 1)}>Try again</button></p>
      : !snapshots ? <p role="status">Loading snapshots...</p>
        : !snapshots.length ? <p>No saved snapshots yet.</p>
          : <ol className="data-connection-history">{snapshots.map(item => <li key={item.id}>
            <time dateTime={item.observedAt}>{localTime(item.observedAt)}</time>
            <button className="text-button" onClick={() => onSource(item.sourceId)}>Open snapshot</button>
          </li>)}</ol>}
  </details>;
}

function ConnectionOptions({ connection, controller }: { connection: ConnectionListEntry; controller: ConnectionsController }) {
  const [panel, setPanel] = useState<'schedule' | 'disconnect' | null>(null);
  const [schedules, setSchedules] = useState<WorkflowSchedule[] | null | 'failed'>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [attempts, setAttempts] = useState<ConnectionAttempt[] | null>(null);
  const [error, setError] = useState('');
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!historyOpen) return;
    let active = true;
    void controller.loadAttempts(connection.id).then(value => { if (active) {setAttempts(value);setError('');} }, cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [historyOpen, connection]);
  function disconnect() {
    setPanel('disconnect'); setSchedules(null);
    void controller.loadSchedules().then(all => setSchedules(all.filter(item => !item.archivedAt && item.connectionIds?.includes(connection.id))), () => setSchedules('failed'));
  }
  return <details className="source-connection-options"><summary>Connection settings</summary>
    {connection.latestVersion && connection.lastAttempt?.at && <dl className="data-connection-review"><div><dt>Last checked</dt><dd><time dateTime={connection.lastAttempt.at}>{localTime(connection.lastAttempt.at)}</time></dd></div></dl>}
    {apifyReads(connection) && <p>{apifyReads(connection)}</p>}
    {connection.tokenConfigured !== undefined && <p>API token: {connection.tokenConfigured ? 'Configured' : 'Deleted'}</p>}
    {connection.reconnectBy && <p>Reconnect by <time dateTime={connection.reconnectBy}>{localTime(connection.reconnectBy)}</time></p>}
    <div className="data-connection-actions">
      {connection.status !== 'disconnected' && <><button className="text-button" disabled={Boolean(controller.busy)} onClick={() => setPanel('schedule')}>Sync schedule</button><button className="text-button" disabled={Boolean(controller.busy)} onClick={disconnect}>Disconnect</button></>}
    </div>
    {panel !== 'schedule' && connection.status !== 'disconnected' && connection.job && connection.job.frequency !== 'manual' && <label className="module-check-field">
      <input type="checkbox" checked={pendingEnabled ?? connection.job.enabled} disabled={Boolean(controller.busy) || pendingEnabled !== null} onChange={event => {
        const job = connection.job!;
        setPendingEnabled(event.target.checked);
        void controller.onSchedule(connection, { frequency: job.frequency, timeUtc: job.timeUtc, enabled: event.target.checked,
          ...(job.weekday === undefined ? {} : { weekday: job.weekday }), ...(job.localTime && job.timezone ? { localTime: job.localTime, timezone: job.timezone } : {}) })
          .finally(() => setPendingEnabled(null));
      }}/><span>Automatic updates</span>
    </label>}
    {panel === 'schedule' && <SyncScheduleForm connection={connection} busy={Boolean(controller.busy)} onCancel={() => setPanel(null)} onSave={input => void controller.onSchedule(connection, input).then(ok => {if(ok)setPanel(null);})}/>}
    {panel === 'disconnect' && <DisconnectConfirm connection={connection} schedules={schedules} busy={Boolean(controller.busy)} onCancel={() => setPanel(null)} onConfirm={() => void controller.onDisconnect(connection).then(ok => {if(ok)setPanel(null);})}/>}
    <details onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>Sync history</summary>{historyOpen && <AttemptHistory attempts={attempts} error={error}/>}</details>
  </details>;
}

export function SourceConnectionDetail({ connection, controller, onBack, onAskSource, onSource, archived = false }: {
  connection: ConnectionListEntry; controller: ConnectionsController; onBack: () => void;
  onAskSource: (id: string) => void; onSource: (id: string) => void; archived?: boolean;
}) {
  const [source, setSource] = useState<SourceDocument | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [askError, setAskError] = useState('');
  const [observations, setObservations] = useState<SourceObservation[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const id = connection.latestVersion?.sourceId;
  useEffect(() => { heading.current?.focus(); }, [connection.id]);
  useEffect(() => {
    setSource(null); setError('');
    if (!id) return;
    const abort = new AbortController();
    void api<SourceDocument>(`/api/sources/${encodeURIComponent(id)}`, {signal:AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])}).then(value => {
      if (value.id !== id) throw new Error('This source could not be confirmed.');
      if (!abort.signal.aborted) setSource(value);
    }).catch(cause => {if(!abort.signal.aborted)setError(message(cause));});
    return () => abort.abort();
  }, [id, revision]);
  useEffect(() => {
    const abort = new AbortController();
    setObservations(null); setHistoryError('');
    void api<{ observations: SourceObservation[] }>(`/api/connections/${connection.id}/observations`, {signal:AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])})
      .then(result => { if (!abort.signal.aborted) setObservations(result.observations); })
      .catch(cause => { if (!abort.signal.aborted) setHistoryError(message(cause)); });
    return () => abort.abort();
  }, [connection.id, connection.lastAttempt?.at, id, revision]);
  const provider = controller.data?.providers.find(item => item.id === connection.provider);
  const state = connectionState(connection);
  const reconnect = provider?.enabled && (provider.signIn === 'oauth' || provider.signIn === 'broker') && (connection.signedIn === false || state === 'disconnected' || reconnectSoon(connection) || ((provider.signIn === 'broker' || provider.signInProvider) && state === 'needs_attention'));
  const waiting = Boolean(connection.syncAvailableAt);
  const syncEnabled = provider?.enabled && !controller.busy && state !== 'syncing' && state !== 'disconnected' && !waiting;
  const loadedSource = source?.id === id ? source : null;
  const schedule = connection.job;
  const observed = observations?.find(item => item.sourceId === id) ?? (!id ? observations?.[0] : undefined);
  const dataAsOf = observed?.observedAt ?? connection.latestVersion?.observedAt;
  const freshness = id ? dataAsOf : connection.lastAttempt?.at;
  const range = observed?.recordRange;
  const date = (value: string) => new Date(value.length === 10 ? `${value}T12:00:00Z` : value).toLocaleDateString([], {year:'numeric',month:'short',day:'numeric', ...(value.length === 10 ? {timeZone:'UTC'} : {})});
  return <section className="standard-page tables-file-page source-connection-detail">
    <button className="text-button" onClick={onBack}><ArrowLeft size={14}/>All sources</button>
    <header className="page-heading"><div><h1 ref={heading} tabIndex={-1}>{connection.displayName}</h1><p className="source-connection-provider"><PlatformIcon provider={provider?.sourceProvider ?? connection.provider} size={18}/>{provider?.label ?? connection.provider}</p></div>
      <div className="tables-heading-actions">{customerOrganization() && new URLSearchParams(location.search).get('data') !== 'team' && <ShareButton privateConnection kind="source" id={connection.id} name={connection.displayName} data={{}}/>}<span className="source-sync-status" role="status">{sourceConnectionStatus(connection)}</span>
        {reconnect ? <button className="button secondary" disabled={Boolean(controller.busy)} onClick={() => controller.onReconnect?.(connection)}>Reconnect</button>
          : state !== 'disconnected' && <button className="icon-button" aria-label="Sync now" title={waiting ? `Available ${localTime(connection.syncAvailableAt!)}` : 'Sync now'} disabled={!syncEnabled} onClick={() => controller.onSync(connection)}><RefreshCw size={17}/></button>}
        <button className="button primary" disabled={!loadedSource || archived} onClick={() => {try {if(id)onAskSource(id);} catch(cause) {setAskError(message(cause));}}}>Ask about this <ArrowRight size={14}/></button>
      </div>
    </header>
    {controller.loadError && <p className="module-alert" role="alert">{controller.loadError} <button className="text-button" onClick={() => void controller.refresh()}>Retry connections</button></p>}
    {controller.actionError && <p className="module-alert" role="alert">{controller.actionError}</p>}
    {askError && <p className="module-alert" role="alert">{askError}</p>}
    {controller.notice && <p className="module-notice" role="status">{controller.notice}</p>}
    {connection.lastFailure && <p className="module-alert" role="status">{connection.lastFailure.message}{id ? ' Your last synced data is still available.' : ''}</p>}
    {state === 'disconnected' && <p className="empty-note">Syncing has stopped. Previously saved data and reports are kept.</p>}
    {!provider?.enabled && state !== 'disconnected' && <p className="module-alert">Syncing is unavailable for this provider. Previously saved data is kept.</p>}
    {archived && <p className="module-alert">This saved file is archived. Restore it from Archived files before asking a new question.</p>}
    {waiting && <p className="empty-note">Next manual sync available <time dateTime={connection.syncAvailableAt}>{localTime(connection.syncAvailableAt!)}</time>.</p>}
    <dl className="source-overview-facts connection-source-facts">
      <div><dt>Records collected</dt><dd>{observed ? observed.recordCount.toLocaleString() : observations === null && !historyError ? 'Checking...' : 'Not recorded'}</dd></div>
      <div><dt>{range?.basis === 'reporting-period' ? 'Reporting dates' : 'Records dated'}</dt><dd>{range ? `${date(range.from)} – ${date(range.to)}` : observed?.recordCount === 0 ? 'No records' : 'Not recorded'}</dd></div>
      <div><dt>{id ? 'Data as of' : 'Last checked'}</dt><dd>{freshness ? <time dateTime={freshness}>{localTime(freshness)}</time> : 'Not yet'}</dd></div>
      <div><dt>Updates</dt><dd>{state === 'disconnected' ? 'Stopped' : schedule?.frequency && schedule.frequency !== 'manual' ? schedule.enabled ? schedule.frequency === 'daily' ? 'Daily' : 'Weekly' : 'Paused' : 'Manual'}{state !== 'disconnected' && schedule?.nextRunAt && <small>Next: {localTime(schedule.nextRunAt)}</small>}</dd></div>
    </dl>
    {observed?.coverage === 'partial' && <p className="empty-note">The provider returned partial data.</p>}
    {range && range.datedRecords < (observed?.recordCount ?? 0) && <p className="empty-note">Some records have no date. The date range covers dated records only.</p>}
    {id && observations?.[0]?.recordCount === 0 && <p className="empty-note">The latest sync returned no records. Your previously saved table is still available.</p>}
    {historyError && <details className="source-coverage-error"><summary>Collection details unavailable</summary><p>{historyError}</p><button className="text-button" onClick={() => setRevision(value => value + 1)}>Try again</button></details>}
    {!id ? <div className="source-pending" role="status">{state === 'syncing' ? 'Preparing your data. You can leave this page and come back.' : state === 'disconnected' ? 'No saved data.' : connection.lastAttempt?.status === 'succeeded' ? 'No records were returned for this period.' : 'No saved data yet.'}</div>
      : error ? <p className="module-alert" role="alert">We couldn't open this source. <button className="text-button" onClick={() => setRevision(value => value + 1)}>Try again</button><details><summary>Details</summary>{error}</details></p>
        : !loadedSource ? <p role="status">Loading source...</p>
          : sourceTableKind(loadedSource) ? <SourceDatasetView key={loadedSource.id} source={loadedSource} onSource={onSource}/>
            : <Markdown content={loadedSource.content} onSource={onSource}/>}
    <SavedSnapshots key={`snapshots:${connection.id}`} connection={connection} onSource={onSource}/>
    <ConnectionOptions key={connection.id} connection={connection} controller={controller}/>
  </section>;
}
