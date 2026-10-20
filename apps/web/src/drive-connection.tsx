import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, RefreshCw, X } from 'lucide-react';
import type { GoogleDriveStatus } from '../../../packages/core/src/google-drive';
import { api, message } from './api';
import { chooseGoogleDocs } from './google-picker';

type DriveState = GoogleDriveStatus & { pickerConfigured: boolean; setup: { appOrigin: string | null; redirectUri: string | null; missing: string[] } };
const BASE = '/api/connections/google-drive';
export function useDriveConnection() {
  const [state, setState] = useState<DriveState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const epoch = useRef(0);
  const refreshSequence = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (operation.current) return;
    const generation = epoch.current, sequence = ++refreshSequence.current;
    const current = () => mounted.current && epoch.current === generation && sequence === refreshSequence.current && !operation.current;
    try { const next = await api<DriveState>(BASE); if (current()) { setState(next); setError(''); } }
    catch (error) { if (current()) setError(message(error)); }
  }, []);
  useEffect(() => {
    mounted.current = true; epoch.current++; void refresh();
    const url = new URL(location.href);
    if (url.searchParams.has('drive')) {
      if (url.searchParams.get('drive') === 'connected') setNotice('Google Drive connected. Choose the documents your tasks can read.');
      else setNotice('Google sign-in did not finish. Try connecting again.');
      url.searchParams.delete('drive'); history.replaceState({}, '', url);
    }
    return () => { mounted.current = false; epoch.current++; refreshSequence.current++; operation.current?.abort(); operation.current = null; };
  }, [refresh]);
  const act = async (work: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (operation.current || !mounted.current) return false;
    const controller = new AbortController(), generation = epoch.current;
    operation.current = controller; refreshSequence.current++;
    const current = () => mounted.current && generation === epoch.current && operation.current === controller && !controller.signal.aborted;
    setBusy(true); setError(''); setNotice('');
    try { await work(controller.signal, current); return current(); }
    catch (error) {
      if (!current()) return false;
      // A timeout can follow a committed selection/disconnect. Read status; never replay it.
      try { const next = await api<DriveState>(BASE); if (current()) setState(next); } catch { /* Preserve the original error. */ }
      if (current()) setError(message(error)); return false;
    } finally {
      if (operation.current === controller) { operation.current = null; if (mounted.current && generation === epoch.current) setBusy(false); }
    }
  };
  const post = <T,>(route: string, value: unknown, signal: AbortSignal) => api<T>(`${BASE}${route}`, { method: 'POST', body: JSON.stringify(value), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  return { state, busy, error, notice, refresh,
    connect: () => act(async (signal, current) => {
      const next = await post<{url:string}>('/authorize', {}, signal);
      if (!current()) return;
      const url = new URL(next.url);
      if (url.origin !== 'https://accounts.google.com') throw new Error('Google sign-in returned an unexpected destination.');
      location.assign(url.href);
    }),
    choose: () => act(async (signal, current) => {
      const session = await post<{accessToken:string;apiKey:string;appId:string}>('/picker-session', {}, signal);
      if (!current()) return;
      const ids = await chooseGoogleDocs(session, signal);
      if (ids === null || !current()) return;
      const next = await post<DriveState>('/selection', {fileIds:ids}, signal);
      if (current()) { setState(next); setNotice('Document selection updated. New tasks use these approved documents.'); }
    }),
    remove: (id:string) => act(async (signal, current) => {
      const next = await post<DriveState>('/selection', {fileIds:state?.files.filter(file=>file.id!==id).map(file=>file.id) ?? []}, signal);
      if (current()) { setState(next); setNotice('Document removed from future tasks. Saved evidence is preserved.'); }
    }),
    disconnect: () => act(async (signal, current) => {
      const next = await post<DriveState>('/disconnect', {}, signal);
      if (current()) { setState(next); setNotice('Drive disconnected. New tasks cannot read its files. Saved evidence is preserved.'); }
    }),
  };
}
export type DriveConnection = ReturnType<typeof useDriveConnection>;

export function DriveConnectionPanel({ connection, activeRun }: {connection:DriveConnection;activeRun:boolean}) {
  const {state,busy,error,notice} = connection;
  const [confirmDisconnect,setConfirmDisconnect] = useState(false);
  if (!state) return <section className="drive-connection"><p>{error || 'Checking Google Drive…'}</p>{error && <button className="button secondary" onClick={()=>void connection.refresh()}>Retry status</button>}</section>;
  const connected = state.status === 'connected';
  return <section className="drive-connection" aria-label="Google Drive connection">
    {error && <p className="connector-alert" role="alert">{error}</p>}{notice && <p className="drive-notice" role="status">{notice}</p>}
    {!state.configured || !state.pickerConfigured ? <>
      <p>Google setup is needed on this server before you can connect.</p>
      <details className="drive-setup"><summary>Setup instructions</summary>
        <ol><li>In a Google Cloud project, enable the Drive API and Google Picker API.</li><li>Create a Web application OAuth client. Add this redirect URI:<code>{state.setup.redirectUri ?? 'Not configured for this profile'}</code>and this JavaScript origin:<code>{state.setup.appOrigin ?? 'Not configured for this profile'}</code></li><li>Configure the server’s Google client ID/secret, restricted Picker API key and project number in <code>.env</code>, then restart. See <code>docs/CONNECTORS.md</code>.</li></ol>
        <p>Missing: {state.setup.missing.join(', ')}. Keep secrets out of chat and browser storage.</p>
      </details><button className="button secondary" disabled={busy} onClick={()=>void connection.refresh()}><RefreshCw size={14}/>Check setup</button>
    </> : <>
      <div className="drive-account"><strong>{state.account?.email ?? 'No account connected'}</strong><span>{connected?'Connected':state.status==='expired'?'Reconnect needed':'Disconnected'}</span></div>
      <p>{connected ? 'Tasks can search and read only your selected Google Docs.' : 'Sign in to choose the documents your agent can use.'}</p>
      {!connected && state.message.startsWith('Disconnected locally.') && <p className="drive-notice" role="status">{state.message}</p>}
      {activeRun && <p className="drive-notice">Changing this connection stops the current task.</p>}
      {connected ? <>
        <button className="button connector-plan-button" disabled={busy} onClick={()=>void connection.choose()}>{busy?'Working…':state.files.length?'Change documents':'Choose documents'}</button>
        <ul className="drive-file-list">{state.files.map(file=><li key={file.id}><FileText size={15}/><span>{file.name}</span><button className="icon-button" disabled={busy} aria-label={`Remove ${file.name}`} onClick={()=>void connection.remove(file.id)}><X size={13}/></button></li>)}</ul>
        {!state.files.length && <p>No documents selected yet.</p>}
      </> : <button className="button connector-plan-button" disabled={busy} onClick={()=>void connection.connect()}>{busy?'Opening Google…':state.status==='expired'?'Reconnect Google Drive':'Connect Google Drive'}</button>}
      {state.account && (confirmDisconnect ? <div className="drive-disconnect"><p>Disconnect Drive? Future reads stop. Saved task evidence remains.</p><button className="button secondary" disabled={busy} onClick={()=>void connection.disconnect().then(ok=>{ if (ok) setConfirmDisconnect(false); })}>Disconnect</button><button disabled={busy} onClick={()=>setConfirmDisconnect(false)}>Keep connected</button></div> : <button className="connector-inline-action" disabled={busy} onClick={()=>setConfirmDisconnect(true)}>Disconnect account</button>)}
    </>}
  </section>;
}
