import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Building2, ChartNoAxesCombined, RefreshCw } from 'lucide-react';
import { api, ApiError, message } from './api';
import { WorkspaceAccessLayout } from './workspace-access-layout';
import { canManageSources, type WorkspaceSession } from './session-access';
import type { OrganizationWorkspace } from '../../../packages/core/src/organization-types';

type Workspace = { id: string; name: string; workspace: OrganizationWorkspace };
type Entry = { mode: 'local' | 'pilot' } | { mode: 'authenticated'; displayName: string; workspaces: Workspace[] };
const signIn = '/oauth2/start?rd=%2Fonboarding';

export function OnboardingApp() {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [selected, setSelected] = useState('');
  const [workspace, setWorkspace] = useState<{ url: string; name: string; canConnect: boolean } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);
  const request = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const operation = useRef(0);

  const load = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    const version = ++operation.current;
    setBusy(true); setError(''); setUnauthorized(false); setEntry(null); setWorkspace(null);
    try {
      const mode = document.querySelector('meta[name="rivet-onboarding"]')?.getAttribute('content');
      if (mode === 'local') {
        const session = await api<WorkspaceSession>('/api/session', { signal });
        if (session.mode !== 'local') throw new Error('Open your signed-in workspace to continue.');
        if (version !== operation.current) return;
        setEntry({ mode: 'local' }); setWorkspace({ url: '/', name: 'Your workspace', canConnect: true });
      } else if (mode === 'pilot') {
        const session = await api<WorkspaceSession>('/api/session', { signal });
        if (session.mode !== 'authenticated' || !session.workspaceId || session.privateWorkspace || session.organizationId || session.workspacesEnabled)
          throw new Error('Your workspace access could not be checked. Please try again.');
        if (version !== operation.current || controller.signal.aborted) return;
        setEntry({ mode: 'pilot' }); setWorkspace({ url: '/', name: 'Your workspace', canConnect: canManageSources(session) });
      } else if (mode === 'authenticated') {
        const session = await api<{ mode: string; displayName: string }>('/api/organization-session', { signal });
        if (session.mode !== 'authenticated') throw new Error('Your account could not be checked. Please try again.');
        const { workspaces } = await api<{ workspaces: Workspace[] }>('/api/organization-workspaces', { signal });
        if (version !== operation.current) return;
        const requested = new URLSearchParams(location.search).get('organizationId');
        setSelected(workspaces.find(row => row.id === requested)?.id ?? (workspaces.length === 1 ? workspaces[0].id : ''));
        setEntry({ mode: 'authenticated', displayName: session.displayName, workspaces });
      } else throw new Error('Open onboarding from your Rivet server to continue.');
    } catch (reason) {
      if (controller.signal.aborted || version !== operation.current) return;
      setError(message(reason)); setUnauthorized(reason instanceof ApiError && reason.status === 401);
    } finally { if (version === operation.current && !controller.signal.aborted) setBusy(false); }
  };

  useEffect(() => {
    document.title = 'Get started | Rivet'; void load();
    return () => { ++operation.current; request.current?.abort(); };
  }, []);
  useEffect(() => { if (workspace) heading.current?.focus(); }, [workspace]);

  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || entry?.mode !== 'authenticated') return;
    const row = entry.workspaces.find(item => item.id === selected);
    if (!row) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    const version = ++operation.current;
    setBusy(true); setError(''); setUnauthorized(false);
    try {
      const result = await api<{ workspaceUrl: string }>('/api/organization-workspaces/open', {
        method: 'POST', body: JSON.stringify({ organizationId: row.id }), signal,
      });
      const expected = `/w/${row.id}/`;
      if (result.workspaceUrl !== expected) throw new Error('The workspace could not be opened. Please try again.');
      const session = await api<WorkspaceSession>(`${expected}api/session`, { signal });
      if (session.mode !== 'authenticated' || session.organizationId !== row.id || !session.privateWorkspace)
        throw new Error('Your workspace access could not be checked. Please try again.');
      if (version !== operation.current || controller.signal.aborted) return;
      setWorkspace({ url: expected, name: row.name, canConnect: canManageSources(session) });
    } catch (reason) {
      if (version !== operation.current || controller.signal.aborted) return;
      setError(reason instanceof DOMException && reason.name === 'TimeoutError' ? 'Opening your workspace timed out. Please try again.' : message(reason));
      setUnauthorized(reason instanceof ApiError && reason.status === 401);
    } finally { if (version === operation.current && !controller.signal.aborted) setBusy(false); }
  };

  const ready = Boolean(workspace);
  const title = ready ? workspace?.canConnect ? 'Start with your data' : 'Your workspace is ready' : entry?.mode === 'authenticated' && entry.workspaces.length === 0 ? 'Your workspace is one invitation away' : 'Welcome to Rivet';
  return <WorkspaceAccessLayout title={title} headingRef={heading}>
    <div className="onboarding-content">
      {busy && !entry ? <p className="onboarding-status" role="status">Opening Rivet...</p> : <>
        {error && <p className="org-error" role="alert">{error}</p>}
        {unauthorized ? <a className="org-button org-primary onboarding-primary" href={signIn}>Sign in again<ArrowRight size={16}/></a> : !entry ?
          <button className="org-button onboarding-primary" onClick={() => void load()}><RefreshCw size={16}/>Try again</button> : workspace ? <>
            <h2 className="onboarding-workspace"><Building2 size={16} aria-hidden="true"/>{workspace.name}</h2>
            <p>{workspace.canConnect ? 'Connect an account, then ask for your first report.' : 'Open the sources and reports available to your account.'}</p>
            <a className="org-button org-primary onboarding-primary" href={workspace.canConnect ? `${workspace.url}?view=tables&connect=data&welcome=1` : workspace.url}>{workspace.canConnect ? 'Connect a source' : 'Open workspace'}<ArrowRight size={16}/></a>
            {workspace.canConnect && <a className="onboarding-secondary" href={workspace.url}>I already have data<ArrowRight size={15}/></a>}
            <div className="onboarding-example"><ChartNoAxesCombined size={18} aria-hidden="true"/><div>
              <a href={`${workspace.url}?view=example`}>Explore a sample report<ArrowRight size={14}/></a>
              <small>Fictional data. No account connection needed.</small>
            </div></div>
            {entry.mode === 'authenticated' && entry.workspaces.length > 1 && <button className="onboarding-back" onClick={() => { setWorkspace(null); setError(''); }}><ArrowLeft size={14}/>Choose another workspace</button>}
          </> : entry.mode === 'authenticated' && entry.workspaces.length ? <form onSubmit={event => void open(event)}>
            <p>Choose where you want to work.</p>
            <label htmlFor="onboarding-workspace">Workspace</label>
            <select id="onboarding-workspace" value={selected} disabled={busy} required onChange={event => { setSelected(event.target.value); setError(''); }}>
              <option value="" disabled>Choose a workspace</option>
              {entry.workspaces.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
            <button className="org-button org-primary onboarding-primary" type="submit" disabled={!selected || busy}>{busy ? 'Opening workspace...' : 'Continue'}<ArrowRight size={16}/></button>
            <p className="onboarding-account">{entry.displayName}</p>
          </form> : <>
            <p>Open the invitation link from your team, using the account it was sent to.</p>
            <button className="org-button onboarding-primary" onClick={() => void load()}><RefreshCw size={16}/>Check workspace access</button>
            <a className="onboarding-secondary" href="/oauth2/sign_out?rd=%2Fonboarding">Use another account<ArrowRight size={15}/></a>
          </>}
      </>}
    </div>
  </WorkspaceAccessLayout>;
}
