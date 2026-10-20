import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Building2, Check, Copy, Gauge, MailPlus, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import type { OrganizationDetail, OrganizationInvitation, OrganizationMember, OrganizationSession, OrganizationSummary, OrganizationTeam } from '../../../packages/core/src/organization-types';
import { api, ApiError, message } from './api';
import { RivetMark } from './rivet-mark';
import { invitationStorageKey, readInvitationToken } from './invitation-token';
import { OrganizationDialog as Dialog } from './organization-dialog';
import { UsageAdminPanel } from './usage-admin';
import { StaffAdminPanel } from './staff-admin';
import { WorkspaceAccessLayout } from './workspace-access-layout';

const endpoint = '/api/admin/organizations';
const date = (value: string) => new Date(value).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
const person = (member: OrganizationMember) => member.identity.displayName || member.identity.email || 'Member';
const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
type Editor = {kind: 'create'; requestId: string} | {kind: 'edit' | 'suspend'} | {kind: 'invite'; email?: string} |
  {kind: 'member' | 'remove'; member: OrganizationMember} | {kind: 'approve' | 'cancel'; invite: OrganizationInvitation} |
  {kind: 'team' | 'delete-team'; team?: OrganizationTeam};

function Identity({invite}: {invite: OrganizationInvitation}) {
  if (!invite.claimant) return null;
  return <div className="org-claim"><strong>{invite.claimant.displayName || 'Signed-in account'}</strong><span>{invite.claimant.email || 'No email supplied by sign-in'}</span>
    <details><summary>Verified account identity</summary><dl><dt>Issuer</dt><dd>{invite.claimant.issuer}</dd><dt>Subject</dt><dd>{invite.claimant.subject}</dd></dl></details>
  </div>;
}

function OrganizationEditor({editor, org, onClose, onSaved, onStale}: {editor: Editor; org: OrganizationDetail | null; onClose: () => void; onSaved: (detail: OrganizationDetail, token?: string, delivery?: string, deliveryMessage?: string) => void; onStale: () => void}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  // Keep the version at which the form opened, even when the underlying view refreshes.
  const version = useRef(org?.version).current;
  const titles: Record<Editor['kind'], string> = {create: 'Create organization', edit: 'Edit organization', suspend: org?.status === 'active' ? 'Suspend organization' : 'Resume organization', invite: 'Invite a member', member: 'Change member role', remove: 'Remove member', approve: 'Approve join request', cancel: 'Cancel invitation', team: editor.kind === 'team' && editor.team ? 'Edit team' : 'Create team', 'delete-team': 'Delete team'};
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      const base = `${endpoint}/${org?.id}`;
      let url = base, method = 'POST', input: Record<string, unknown> = {version};
      if (editor.kind === 'create') { url = endpoint; input = {requestId: editor.requestId, name: fields.get('name'), contact: fields.get('contact'), relationship: fields.get('relationship')}; }
      if (editor.kind === 'edit' || editor.kind === 'suspend') {
        method = 'PATCH'; input = {...input, name: org!.name, contact: org!.contact, relationship: org!.relationship, status: org!.status};
        if (editor.kind === 'edit') Object.assign(input, {name: fields.get('name'), contact: fields.get('contact'), relationship: fields.get('relationship')});
        else input.status = org!.status === 'active' ? 'suspended' : 'active';
      }
      if (editor.kind === 'invite') { url += '/invitations'; Object.assign(input, {email: fields.get('email'), role: fields.get('role')}); }
      if (editor.kind === 'member' || editor.kind === 'remove') { url += `/members/${editor.member.id}`; method = 'PATCH'; Object.assign(input, {role: editor.kind === 'remove' ? editor.member.role : fields.get('role'), active: editor.kind !== 'remove'}); }
      if (editor.kind === 'approve' || editor.kind === 'cancel') url += `/invitations/${editor.invite.id}/${editor.kind}`;
      if (editor.kind === 'team') { url += `/teams${editor.team ? `/${editor.team.id}` : ''}`; method = editor.team ? 'PUT' : 'POST'; Object.assign(input, {name: fields.get('name'), memberIds: fields.getAll('members')}); }
      if (editor.kind === 'delete-team') { url += `/teams/${editor.team!.id}`; method = 'DELETE'; }
      if (editor.kind === 'invite') {
        const result = await api<{detail: OrganizationDetail; token?: string; delivery?: string; deliveryMessage?: string}>(url, {method, body: JSON.stringify(input), signal: AbortSignal.timeout(60000)});
        onSaved(result.detail, result.token, result.delivery, result.deliveryMessage);
      } else onSaved(await api<OrganizationDetail>(url, {method, body: JSON.stringify(input)}));
    } catch (reason) {
      setError(message(reason));
      if (reason instanceof ApiError && reason.code === 'organization_changed') { setStale(true); onStale(); }
    } finally { setBusy(false); }
  };
  const closing = () => { if (!busy) onClose(); };
  return <Dialog title={titles[editor.kind]} onClose={closing}><form onSubmit={submit}>
    <fieldset disabled={busy || stale}>
      {(editor.kind === 'create' || editor.kind === 'edit') && <>
        <label>Organization name<input name="name" required maxLength={120} defaultValue={editor.kind === 'edit' ? org?.name : ''} autoFocus autoComplete="organization"/></label>
        <label>Contact email <span className="org-muted">(optional)</span><input name="contact" type="email" maxLength={254} defaultValue={editor.kind === 'edit' ? org?.contact : ''} autoComplete="email"/></label>
        <label>Relationship<select name="relationship" defaultValue={editor.kind === 'edit' ? org?.relationship : 'prospect'}><option value="prospect">Prospect</option><option value="pilot">Pilot</option><option value="customer">Customer</option></select></label>
      </>}
      {editor.kind === 'invite' && <><label>Email<input name="email" type="email" required maxLength={254} defaultValue={editor.email} autoFocus/></label><RoleSelect initial="operator"/></>}
      {editor.kind === 'member' && <><p>{person(editor.member)}</p><RoleSelect initial={editor.member.role}/></>}
      {editor.kind === 'remove' && <p>Remove <strong>{person(editor.member)}</strong> from {org?.name} and its teams? Returning members need a new invitation.</p>}
      {editor.kind === 'suspend' && <p>{org?.status === 'active' ? 'Suspend organization membership and cancel outstanding invitations? Records and teams will be kept. Existing pilot access is separate and will not change.' : 'Resume organization membership? Cancelled invitations will stay cancelled.'}</p>}
      {editor.kind === 'approve' && <><p>Approve this account as <strong>{editor.invite.role}</strong> for {org?.name}?</p><Identity invite={editor.invite}/><p className="org-note">This review is only needed because the signed-in email did not exactly match {editor.invite.email}.</p></>}
      {editor.kind === 'cancel' && <p>Cancel the invitation for <strong>{editor.invite.email}</strong>? Its link will stop accepting join requests.</p>}
      {editor.kind === 'team' && <><label>Team name<input name="name" required maxLength={80} defaultValue={editor.team?.name ?? ''} autoFocus/></label><div className="org-checklist"><strong>Members</strong>{org?.members.filter(member => member.active).map(member => <label key={member.id}><input type="checkbox" name="members" value={member.id} defaultChecked={editor.team?.memberIds.includes(member.id)}/><span>{person(member)}<small>{member.identity.email || titleCase(member.role)}</small></span></label>)}{!org?.memberCount && <p className="org-muted">No active members yet.</p>}</div></>}
      {editor.kind === 'delete-team' && <p>Delete <strong>{editor.team?.name}</strong>? Its members will remain in the organization.</p>}
    </fieldset>
    {error && <p className="org-error" role="alert">{error}</p>}
    <footer><button type="button" className="org-button" disabled={busy} onClick={onClose}>{stale ? 'Close and review changes' : 'Cancel'}</button><button type="submit" className={`org-button org-primary ${['remove','delete-team','cancel'].includes(editor.kind) || (editor.kind === 'suspend' && org?.status === 'active') ? 'org-danger' : ''}`} disabled={busy || stale}>{busy ? editor.kind === 'invite' ? 'Sending...' : 'Saving...' : editor.kind === 'invite' ? 'Send invitation' : editor.kind === 'create' ? 'Create organization' : ['edit','team','member'].includes(editor.kind) ? 'Save' : titles[editor.kind]}</button></footer>
  </form></Dialog>;
}

const workspaceLabel = (state: OrganizationSummary['workspace']['state']) => ({not_provisioned: 'Not opened yet', provisioning: 'Setting up', ready: 'Ready', failed: 'Needs attention'}[state]);

export function OrganizationWorkspacePanel({org}: {org: OrganizationDetail}) {
  return <section><h2>Private workspaces</h2><dl>
    <dt>Setup</dt><dd>Automatic on first visit</dd>
    <dt>Ready</dt><dd>{org.privateWorkspaces?.ready ?? 0}</dd>
    <dt>Needs attention</dt><dd>{org.privateWorkspaces?.attention ?? 0}</dd>
    <dt>Visibility</dt><dd>Only the individual member</dd>
  </dl></section>;
}

function RoleSelect({initial}: {initial: string}) {
  return <label>Role<select name="role" defaultValue={initial}><option value="owner">Owner</option><option value="operator">Operator</option><option value="reviewer">Reviewer</option></select></label>;
}

export function OrganizationMembersTable({members, teams, disabled, onEdit, onRemove}: {
  members: OrganizationMember[]; teams: OrganizationTeam[]; disabled: boolean;
  onEdit: (member: OrganizationMember) => void; onRemove: (member: OrganizationMember) => void;
}) {
  const ordered = [...members].sort((a, b) => Number(b.active) - Number(a.active) || person(a).localeCompare(person(b)) || a.id.localeCompare(b.id));
  return <div className="org-table-scroll"><table className="org-members-table">
    <caption className="sr-only">Organization members and assigned roles</caption>
    <thead><tr><th>Member</th><th>Role</th><th>Teams</th><th>Membership</th><th>Private workspace</th><th><span className="sr-only">Actions</span></th></tr></thead>
    <tbody>{ordered.map(member => <tr key={member.id}>
      <td><strong>{person(member)}</strong><small>{member.identity.email || 'No email supplied'}</small></td>
      <td>{titleCase(member.role)}</td>
      <td>{teams.filter(team => team.memberIds.includes(member.id)).map(team => team.name).join(', ') || 'No team'}</td>
      <td>{member.active ? 'Active' : 'Removed'}</td>
      <td>{member.active ? workspaceLabel(member.workspaceState ?? 'not_provisioned') : 'Access revoked'}</td>
      <td><div className="org-actions">{member.active && <>
        <button className="org-icon" title={`Change role for ${person(member)}`} aria-label={`Change role for ${person(member)}`} disabled={disabled} onClick={() => onEdit(member)}><Pencil size={16}/></button>
        <button className="org-icon" title={`Remove ${person(member)}`} aria-label={`Remove ${person(member)}`} disabled={disabled} onClick={() => onRemove(member)}><Trash2 size={16}/></button>
      </>}</div></td>
    </tr>)}</tbody>
  </table></div>;
}

function InviteLink({token, onClose}: {token: string; onClose: () => void}) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const link = `${location.origin}/join#${token}`;
  return <Dialog title="Invite ready" onClose={onClose}><div className="org-link-result"><label>Invitation link<input readOnly value={link} onFocus={event => event.currentTarget.select()}/></label><p className="org-note">Share this link privately. The invited email is approved automatically after Microsoft sign-in; a different account pauses for review.</p>{error && <p className="org-error" role="alert">{error}</p>}<button className="org-button" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { setError('Clipboard unavailable. Select and copy the link above.'); } }}>{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? 'Copied' : 'Copy link'}</button><footer><button className="org-button org-primary" onClick={onClose}>Done</button></footer></div></Dialog>;
}

export function OrganizationAdminApp() {
  const [usageView, setUsageView] = useState(() => new URLSearchParams(location.search).get('view') === 'usage');
  const [staffView, setStaffView] = useState(() => new URLSearchParams(location.search).get('view') === 'staff');
  const [session, setSession] = useState<OrganizationSession | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [org, setOrg] = useState<OrganizationDetail | null>(null);
  const [selected, setSelected] = useState(() => new URLSearchParams(location.search).get('organization'));
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [search, setSearch] = useState(''), [status, setStatus] = useState('all'), [relationship, setRelationship] = useState('all'), [page, setPage] = useState(1);
  const [tab, setTab] = useState('Overview'), [editor, setEditor] = useState<Editor | null>(null), [token, setToken] = useState<string | null>(null);
  const request = useRef(0);
  const load = async (id: string | null = selected) => {
    const sequence = ++request.current;
    setLoading(true); setError('');
    try {
      const current = await api<OrganizationSession>('/api/organization-session');
      if (sequence !== request.current) return;
      setSession(current);
      if (!current.staff) throw new Error('Organization administration is available only to Rivet staff.');
      const result = id ? await api<OrganizationDetail>(`${endpoint}/${encodeURIComponent(id)}`) : await api<{organizations: OrganizationSummary[]}>(endpoint);
      if (sequence !== request.current) return;
      if ('organizations' in result) { setOrganizations(result.organizations); setOrg(null); }
      else setOrg(result);
    } catch (reason) { if (sequence === request.current) { setError(message(reason)); setOrg(null); setOrganizations([]); } }
    finally { if (sequence === request.current) setLoading(false); }
  };
  useEffect(() => { document.title = `${staffView ? 'Rivet admins' : usageView ? 'Usage & limits' : 'Organizations'} | Rivet Admin`; }, [usageView, staffView]);
  useEffect(() => { const back = () => { setStaffView(new URLSearchParams(location.search).get('view') === 'staff'); setUsageView(new URLSearchParams(location.search).get('view') === 'usage'); setSelected(new URLSearchParams(location.search).get('organization')); setTab('Overview'); setEditor(null); setToken(null); }; window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back); }, []);
  useEffect(() => { void load(selected); return () => { request.current++; }; }, [selected]);
  const navigate = (id: string | null) => { history.pushState(null, '', id ? `/admin?organization=${encodeURIComponent(id)}` : '/admin'); setStaffView(false); setUsageView(false); setOrg(null); setSelected(id); setTab('Overview'); setNotice(''); };
  const save = (detail: OrganizationDetail, inviteToken?: string, delivery?: string, deliveryMessage?: string) => { setEditor(null); setOrg(detail); setError(delivery === 'failed' ? deliveryMessage ?? 'Invitation setup did not complete. Refresh its status before using Send again.' : ''); setNotice(delivery === 'submitted' ? 'Microsoft accepted the invitation email for sending.' : delivery === 'failed' ? '' : inviteToken ? 'Invitation created.' : 'Changes saved.'); if (!selected) { history.pushState(null, '', `/admin?organization=${detail.id}`); setSelected(detail.id); } if (inviteToken) setToken(inviteToken); };
  const filtered = organizations.filter(item => (status === 'all' || item.status === status) && (relationship === 'all' || item.relationship === relationship) && `${item.name} ${item.contact}`.toLowerCase().includes(search.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 25)), currentPage = Math.min(page, pages);
  const enabled = Boolean(session?.staff && !loading);
  const active = org?.status === 'active';
  return <div className="org-app"><aside className="org-sidebar"><a className="org-brand" href="/admin"><RivetMark size={28}/><span>Rivet <small>Admin</small></span></a><nav aria-label="Administration"><button className={!usageView && !staffView ? 'org-nav-selected' : ''} onClick={() => navigate(null)}><Building2 size={18}/>Organizations</button>{session?.usageEnabled && <button className={usageView ? 'org-nav-selected' : ''} onClick={() => { history.pushState(null, '', '/admin?view=usage'); setStaffView(false); setUsageView(true); }}><Gauge size={18}/>Usage &amp; limits</button>}{session?.adminAccessEnabled && <button className={staffView ? 'org-nav-selected' : ''} onClick={() => { history.pushState(null, '', '/admin?view=staff'); setUsageView(false); setStaffView(true); }}><ShieldCheck size={18}/>Rivet admins</button>}</nav><div className="org-sidebar-bottom"><a href="/" target="_blank" rel="noopener">Open Rivet<ArrowUpRight size={15}/></a><span>{session?.displayName || 'Rivet administration'}</span><small>{session?.mode === 'local' ? 'Local development' : 'Staff access'}</small></div></aside>
    <main className="org-main">
      {staffView ? <StaffAdminPanel/> : usageView ? <UsageAdminPanel/> : <>
      <div className="org-topline"><span><ShieldCheck size={15}/>Customer administration</span><button className="org-icon" title="Refresh organizations" aria-label="Refresh organizations" disabled={loading} onClick={() => void load()}><RefreshCw size={16}/></button></div>
      <div className="org-content">
        {session?.mode === 'local' && <p className="org-notice">Local preview. Changes here do not update hosted access.</p>}
        {selected && <button className="org-back" onClick={() => navigate(null)}><ArrowLeft size={16}/>Organizations</button>}
        <header className="org-page-heading"><div><h1>{selected ? org?.name || 'Organization' : 'Organizations'}</h1>{org && <div className="org-heading-meta"><span>{titleCase(org.relationship)}</span><span className={`org-status ${org.status}`}>{titleCase(org.status)}</span></div>}</div><div className="org-actions">{!selected && <button className="org-button org-primary" disabled={!enabled} onClick={() => setEditor({kind: 'create', requestId: crypto.randomUUID()})}><Plus size={16}/>Create organization</button>}{org && <><button className="org-button" disabled={!enabled} onClick={() => setEditor({kind: 'edit'})}><Pencil size={15}/>Edit</button><button className="org-button" disabled={!enabled} onClick={() => setEditor({kind: 'suspend'})}>{active ? 'Suspend' : 'Resume'}</button></>}</div></header>
        {error && <p className="org-error" role="alert">{error}</p>}{notice && <p className="org-notice" role="status">{notice}</p>}
        {loading && <p className="org-empty" role="status">Loading organizations...</p>}
        {!loading && !error && !selected && <>
          <div className="org-filters"><label className="org-search"><Search size={17}/><input aria-label="Search organizations" placeholder="Search organizations" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }}/></label><select aria-label="Filter by relationship" value={relationship} onChange={event => { setRelationship(event.target.value); setPage(1); }}><option value="all">All relationships</option><option value="prospect">Prospects</option><option value="pilot">Pilots</option><option value="customer">Customers</option></select><select aria-label="Filter by status" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="all">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option></select></div>
          <div className="org-table-scroll"><table><caption className="sr-only">Customer organizations</caption><thead><tr><th>Organization</th><th>Relationship</th><th>Members</th><th>Workspace</th><th>Status</th></tr></thead><tbody>{filtered.slice((currentPage - 1) * 25, currentPage * 25).map(item => <tr key={item.id}><td><button className="org-row-link" onClick={() => navigate(item.id)}>{item.name}</button><small>{item.contact || 'No contact'}</small></td><td>{titleCase(item.relationship)}</td><td>{item.memberCount}<small>{item.pendingInvitations ? `${item.pendingInvitations} pending` : `${item.teamCount} teams`}</small></td><td><span className="org-muted">{item.privateWorkspaces?.ready ?? 0} private workspaces</span></td><td><span className={`org-status ${item.status}`}>{titleCase(item.status)}</span></td></tr>)}</tbody></table></div>
          {!filtered.length && <div className="org-empty"><Building2 size={28}/><h2>{organizations.length ? 'No matching organizations' : 'No organizations yet'}</h2>{!organizations.length && <button className="org-button" onClick={() => setEditor({kind: 'create', requestId: crypto.randomUUID()})}><Plus size={16}/>Create organization</button>}</div>}
          <div className="org-pagination"><span>{filtered.length} {filtered.length === 1 ? 'organization' : 'organizations'}</span><div><button className="org-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage} / {pages}</span><button className="org-button" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div></div>
        </>}
        {!loading && org && <><div className="org-tabs" role="tablist" aria-label="Organization sections">{['Overview','Members','Teams','Activity'].map((name, index, tabs) => <button key={name} id={`org-tab-${name}`} role="tab" aria-selected={tab === name} aria-controls="org-panel" tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)} onKeyDown={event => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1; if (next >= 0) { event.preventDefault(); setTab(tabs[next]); document.getElementById(`org-tab-${tabs[next]}`)?.focus(); } }}>{name}{name === 'Members' && <span>{org.memberCount}</span>}{name === 'Teams' && <span>{org.teamCount}</span>}</button>)}</div>
          <section id="org-panel" role="tabpanel" aria-labelledby={`org-tab-${tab}`} tabIndex={0}>
            {tab === 'Overview' && <div className="org-overview"><section><h2>Organization details</h2><dl><dt>Contact</dt><dd>{org.contact ? <a href={`mailto:${org.contact}`}>{org.contact}</a> : 'Not added'}</dd><dt>Created</dt><dd>{date(org.createdAt)}</dd><dt>Members</dt><dd>{org.memberCount} active, {org.pendingInvitations} pending invites</dd><dt>Teams</dt><dd>{org.teamCount}</dd></dl></section><OrganizationWorkspacePanel org={org}/><section><h2>Billing</h2><dl><dt>Status</dt><dd>Not configured</dd><dt>Subscription</dt><dd>None</dd></dl></section></div>}
            {tab === 'Members' && <><div className="org-section-heading"><h2>Members</h2><button className="org-button" disabled={!active} onClick={() => setEditor({kind: 'invite'})}><MailPlus size={16}/>Invite member</button></div><OrganizationMembersTable members={org.members} teams={org.teams} disabled={!active} onEdit={member => setEditor({kind: 'member', member})} onRemove={member => setEditor({kind: 'remove', member})}/>{!org.members.length && <p className="org-empty">No members yet.</p>}
              <div className="org-section-heading"><h2>Invitations</h2></div><div className="org-table-scroll"><table><thead><tr><th>Invited person</th><th>Role</th><th>Status</th><th>Expires</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{org.invitations.map(invite => <tr key={invite.id}><td>{invite.email}{invite.claimant && <Identity invite={invite}/>}</td><td>{titleCase(invite.role)}</td><td>{invite.state === 'claimed' ? 'Review needed' : invite.state === 'accepted' ? 'Joined' : titleCase(invite.state)}</td><td>{date(invite.expiresAt)}{invite.delivery && <small className="org-note">{invite.delivery === 'submitted' ? 'Email submitted' : invite.delivery === 'failed' ? 'Setup needs attention' : 'Preparing access and email'}</small>}</td><td><div className="org-actions">{['pending', 'expired'].includes(invite.state) && <button className="org-icon" disabled={!active} title={`Send again to ${invite.email}`} aria-label={`Send again to ${invite.email}`} onClick={() => setEditor({kind: 'invite', email: invite.email})}><MailPlus size={16}/></button>}{invite.state === 'claimed' && <button className="org-button" disabled={!active} onClick={() => setEditor({kind: 'approve', invite})}>Review</button>}{['pending','claimed'].includes(invite.state) && <button className="org-icon" disabled={!active} title={`Cancel invitation for ${invite.email}`} aria-label={`Cancel invitation for ${invite.email}`} onClick={() => setEditor({kind: 'cancel', invite})}><X size={16}/></button>}</div></td></tr>)}</tbody></table></div>{!org.invitations.length && <p className="org-empty">No invitations.</p>}</>}
            {tab === 'Teams' && <><div className="org-section-heading"><h2>Teams</h2><button className="org-button" disabled={!active} onClick={() => setEditor({kind: 'team'})}><Plus size={16}/>Create team</button></div><div className="org-table-scroll"><table><thead><tr><th>Team</th><th>Members</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{org.teams.map(team => <tr key={team.id}><td><strong>{team.name}</strong></td><td>{team.memberIds.length}<small>{team.memberIds.map(id => org.members.find(member => member.id === id)).filter((member): member is OrganizationMember => Boolean(member)).map(person).join(', ')}</small></td><td><div className="org-actions"><button className="org-icon" disabled={!active} aria-label={`Edit ${team.name}`} title={`Edit ${team.name}`} onClick={() => setEditor({kind: 'team', team})}><Pencil size={16}/></button><button className="org-icon" disabled={!active} aria-label={`Delete ${team.name}`} title={`Delete ${team.name}`} onClick={() => setEditor({kind: 'delete-team', team})}><Trash2 size={16}/></button></div></td></tr>)}</tbody></table></div>{!org.teams.length && <div className="org-empty"><Users size={28}/><h2>No teams yet</h2></div>}</>}
            {tab === 'Activity' && <div className="org-table-scroll"><table><caption>Latest 50 changes</caption><thead><tr><th>Action</th><th>When</th><th>Actor</th></tr></thead><tbody>{org.activity.map(item => <tr key={item.id}><td>{item.action}</td><td>{new Date(item.at).toLocaleString()}</td><td><details><summary>Account identity</summary><code>{item.actor}</code></details></td></tr>)}</tbody></table></div>}
          </section></>}
      </div>
      </>}
    </main>{!usageView && !staffView && editor && <OrganizationEditor editor={editor} org={org} onClose={() => setEditor(null)} onSaved={save} onStale={() => void load()}/ >}{!usageView && !staffView && token && <InviteLink token={token} onClose={() => setToken(null)}/>}
  </div>;
}

export function OrganizationJoinApp() {
  const token = useRef(readInvitationToken(location.hash, sessionStorage));
  const [session, setSession] = useState<OrganizationSession | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{organization: string; state: string; workspaceUrl?: string} | null>(null);
  const started = useRef(false);
  useEffect(() => { document.title = 'Join organization | Rivet'; history.replaceState(null, '', location.pathname); void api<OrganizationSession>('/api/organization-session').then(setSession).catch(reason => setError(message(reason))); }, []);
  const claim = async () => {
    setBusy(true); setError('');
    try {
      const joined = await api<{organization: string; state: 'accepted' | 'claimed'; workspaceUrl?: string}>('/api/organization-join', {method: 'POST', body: JSON.stringify({token: token.current})});
      setResult(joined);
      if (joined.state === 'accepted') {
        try { sessionStorage.removeItem(invitationStorageKey); } catch {}
        location.replace(joined.workspaceUrl ? `${joined.workspaceUrl}?welcome=1` : '/workspaces');
      }
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (session?.mode === 'authenticated' && token.current && !started.current) {
      started.current = true;
      void claim();
    }
  }, [session]);
  return <WorkspaceAccessLayout title={result ? result.state === 'accepted' ? 'Your workspace is ready' : 'Request received' : 'Join your workspace'}>
    {session?.mode === 'authenticated' && <p>Signed in as {session.displayName}.</p>}
    {result ? <><p>{result.state === 'accepted' ? `You have joined ${result.organization}.` : 'Your account needs an administrator to review this invitation.'}</p><a className="org-button org-primary" href="/workspaces">Continue to your workspace <ArrowUpRight size={15}/></a></>
      : session?.mode === 'local' ? <p>Invitation requests require Microsoft sign-in on the hosted app. This local preview cannot verify an invited person.</p>
        : !token.current ? <p>Open the invitation link in your email to continue.</p>
          : <button className="org-button org-primary" disabled={!session || busy} onClick={() => void claim()}>{busy ? 'Joining...' : 'Continue'}</button>}
    {error && <p className="org-error" role="alert">{error}</p>}
  </WorkspaceAccessLayout>;
}
