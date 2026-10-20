import { useEffect, useState } from 'react';
import { Cable, Table2 } from 'lucide-react';
import type { ConnectionListEntry } from '../../../packages/core/src/sync-jobs';
import type { WorkflowSchedule } from '../../../packages/core/src/workflow-schedules';
import { canManageSources } from './session-access';
import { message } from './api';
import { tableSourceLink } from './table-source-navigation';
import { connectionVisibilityNotice, type ConnectionAttempt, type DataConnectionsViewProps } from './connection-model';
import { ConnectionRow } from './connection-row';
import { AddConnectionPanel, ConnectionChooser } from './connection-forms';
import { SyncScheduleForm, DisconnectConfirm, AttemptHistory } from './connection-controls';

type Panel = { kind: 'schedule' | 'disconnect'; id: string } | null;

/** The Settings section (C8): mounted only for people who can manage sources, and only when the runtime offers connections. */
export function DataConnectionsView({ session, workspaceName, data, loadError, actionError, notice, busy, onAdd, onSync, onSchedule, onDisconnect, onReconnect, loadAttempts, loadSchedules, focusConnection, choice, onChoose, onCancelChoice, onOpenSource }: DataConnectionsViewProps) {
  const [adding, setAdding] = useState(false);
  // Focus follows the change: the new or changed connection, or the button that opened a closed panel.
  const [focusId, setFocusId] = useState<string | null>(focusConnection ? `data-connection-${focusConnection}` : null);
  useEffect(() => {
    const target = focusId ? document.getElementById(focusId) : null;
    if (target) { target.focus(); setFocusId(null); }
  }, [focusId, data, adding]);
  const [panel, setPanel] = useState<Panel>(null);
  const [affected, setAffected] = useState<WorkflowSchedule[] | null | 'failed'>(null);
  const [history, setHistory] = useState<Record<string, { attempts: ConnectionAttempt[] | null; error: string }>>({});
  const [openHistories, setOpenHistories] = useState<readonly string[]>([]);
  // An open history follows the saved state as syncs finish; a failed reload keeps the rows already shown.
  useEffect(() => {
    let disposed = false;
    for (const id of openHistories) {
      void loadAttempts(id).then(attempts => { if (!disposed) setHistory(current => ({ ...current, [id]: { attempts, error: '' } })); },
        error => { if (!disposed) setHistory(current => ({ ...current, [id]: { attempts: current[id]?.attempts ?? null, error: `Sync history could not be loaded. ${message(error)}` } })); });
    }
    return () => { disposed = true; };
  }, [openHistories, data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!canManageSources(session) || !data?.runtimeEnabled) return null;
  const visibility = connectionVisibilityNotice(session);
  const providers = new Map(data.providers.map(item => [item.id, item]));
  function toggleHistory(id: string, open: boolean) {
    setOpenHistories(current => open ? (current.includes(id) ? current : [...current, id]) : current.filter(item => item !== id));
  }
  function openDisconnect(connection: ConnectionListEntry) {
    setPanel({ kind: 'disconnect', id: connection.id }); setAffected(null);
    void loadSchedules().then(list => setAffected(list.filter(item => !item.archivedAt && item.connectionIds?.includes(connection.id))))
      .catch(() => setAffected('failed'));
  }
  const count = data.connections.length;
  return <section className="connection-row data-connections" aria-labelledby="data-connections-heading">
    <span className="connection-icon"><Cable size={19} /></span>
    <div>
      <h2 id="data-connections-heading">Data connections</h2>
      <p>{count ? `${count} ${count === 1 ? 'connection' : 'connections'}` : 'No connections yet.'}</p>
      {visibility && <p className="data-connection-visibility">{visibility}</p>}
      {loadError && <p className="module-alert" role="alert">{loadError}</p>}
      {actionError && <p className="module-alert" role="alert">{actionError}</p>}
      {notice && <p className="module-notice" role="status">{notice}</p>}
      {choice && onChoose && onCancelChoice && <ConnectionChooser choice={choice} busy={busy !== null} onConnect={onChoose} onCancel={onCancelChoice} />}
      {count > 0 && <ul className="data-connection-list">{data.connections.map(connection => {
        const provider = providers.get(connection.provider);
        const entry = history[connection.id];
        // One action at a time: while any is in flight, every row's actions wait.
        return <ConnectionRow key={connection.id} connection={connection} providerLabel={provider?.label ?? connection.provider} providerAvailable={Boolean(provider?.enabled)} busy={busy !== null}
          signIn={provider?.signIn === 'oauth'} renewInPlace={Boolean(provider?.signInProvider)} {...(onReconnect ? { onReconnect: () => onReconnect(connection) } : {})}
          onSync={() => onSync(connection)} onSchedule={() => setPanel(panel?.kind === 'schedule' && panel.id === connection.id ? null : { kind: 'schedule', id: connection.id })}
          onDisconnect={() => openDisconnect(connection)}>
          {connection.latestVersion && <div className="data-connection-open-table">{onOpenSource
            ? <button className="button secondary compact" onClick={() => onOpenSource(connection.latestVersion!.sourceId)}><Table2 size={14}/>Open table</button>
            : <a className="button secondary compact" href={tableSourceLink(connection.latestVersion.sourceId)}><Table2 size={14}/>Open table</a>}</div>}
          {panel?.kind === 'schedule' && panel.id === connection.id && <SyncScheduleForm connection={connection} busy={busy !== null}
            onSave={input => void onSchedule(connection, input).then(ok => { if (ok) { setPanel(null); setFocusId(`data-connection-${connection.id}`); } })} onCancel={() => { setPanel(null); setFocusId(`data-connection-${connection.id}`); }} />}
          {panel?.kind === 'disconnect' && panel.id === connection.id && <DisconnectConfirm connection={connection} schedules={affected} busy={busy !== null}
            onConfirm={() => void onDisconnect(connection).then(ok => { if (ok) { setPanel(null); setFocusId(`data-connection-${connection.id}`); } })} onCancel={() => { setPanel(null); setFocusId(`data-connection-${connection.id}`); }} />}
          <details className="settings-detail" onToggle={event => toggleHistory(connection.id, event.currentTarget.open)}>
            <summary>Sync history</summary>
            {openHistories.includes(connection.id) && <AttemptHistory attempts={entry?.attempts ?? null} error={entry?.error ?? ''} />}
          </details>
        </ConnectionRow>;
      })}</ul>}
      {!data.providers.length ? !count && <p className="data-connection-hint">No source can be connected in this workspace yet. Upload an export in <a href="?view=tables">Tables</a> instead.</p>
        : adding ? <AddConnectionPanel workspaceName={workspaceName} providers={data.providers} session={session} busy={busy !== null}
        onCreate={(provider, name, apify) => onAdd(provider, name, apify).then(id => { if (id) { setAdding(false); setFocusId(`data-connection-${id}`); } })} onCancel={() => { setAdding(false); setFocusId('data-connection-add'); }} />
        : <button type="button" id="data-connection-add" className="button secondary compact data-connection-add-button" disabled={busy !== null} onClick={() => { setAdding(true); setFocusId('data-connection-add-heading'); }}>Add connection</button>}
    </div>
  </section>;
}
