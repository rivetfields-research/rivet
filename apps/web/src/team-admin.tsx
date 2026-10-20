import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Copy, ExternalLink, MailPlus, Users, UserMinus, X, Mail, RefreshCw } from 'lucide-react';
import type { OrganizationDetail, OrganizationMember } from '../../../packages/core/src/organization-types';
import { api, message } from './api';
import { RecipientFirstName } from './recipient-settings';

const roleName = (role: OrganizationMember['role']) => ({owner: 'Administrator', operator: 'Member', reviewer: 'Viewer'}[role]);
export function TeamAdminApp() {
  const id = new URLSearchParams(location.search).get('organization') ?? '';
  useEffect(() => { if (id) location.replace(`/w/${encodeURIComponent(id)}/?view=workspace&settings=team`); }, [id]);
  return <p role="status">Opening team settings...</p>;
}
function localInvitationUrl(value: unknown) {
  try {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    if (url.origin !== location.origin || url.username || url.password || url.pathname !== '/onboarding' || url.search || !/^#invite=[A-Za-z0-9_-]{43}$/.test(url.hash)) throw new Error();
    return url.href;
  } catch { throw new Error('The local invitation link could not be verified. Create a new invitation.'); }
}
type LocalInvitation = { url: string; id: string; organizationId: string; version: number; email: string };

export function TeamSettings({id, localLinks = false}: {id: string; localLinks?: boolean}) {
  const [org, setOrg] = useState<OrganizationDetail | null>(null), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [email, setEmail] = useState(''), [role, setRole] = useState('operator');
  const [invitation, setInvitation] = useState<LocalInvitation | null>(null), [copying, setCopying] = useState(false);
  const operation = useRef<AbortController | null>(null), revision = useRef(0), linkRevision = useRef(0);
  const endpoint = `/api/team/${encodeURIComponent(id)}`;
  const clearInvitation = () => { linkRevision.current++; setInvitation(null); setCopying(false); setNotice(''); };
  const load = async () => {
    operation.current?.abort();
    const controller = new AbortController(), current = ++revision.current;
    operation.current = controller;
    setLoading(true); setBusy(false); setOrg(null); setError(''); clearInvitation();
    try { const next = await api<OrganizationDetail>(endpoint, {signal: controller.signal}); if (current === revision.current) setOrg(next); }
    catch (reason) { if (!controller.signal.aborted && current === revision.current) setError(message(reason)); }
    finally { if (current === revision.current) { operation.current = null; setLoading(false); } }
  };
  useEffect(() => {
    document.title = 'Manage your team | Rivet'; void load();
    const clear = () => { clearInvitation(); };
    const visible = () => { if (document.visibilityState === 'hidden') clear(); };
    if (localLinks) { window.addEventListener('pagehide', clear); document.addEventListener('visibilitychange', visible); }
    return () => { revision.current++; linkRevision.current++; operation.current?.abort(); operation.current = null;
      window.removeEventListener('pagehide', clear); document.removeEventListener('visibilitychange', visible); };
  }, [id, localLinks]);
  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!org || operation.current) return;
    const controller = new AbortController(), current = revision.current;
    operation.current = controller;
    setBusy(true); setError(''); clearInvitation();
    const issued = linkRevision.current;
    try {
      const result = await api<{detail: OrganizationDetail; delivery: string; deliveryMessage?: string; invitationUrl?: string}>(`${endpoint}/invitations`, {
        method: 'POST', body: JSON.stringify({version: org.version, email, role}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
      });
      if (current !== revision.current || controller.signal.aborted) return;
      setOrg(result.detail);
      if (localLinks && result.delivery === 'link') {
        const url = localInvitationUrl(result.invitationUrl);
        const row = result.detail.invitations.find(item => item.state === 'pending' && item.email.toLowerCase() === email.trim().toLowerCase() && item.role === role);
        if (result.detail.id !== id || !row) throw new Error('The local invitation could not be verified. Refresh the team and try again.');
        if (issued === linkRevision.current && document.visibilityState !== 'hidden') setInvitation({url, id: row.id, organizationId: id, version: result.detail.version, email: row.email}); setEmail('');
      } else if (result.delivery === 'submitted') { setEmail(''); setNotice('Invitation submitted for email delivery.'); }
      else setError(result.deliveryMessage || 'Invitation delivery needs attention.');
    } catch (reason) { if (current === revision.current && !controller.signal.aborted) { const failure = message(reason); await load(); setError(failure); } }
    finally { if (operation.current === controller) operation.current = null; if (current === revision.current) setBusy(false); }
  };
  const change = async (url: string, input: Record<string, unknown>, method: string) => {
    if (operation.current || !org) return;
    const controller = new AbortController(), current = revision.current;
    operation.current = controller; setBusy(true); setError(''); clearInvitation();
    try { const next = await api<OrganizationDetail>(url, {method, body: JSON.stringify({version: org.version, ...input}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])}); if (current === revision.current) setOrg(next); }
    catch (reason) { if (current === revision.current && !controller.signal.aborted) { const failure = message(reason); await load(); setError(failure); } }
    finally { if (operation.current === controller) operation.current = null; if (current === revision.current) setBusy(false); }
  };
  const visibleInvitation = localLinks && org && invitation && invitation.organizationId === id && invitation.version === org.version &&
    org.invitations.some(row => row.id === invitation.id && row.state === 'pending') ? invitation : null;
  const copyInvitation = async () => {
    if (!visibleInvitation || copying) return;
    const current = linkRevision.current; setCopying(true); setError(''); setNotice('');
    try { await navigator.clipboard.writeText(visibleInvitation.url); if (current === linkRevision.current) setNotice('Invitation link copied.'); }
    catch { if (current === linkRevision.current) setError('Could not copy the invitation link. Open the invitation link instead.'); }
    finally { if (current === linkRevision.current) setCopying(false); }
  };
  if (!org) return <div>{loading ? <p role="status">Checking team access...</p> : <><p className="org-error" role="alert">{error}</p><button className="org-button" onClick={() => void load()}><RefreshCw size={16}/>Retry team access</button><a className="org-button" href="/workspaces">Your workspaces</a></>}</div>;
  return <div className="team-settings">
    <header className="org-page-heading"><div><h2 className="team-name"><Users size={18}/>{org.name}</h2></div><button className="icon-button" title="Refresh team" aria-label="Refresh team" disabled={busy || loading} onClick={() => void load()}><RefreshCw size={16}/></button></header>

    <section><h2>Invite a teammate</h2><form className="signup-invite-form" onSubmit={event => void invite(event)}><label>Email<input type="email" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} autoComplete="email"/></label><label>Role<select value={role} disabled={busy} onChange={event => setRole(event.target.value)}><option value="operator">Member</option><option value="reviewer">Viewer</option><option value="owner">Administrator</option></select></label><button className="org-button org-primary" disabled={busy}><MailPlus size={16}/>{busy ? 'Working...' : localLinks ? 'Create invitation link' : 'Invite teammate'}</button></form></section>
    {error && <p className="org-error" role="alert">{error}</p>}{notice && <p className="org-notice" role="status">{notice}</p>}
    {visibleInvitation && <div className="team-local-invitation" aria-label="Local invitation link"><p>No email was sent in this local preview.</p><p>Invitation ready for {visibleInvitation.email}.</p>
      <div className="team-invitation-actions"><button className="org-button" disabled={copying || busy} onClick={() => void copyInvitation()}><Copy size={16} aria-hidden="true"/>Copy invitation link</button>
        <a className="org-button" href={visibleInvitation.url} target="_blank" rel="noopener noreferrer">Open invitation link<ExternalLink size={16} aria-hidden="true"/></a></div></div>}
    <section><h2>Members <span className="team-count">{org.members.length}</span></h2><div className="org-table-scroll"><table><caption className="sr-only">Team members</caption><thead><tr><th>Person</th><th>First name</th><th>Role</th><th>Access</th><th>Actions</th></tr></thead><tbody>{org.members.map(member => <tr key={member.id}>
      <td><div className="team-person"><span className="team-avatar" aria-hidden="true">{(member.identity.displayName || member.identity.email || '?').slice(0,1).toUpperCase()}</span><span>{member.identity.displayName || member.identity.email || 'Team member'}<small>{member.identity.email}</small></span></div></td>
      <td>{member.active ? <RecipientFirstName memberId={member.id} firstName={member.firstName ?? null} person={member.identity.displayName || member.identity.email || 'Team member'} disabled={busy || loading} onSaved={() => void load()}/> : member.firstName ?? 'Not set'}</td>
      <td>{roleName(member.role)}</td><td><span className={`team-badge ${member.active ? 'active' : ''}`}>{member.active ? 'Active' : 'Removed'}</span></td><td>{member.active && <button className="icon-button team-remove" aria-label="Remove" title="Remove member" disabled={busy} onClick={() => { if (window.confirm(`Remove ${member.identity.displayName || member.identity.email || 'this member'} from the team? Their private data will be retained.`)) void change(`${endpoint}/members/${member.id}`, {role: member.role, active: false}, 'PATCH'); }}><UserMinus size={16}/></button>}</td>
    </tr>)}</tbody></table></div></section>
    <section><h2>Invitations <span className="team-count">{org.invitations.length}</span></h2><div className="org-table-scroll"><table><caption className="sr-only">Team invitations</caption><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>{org.invitations.map(row => <tr key={row.id}><td><div className="team-person"><span className="team-avatar"><Mail size={16}/></span><span>{row.email}</span></div></td><td>{roleName(row.role)}</td><td><span className="team-badge">{row.state === 'accepted' ? 'Joined' : row.state === 'pending' ? 'Pending' : row.state}</span>{row.delivery === 'failed' && <small>Delivery needs attention</small>}</td><td>{['pending','claimed'].includes(row.state) && <button className="icon-button" aria-label="Revoke" title="Revoke invitation" disabled={busy} onClick={() => void change(`${endpoint}/invitations/${row.id}/cancel`, {}, 'POST')}><X size={16}/></button>}</td></tr>)}</tbody></table>{!org.invitations.length && <p className="org-muted">No invitations yet.</p>}</div></section>
  </div>;
}
