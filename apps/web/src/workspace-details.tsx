import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Clock3, RefreshCw } from 'lucide-react';
import type { RunSummary, WorkspaceStatus } from '../../../packages/core/src/types';
import { canManageSources, sessionDisplayName, type WorkspaceSession } from './session-access';
import { WorkspaceDiagnosticsPanel } from './workspace-diagnostics';
import { WorkspaceConnections } from './connectors';
import { OlderDraftRecovery } from './older-draft-recovery';
import { TeamSettings } from './team-admin';
import { AccountFirstName } from './recipient-settings';
import { SettingsTabs, settingsSection, type SettingsSection } from './settings-tabs';
import { signInReturn } from './connection-model';
import { sourceSignInReturn } from './source-connections';
import { BillingSettings } from './billing';

type Props = {
  workspace: WorkspaceStatus | null;
  session?: WorkspaceSession | null;
  onRefresh: () => void | Promise<void>;
  runs?: RunSummary[];
};

export function WorkspaceDetails({ workspace, session, onRefresh, runs = [] }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const pending = useRef(false);
  const budget = workspace?.runBudget;
  const reset = budget ? new Date(budget.resetsAt) : null;
  const validReset = reset && Number.isFinite(reset.getTime());
  const account = session?.mode === 'authenticated' ? session : null;
  const displayName = sessionDisplayName(account);
  const email = account?.email?.trim();
  const connections = workspace?.profile.id === 'workspace-analyst' && canManageSources(session);
  const [billing, setBilling] = useState(session?.testBilling === true);
  const [section, setSection] = useState<SettingsSection>(() => settingsSection(typeof location === 'undefined' ? '' : location.search, true));
  const team = session?.mode === 'authenticated' && !!session.privateWorkspace && !!session.organizationId && session.role === 'owner' && !session.testBilling;
  const activeSection = section === 'team' && !team || section === 'billing' && !billing ? 'account' : section === 'connections' && !connections ? 'account' : section;
  useEffect(() => {
    if (session?.testBilling) { setBilling(true); setSection(settingsSection(location.search, connections, true)); return; }
    setBilling(false);
    if (!['127.0.0.1', 'localhost'].includes(location.hostname) ||
        document.querySelector('meta[name="rivet-test-billing"]')?.getAttribute('content') !== 'local') return;
    const controller = new AbortController();
    void fetch('/api/billing/session', {signal:controller.signal}).then(async response => {
      if (!response.ok) return;
      const value = await response.json();
      if (value.mode === 'test') {
        setBilling(true);
        setSection(settingsSection(location.search, connections, true));
      }
    }).catch(() => { /* Billing is absent from ordinary development and hosted launchers. */ });
    return () => controller.abort();
  }, [connections, session?.testBilling]);
  useEffect(() => {
    if (connections && workspace?.connectionsEnabled && signInReturn(location.search)) {
      location.replace(sourceSignInReturn(location.search));
    }
  }, [connections, workspace?.connectionsEnabled]);
  useEffect(() => {
    const read = () => setSection(settingsSection(location.search, connections, billing));
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [connections, billing]);
  function selectSection(next: SettingsSection) {
    setSection(next);
    const url = new URL(location.href);
    url.searchParams.set('settings', next);
    history.replaceState(history.state, '', url);
  }

  async function refresh() {
    if (pending.current) return;
    pending.current = true;
    setRefreshing(true);
    setError('');
    try { await onRefresh(); }
    catch { setError('Workspace details could not be refreshed. Try again.'); }
    finally { pending.current = false; setRefreshing(false); setRefreshVersion(value => value + 1); }
  }

  return <div className="standard-page library-page settings-page">
    <header className="page-heading connector-heading">
      <div><h1>Settings</h1></div>
      <button type="button" className="icon-button" aria-label={refreshing ? 'Refreshing settings' : 'Refresh settings'} title="Refresh settings" onClick={() => void refresh()} disabled={refreshing}>
        <RefreshCw size={16} />
      </button>
    </header>
    {error && <p className="module-alert" role="alert">{error}</p>}
    <SettingsTabs section={activeSection} connections={connections} team={team} billing={billing} onChange={selectSection}/>
    {billing && activeSection === 'billing' && <section id="settings-billing" className="settings-panel" role="tabpanel" aria-label="Billing" tabIndex={0}><BillingSettings organizationId={account?.organizationId} embedded/></section>}
    <section id="settings-account" className="settings-panel" role="tabpanel" aria-label="Account" hidden={activeSection !== 'account'} tabIndex={0}>
      <h2>Your account</h2>
      {account ? <dl className="settings-account-fields" aria-label="Signed-in account">
        <div><dt>Name</dt><dd>{displayName || email || 'Signed in'}</dd></div>
        {account.privateWorkspace && account.organizationId && activeSection === 'account' && <AccountFirstName key={`${account.workspaceId}:${refreshVersion}`}/>}
        {email && <div><dt>Email</dt><dd>{email}</dd></div>}
        <div><dt>Role</dt><dd>{account.role === 'owner' ? 'Owner' : account.role === 'reviewer' ? 'Reviewer' : 'Operator'}</dd></div>
      </dl> : <p>{session?.mode === 'local' ? 'Local session' : 'Account details unavailable'}</p>}
      {workspace && <><h2 className="settings-subheading">Workspace</h2><dl className="settings-account-fields">
        <div><dt>Name</dt><dd>{workspace.name}</dd></div>
        <div><dt>Environment</dt><dd>{workspace.mode === 'hosted' ? 'Private cloud workspace' : 'Local workspace'}</dd></div>
      </dl></>}
      {team && <button className="text-button settings-admin-link" onClick={() => selectSection('team')}>Manage your team</button>}
      {session?.organizationAdmin && <a className="text-button settings-admin-link" href="/admin">Manage organizations <ArrowUpRight size={15}/></a>}
      {workspace && workspace.profile.id !== 'healthcare-operations' && <OlderDraftRecovery key={workspace.profile.id} profile={workspace.profile.id} canSave={canManageSources(session)} refreshVersion={refreshVersion} onSaved={onRefresh}/>}
    </section>
    {team && activeSection === 'team' && <section id="settings-team" className="settings-panel" role="tabpanel" aria-label="Team" tabIndex={0}><TeamSettings key={`${account!.organizationId}:${account!.workspaceId}:${account!.email ?? ''}:${billing}`} id={account!.organizationId!} localLinks={billing}/></section>}
    {!workspace ? <p className="empty-note" role="status">Workspace details are not available yet.</p> : <>
      <section id="settings-usage" className="settings-panel" role="tabpanel" aria-label="Usage" hidden={activeSection !== 'usage'} tabIndex={0}>
      <section aria-label="Usage" aria-busy={refreshing}>
        {budget && <div className="connection-row">
          <span className="connection-icon"><Clock3 size={19} /></span>
          <div>
            <h2>Daily tasks</h2>
            <p>{budget.used} of {budget.limit} used</p>
            <p>{validReset ? <>Resets <time dateTime={budget.resetsAt}>{reset.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</time></> : 'Reset time unavailable'}</p>
          </div>
        </div>}
      </section>
      {(session?.mode === 'local' || session?.mode === 'authenticated' && session.role === 'owner') && <WorkspaceDiagnosticsPanel key={session?.mode === 'authenticated' ? session.workspaceId : 'local'} workspace={workspace} runs={runs} refreshVersion={refreshVersion} />}
      <WorkspaceConnections workspace={workspace} session={session} refreshVersion={refreshVersion} section="model"/>
      </section>
      {connections && <section id="settings-connections" className="settings-panel" role="tabpanel" aria-label="Connections" hidden={activeSection !== 'connections'} tabIndex={0}>
        <WorkspaceConnections workspace={workspace} session={session} refreshVersion={refreshVersion} section="data"/>
      </section>}
    </>}
  </div>;
}
