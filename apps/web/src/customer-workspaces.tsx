import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Building2, RefreshCw } from 'lucide-react';
import { api, ApiError, message } from './api';
import { customerOrganization, initializeWorkspaceScope } from './workspace-scope';
import type { WorkspaceSession } from './session-access';
import type { OrganizationWorkspace } from '../../../packages/core/src/organization-types';
import { RivetMark } from './rivet-mark';
import { WorkspaceAccessLayout } from './workspace-access-layout';

const signIn = () => `/oauth2/start?rd=${encodeURIComponent(location.pathname + location.search)}`;
export function WorkspaceAvailability({workspace}: {workspace: OrganizationWorkspace}) {
  return <small>{workspace.state === 'ready' ? 'Private workspace' : workspace.state === 'failed' ? 'Workspace needs administrator attention' : 'Ready to start'}</small>;
}
export function CustomerWorkspaceGate({children}: {children: ReactNode}) {
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [unauthorized, setUnauthorized] = useState(false);
  useEffect(() => {
    let current = true;
    void api<WorkspaceSession>('/api/session').then(session => {
      if (!current) return;
      if (session.mode !== 'authenticated' || session.organizationId !== customerOrganization() || !session.browserScope) throw new Error('Workspace identity could not be verified.');
      initializeWorkspaceScope(session.browserScope);
      setReady(true);
    }).catch(reason => { if (current) { setError(message(reason)); setUnauthorized(reason instanceof ApiError && reason.status === 401); } });
    return () => { current = false; };
  }, []);
  if (ready) return children;
  return <WorkspaceAccessLayout title={unauthorized ? 'Welcome back' : error ? 'Workspace unavailable' : 'Opening your workspace'}>
    {error ? <><p role="alert">{error}</p><a className="org-button org-primary" href={unauthorized ? signIn() : '/workspaces'}>{unauthorized ? 'Continue with Microsoft' : 'Your workspaces'}</a></> : <p role="status">Checking access...</p>}
  </WorkspaceAccessLayout>;
}

export function CustomerWorkspacePicker() {
  const [rows, setRows] = useState<{id: string; name: string; workspace: OrganizationWorkspace}[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [unauthorized, setUnauthorized] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const open = async (id: string) => {
    setOpening(id); setError('');
    try {
      const result = await api<{workspaceUrl: string}>('/api/organization-workspaces/open', {method: 'POST', body: JSON.stringify({organizationId: id})});
      location.assign(result.workspaceUrl);
    } catch (reason) { setError(message(reason)); setOpening(null); }
  };
  const load = async () => {
    setLoading(true); setError(''); setUnauthorized(false);
    try {
      const next = (await api<{workspaces: typeof rows}>('/api/organization-workspaces')).workspaces;
      setRows(next);
      if (next.length === 1 && !new URLSearchParams(location.search).has('choose')) await open(next[0].id);
    }
    catch (reason) { setRows([]); setError(message(reason)); setUnauthorized(reason instanceof ApiError && reason.status === 401); }
    finally { setLoading(false); }
  };
  useEffect(() => { document.title = 'Your workspaces | Rivet'; void load(); }, []);
  return <main className="org-app org-workspace-picker"><div className="org-content">
    <header className="org-page-heading"><div><RivetMark size={28}/><h1>Your workspaces</h1></div><button className="org-icon" title="Refresh workspaces" aria-label="Refresh workspaces" disabled={loading} onClick={() => void load()}><RefreshCw size={17}/></button></header>
    {error && <p className="org-error" role="alert">{error}</p>}{unauthorized && <a className="org-button" href={signIn()}>Sign in</a>}
    {loading ? <p role="status">{opening ? 'Preparing your private workspace...' : 'Loading workspaces...'}</p> : <div className="org-workspace-list">{rows.map(row => <div key={row.id}><Building2 size={20}/><div><strong>{row.name}</strong><WorkspaceAvailability workspace={row.workspace}/></div><button className="org-button" disabled={Boolean(opening)} onClick={() => void open(row.id)}>{opening === row.id ? 'Opening...' : 'Open'}<ArrowRight size={16}/></button></div>)}</div>}
    {!loading && !error && !rows.length && <p>No workspace access yet. Open your invitation email or ask a Rivet administrator for an invitation.</p>}
  </div></main>;
}
