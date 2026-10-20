import type { ReactNode } from 'react';
import type { ConnectionListEntry } from '../../../packages/core/src/sync-jobs';
import { connectionState, reconnectSoon, apifyReads, localTime, CONNECTION_STATE_LABELS, STATE_CLASS } from './connection-model';

const Time = ({ value }: { value: string }) => <time dateTime={value}>{localTime(value)}</time>;

function nextSync(connection: ConnectionListEntry) {
  const job = connection.job;
  if (connection.status === 'disconnected') return 'Stopped';
  if (!job || job.frequency === 'manual') return 'Only when you choose Sync now';
  if (!job.enabled) return 'Scheduled syncs paused';
  return job.nextRunAt ? <Time value={job.nextRunAt} /> : 'Not scheduled';
}
function lastAttempt(connection: ConnectionListEntry) {
  const last = connection.lastAttempt;
  if (!last) return 'None yet';
  return <><Time value={last.at} />{last.status === 'failed' ? ' · Failed' : ' · Succeeded'}</>;
}

export function ConnectionRow({ connection, providerLabel, providerAvailable, signIn = false, renewInPlace = false, busy, onSync, onSchedule, onDisconnect, onReconnect, children }: {
  connection: ConnectionListEntry; providerLabel: string; providerAvailable: boolean; busy: boolean;
  /** The provider connects by account sign-in: a missing or expired sign-in (not a disconnect) offers Reconnect account. */
  signIn?: boolean;
  /** A shared per-person sign-in (Meta) that can be renewed without disconnecting, e.g. to grant a missing permission. */
  renewInPlace?: boolean;
  onSync: () => void; onSchedule: () => void; onDisconnect: () => void; onReconnect?: () => void; children?: ReactNode;
}) {
  const state = connectionState(connection);
  const disconnected = state === 'disconnected';
  const failure = connection.lastFailure;
  const signedOut = signIn && providerAvailable && connection.signedIn === false;
  const expiring = signIn && providerAvailable && !disconnected && !signedOut && reconnectSoon(connection);
  const renew = expiring || (renewInPlace && signIn && providerAvailable && !disconnected && !signedOut && connection.status === 'needs_attention');
  // A disconnected sign-in source can be reconnected: its sync schedule comes back with it (M8).
  const reconnect = (signedOut || renew || (disconnected && signIn && providerAvailable)) && onReconnect
    ? <button type="button" className="button secondary compact" disabled={busy} onClick={onReconnect}>Reconnect account</button> : null;
  const waiting = connection.syncAvailableAt && state !== 'syncing' ? connection.syncAvailableAt : null;
  const reads = connection.tokenConfigured !== undefined ? apifyReads(connection) : null;
  return <li className="data-connection" aria-label={connection.displayName}>
    <div className="data-connection-head">
      <div><h3 id={`data-connection-${connection.id}`} tabIndex={-1}>{connection.displayName}</h3><p>{providerLabel}</p></div>
      <span className={`pill data-connection-state${STATE_CLASS[state] ? ` ${STATE_CLASS[state]}` : ''}`}>{state === 'syncing' && <span className="status-dot running" />}{CONNECTION_STATE_LABELS[state]}</span>
    </div>
    <dl className="data-connection-facts">
      <div><dt>Data as of</dt><dd>{connection.latestVersion ? <Time value={connection.latestVersion.observedAt} /> : 'No synced data yet'}</dd></div>
      <div><dt>Last attempt</dt><dd>{lastAttempt(connection)}</dd></div>
      <div><dt>Next sync</dt><dd>{nextSync(connection)}</dd></div>
      {connection.reconnectBy && !disconnected && <div><dt>Reconnect by</dt><dd><Time value={connection.reconnectBy} /></dd></div>}
      {connection.tokenConfigured !== undefined && reads && <div><dt>Reads</dt><dd>{reads}</dd></div>}
      {connection.tokenConfigured !== undefined && <div><dt>API token</dt><dd>{connection.tokenConfigured ? 'Configured' : disconnected ? 'Deleted' : 'Not saved'}</dd></div>}
    </dl>
    {state === 'needs_attention' && <div className="data-connection-attention" role="status">
      <p>{failure?.message ?? (expiring ? `This account's sign-in ends ${localTime(connection.reconnectBy!)}. Reconnect it before then to keep syncing.` : 'Recent syncs did not finish.')}</p>
      {failure && !['owner_not_member', 'owner_not_manager', 'permission_missing', 'provider_blocked', 'api_token_required', 'provider_not_found'].includes(failure.errorCode) && !signedOut && <p>Try Sync now. If it keeps failing, check the source or disconnect it.</p>}
    </div>}
    {expiring && state !== 'needs_attention' && <p className="data-connection-hint">This account's sign-in ends {localTime(connection.reconnectBy!)}. Reconnect it before then to keep syncing.</p>}
    {signedOut && !disconnected && state !== 'needs_attention' && <p className="data-connection-hint">The account sign-in for this connection is missing or has expired. Reconnect the account to sync again.</p>}
    {state === 'syncing' && <p className="data-connection-hint">Reading {providerLabel}. You can leave this page; the sync continues.</p>}
    {state === 'no_data' && <p className="data-connection-hint">{failure ? `The last sync failed: ${failure.message}`
      : connection.lastAttempt?.status === 'succeeded' ? 'The last sync found no posts in its window, so there is no table yet. Empty is not the same as no activity; the next sync checks again.'
        : 'Nothing has been read yet. Choose Sync now to check that Rivet can read this source.'}</p>}
    {waiting && <p className="data-connection-hint">To stay within the provider's limits, Sync now is available again at <Time value={waiting} />.</p>}
    {state === 'active' && failure && <p className="data-connection-hint">The last sync failed: {failure.message} The data shown is from the previous sync.</p>}
    {disconnected && <p className="data-connection-hint">Syncs are stopped. Data already synced, and reports made from it, are kept.{reconnect ? ' Reconnect the account to sync again; its sync schedule comes back with it.' : ''}</p>}
    {disconnected && reconnect && <div className="data-connection-actions">{reconnect}</div>}
    {!providerAvailable && !disconnected && <p className="data-connection-hint">This source's provider is not available in this workspace, so it cannot sync. It stays listed with its data.</p>}
    {!disconnected && providerAvailable && <div className="data-connection-actions">
      {/* aria-disabled keeps keyboard focus on the button while the sync runs. */}
      {signedOut && reconnect ? reconnect : <>
        <button type="button" className="button secondary compact" aria-disabled={busy || state === 'syncing' || Boolean(waiting)} onClick={() => { if (!busy && state !== 'syncing' && !waiting) onSync(); }}>{state === 'syncing' ? 'Syncing…' : 'Sync now'}</button>
        {renew && reconnect}
      </>}
      <button type="button" className="text-button" disabled={busy} onClick={onSchedule}>Schedule</button>
      <button type="button" className="text-button" disabled={busy} onClick={onDisconnect}>Disconnect</button>
    </div>}
    {!disconnected && !providerAvailable && <div className="data-connection-actions"><button type="button" className="text-button" disabled={busy} onClick={onDisconnect}>Disconnect</button></div>}
    {children}
  </li>;
}
