import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowSchedule } from '../../../packages/core/src/workflow-schedules';
import { ApiError, api, message } from './api';
import { useBrokerConnection } from './use-broker-connection';
import { canManageSources, type WorkspaceSession } from './session-access';
import { workspaceBrowserStorage } from './workspace-scope';
import { signInReturn, type ConnectionsResponse, type ConnectionChoice, type ConnectionAttempt, type DataConnectionsViewProps } from './connection-model';

const POLL_MS = 2000;

function clearSignInReturn() {
  const url = new URL(location.href);
  for (const name of ['connection', 'result', 'provider', 'choice', 'reason']) url.searchParams.delete(name);
  history.replaceState(history.state, '', url);
}

// An unfinished account choice survives a reload in this tab's workspace-scoped session storage, never in the
// address or history. It holds no credential; the server still checks who made it and whether it expired.
const PENDING_CHOICE = 'rivet.pendingConnectionChoice';
function pendingChoice(): { provider: string; choice: string } | null {
  try {
    const saved = JSON.parse(workspaceBrowserStorage('sessionStorage').getItem(PENDING_CHOICE) ?? 'null') as { provider?: unknown; choice?: unknown } | null;
    return saved && typeof saved.provider === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(saved.provider)
      && typeof saved.choice === 'string' && /^[A-Za-z0-9_-]{43}$/.test(saved.choice) ? { provider: saved.provider, choice: saved.choice } : null;
  } catch { return null; }
}
function keepPendingChoice(value: { provider: string; choice: string } | null) {
  try {
    const storage = workspaceBrowserStorage('sessionStorage');
    if (value) storage.setItem(PENDING_CHOICE, JSON.stringify(value)); else storage.removeItem(PENDING_CHOICE);
  } catch { /* storage unavailable: the choice lasts until reload, as before */ }
}

/** Loads and acts on connections. A failed refresh keeps the last loaded state and says so. */
export function useConnections(session: WorkspaceSession | null | undefined, refreshVersion: number, enabled = true, feedbackScope = 'connections') {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  // Back from an account sign-in: say what happened once, then remove it from the address.
  const [returned] = useState(() => {
    if (typeof location === 'undefined') return null;
    const fromAddress = signInReturn(location.search);
    if (fromAddress) return fromAddress;
    const pending = pendingChoice();
    return pending ? { connectionId: null, result: 'choose' as const, ...pending } : null;
  });
  const [choice, setChoice] = useState<(ConnectionChoice & { id: string }) | null>(null);
  const currentScope = useRef(feedbackScope);
  currentScope.current = feedbackScope;
  const previousScope = useRef(feedbackScope);
  const noticeDestination = useRef<string | null>(null);
  useEffect(() => {
    if (previousScope.current === feedbackScope) return;
    previousScope.current = feedbackScope;
    setActionError('');
    if (noticeDestination.current !== feedbackScope) setNotice('');
    noticeDestination.current = null;
  }, [feedbackScope]);
  const keepNoticeOnNextScope = (scope: string) => { noticeDestination.current = scope; };
  const handledReturn = useRef(false);
  useEffect(() => {
    if (!returned || !enabled || !canManageSources(session) || handledReturn.current) return;
    handledReturn.current = true;
    if (returned.result === 'connected') { setNotice('Account connected. Check its sync status below.'); setPolling(true); }
    else if (returned.result === 'choose') {
      // The choice holds no credential; it is read back from the server for the person who signed in.
      void api<ConnectionChoice>(`/api/connections/${returned.provider}/choices/${returned.choice}`)
        .then(found => { if (mounted.current) { keepPendingChoice({ provider: returned.provider, choice: returned.choice }); setChoice({ ...found, id: returned.choice }); } })
        .catch(error => { keepPendingChoice(null); if (mounted.current && currentScope.current === feedbackScope) setActionError(`The accounts from this sign-in could not be shown. ${message(error)}`); });
    } else setActionError(returned.reason === 'instagram_account_missing'
      ? 'No Instagram account was available. Link a professional Instagram account to a Facebook Page you manage, then try again and allow access to that Page.'
      : 'The account sign-in did not finish, so nothing was saved. Try again.');
    // The one-use choice ID leaves the address at once; an unfinished choice is kept in session storage instead.
    clearSignInReturn();
  }, [returned, enabled, session]);
  const mounted = useRef(true);
  const loaded = useRef(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await api<ConnectionsResponse>('/api/connections');
      if (mounted.current && request === sequence.current) { setData(next); setLoadError(''); loaded.current = true; }
      return next;
    } catch (error) {
      if (!mounted.current || request !== sequence.current) return undefined;
      // Disabled runtimes serve no connection route at all.
      if (error instanceof ApiError && error.status === 404) { setData({ runtimeEnabled: false, providers: [], connections: [] }); return undefined; }
      setLoadError(`Connections could not be refreshed. ${message(error)}${loaded.current ? ' Showing the last loaded state.' : ''}`);
      return undefined;
    }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const manager = enabled && canManageSources(session);
  const broker = useBrokerConnection(manager, load, feedbackScope);
  useEffect(() => { if (manager) void load(); }, [refreshVersion, load, manager]);
  // While a sync is pending or running, re-read the saved state; nothing is estimated in between.
  const inFlight = Boolean(data?.connections.some(item => item.activeAttempt)) || polling;
  useEffect(() => {
    if (!manager || !inFlight) return;
    const timer = setTimeout(() => {
      void load().then(next => {
        if (!mounted.current) return;
        if (next && !next.connections.some(item => item.activeAttempt)) setPolling(false);
        setPollTick(value => value + 1);
      });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [manager, inFlight, pollTick, load]);
  // "Sync now" comes back when the provider's interval passes: re-read the saved state then, not on a guess.
  const nextAvailable = data?.connections.map(item => item.syncAvailableAt).filter((value): value is string => Boolean(value)).sort()[0];
  useEffect(() => {
    if (!manager || !nextAvailable) return;
    const wait = Math.min(Math.max(Date.parse(nextAvailable) - Date.now() + 500, 500), 30 * 60_000);
    const timer = setTimeout(() => { void load(); }, wait);
    return () => clearTimeout(timer);
  }, [manager, nextAvailable, load]);
  async function act(key: string, work: () => Promise<string>): Promise<boolean> {
    if (busy) return false;
    setBusy(key); setActionError(''); setNotice('');
    try { const done = await work(); if (mounted.current && currentScope.current === feedbackScope) setNotice(done); await load(); return true; }
    catch (error) {
      if (!mounted.current) return false;
      // A version conflict means someone else changed it: reload, keep their change, and say so.
      if (currentScope.current === feedbackScope) setActionError(error instanceof ApiError && error.status === 409 ? `${message(error)} The latest state is shown below.` : message(error));
      await load(); return false;
    } finally { if (mounted.current) setBusy(null); }
  }
  const post = (path: string, body: unknown, method = 'POST') => api(path, { method, body: JSON.stringify(body) });
  /** Account sign-in: the server answers with the provider's address (or the loopback host to start from). */
  const signIn = async (provider: string, body: { displayName?: string; connectionId?: string }) => {
    // One sign-in may serve several sources (Meta): its own ID names the authorize and callback paths.
    const route = signInProvider(provider)?.signInProvider ?? provider;
    const { url } = await post(`/api/connections/${encodeURIComponent(route)}/authorize`, {
      ...body, ...(route !== provider ? { product: provider } : {}),
    }) as { url: string };
    location.assign(url);
    return '';
  };
  const signInProvider = (id: string) => data?.providers.find(item => item.id === id && item.signIn === 'oauth')
    ?? data?.providers.find(item => item.signInProvider === id && item.signIn === 'oauth' && item.enabled);

  const actions: Pick<DataConnectionsViewProps, 'onChoose' | 'onCancelChoice' | 'onAdd' | 'onReconnect' | 'onSync' | 'onSchedule' | 'onDisconnect' | 'loadAttempts' | 'loadSchedules'> = {
    onChoose: accounts => act('choose', async () => {
      if (!choice) throw new Error('Sign in again to choose accounts.');
      const { connections } = await post(`/api/connections/${choice.provider}/choices/${choice.id}`, { accounts }) as { connections: { id: string }[] };
      clearSignInReturn();
      keepPendingChoice(null);
      setChoice(null);
      setPolling(true);
      return `${connections.length === 1 ? 'Account' : `${connections.length} accounts`} connected.`;
    }),
    onCancelChoice: () => void act('choose', async () => {
      if (!choice) return '';
      const current = choice;
      clearSignInReturn();
      keepPendingChoice(null);
      setChoice(null);
      const { revoked } = await api<{ revoked: 'revoked' | 'failed' | 'shared' }>(`/api/connections/${current.provider}/choices/${current.id}`, { method: 'DELETE' });
      return revoked === 'failed' ? 'Nothing was connected. Remove Rivet access in the provider account settings.' : 'Nothing was connected.';
    }),
    onAdd: async (provider, displayName, apify) => {
      if (data?.providers.find(item => item.id === provider)?.signIn === 'broker') { await broker.begin(provider); return null; }
      if (signInProvider(provider)?.signInProvider) { await act('add', () => signIn(provider, {})); return null; }
      if (signInProvider(provider)) { await act('add', () => signIn(provider, { displayName })); return null; }
      let id: string | null = null;
      const setup = apify ? { apify: { source: apify.source, id: apify.id.trim(), platform: apify.platform, account: apify.account.trim(), token: apify.token.trim() } } : {};
      const ok = await act('add', async () => {
        id = (await post('/api/connections', { provider, displayName, ...setup }) as { connection: { id: string } }).connection.id;
        return `${displayName} added.${apify ? ' Its API token is saved encrypted.' : ''} Choose Sync now to read it for the first time.`;
      });
      return ok ? id : null;
    },
    onReconnect: connection => {
      if (data?.providers.find(item => item.id === connection.provider)?.signIn === 'broker') { void broker.begin(connection.provider); return; }
      void act(connection.id, () => signIn(connection.provider, { connectionId: connection.id }));
    },
    onSync: connection => void act(connection.id, async () => {
      const current = (await api<ConnectionsResponse>('/api/connections')).connections.find(item => item.id === connection.id);
      if (!current) throw new Error('This source is no longer listed. Refresh Sources.');
      await post(`/api/connections/${connection.id}/sync`, { version: current.version });
      setPolling(true);
      return '';
    }),
    onSchedule: (connection, input) => act(connection.id, async () => {
      if (!connection.job) throw new Error('This connection has no sync job yet. Refresh and try again.');
      await post(`/api/connections/${connection.id}/schedule`, { version: connection.job.version, ...input }, 'PUT');
      return input.frequency === 'manual' ? `${connection.displayName} syncs only when you choose Sync now.` : !input.enabled ? `Automatic updates paused for ${connection.displayName}. Saved data is kept.` : `Sync schedule saved for ${connection.displayName}.`;
    }),
    onDisconnect: connection => act(connection.id, async () => {
      const { revoked } = await post(`/api/connections/${connection.id}/disconnect`, { version: connection.version }) as { revoked?: 'revoked' | 'failed' | 'not_needed' | 'shared' };
      const provider = data?.providers.find(item => item.id === connection.provider);
      const label = provider?.signInProvider === 'meta' ? 'Meta' : provider?.label ?? 'the provider';
      if (revoked === 'failed') return `${connection.displayName} disconnected and its saved sign-in deleted. ${label} did not confirm that access was revoked; remove Rivet's access in your account settings there. Its synced data is kept.`;
      if (revoked === 'shared') return `${connection.displayName} disconnected and its saved sign-in deleted. Another connection still uses this sign-in. Its synced data is kept.`;
      return `${connection.displayName} disconnected${revoked === 'revoked' ? ` and its access revoked at ${label}` : ''}. Its synced data is kept.`;
    }),
    loadAttempts: async id => (await api<{ attempts: ConnectionAttempt[] }>(`/api/connections/${id}/attempts?limit=10`)).attempts,
    loadSchedules: async () => (await api<{ schedules: WorkflowSchedule[] }>('/api/schedules')).schedules,
  };
  return { data: manager ? data : null, loadError, actionError: actionError || broker.error, notice, busy: busy ?? (broker.busy ? 'broker' : null), choice, broker, focusConnection: returned?.connectionId ?? null, keepNoticeOnNextScope, refresh: load, ...actions };
}
export type ConnectionsController = ReturnType<typeof useConnections>;
