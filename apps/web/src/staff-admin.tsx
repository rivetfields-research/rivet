import { useEffect, useState } from 'react';
import { RefreshCw, Search, ShieldCheck, ShieldOff, ShieldPlus } from 'lucide-react';
import type { AdminStaffPerson, AdminStaffSnapshot } from '../../../packages/core/src/admin-control-types';
import { api, message } from './api';
import { useAdminControls } from './admin-control-dialog';

export function StaffMembersTable({people, canManage, onChange}: {people: AdminStaffPerson[]; canManage: boolean; onChange: (person: AdminStaffPerson) => void}) {
  return <div className="org-table-scroll"><table className="org-members-table"><caption className="sr-only">Rivet customer-management access</caption><thead><tr><th>Person</th><th>Organizations</th><th>Admin access</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{people.map(person => <tr key={person.id}>
    <td><strong>{person.name}</strong><small>{person.email}</small></td><td>{person.organizations.join(', ') || 'Rivet administration'}</td><td>{person.access === 'owner' ? 'Account owner' : person.access === 'admin' ? person.eligible ? 'Rivet admin' : 'Admin access paused' : 'No admin access'}</td>
    <td>{canManage && person.access !== 'owner' && <button className="org-icon" disabled={!person.eligible && person.access !== 'admin'} title={`${person.access === 'admin' ? 'Revoke' : 'Grant'} admin access for ${person.name}`} aria-label={`${person.access === 'admin' ? 'Revoke' : 'Grant'} admin access for ${person.name}`} onClick={() => onChange(person)}>{person.access === 'admin' ? <ShieldOff size={17}/> : <ShieldPlus size={17}/>}</button>}</td>
  </tr>)}</tbody></table></div>;
}
export function StaffAdminPanel() {
  const [data, setData] = useState<AdminStaffSnapshot | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [search, setSearch] = useState('');
  const load = async () => {
    setLoading(true); setError('');
    try { setData(await api<AdminStaffSnapshot>('/api/admin/staff')); } catch (reason) { setError(message(reason)); setData(null); }
    finally { setLoading(false); }
  };
  const controls = useAdminControls(load);
  useEffect(() => { document.title = 'Rivet admins | Rivet Admin'; void load(); }, []);
  const people = data?.people.filter(person => `${person.name} ${person.email} ${person.organizations.join(' ')}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <><div className="org-topline"><span><ShieldCheck size={15}/>Customer-management access</span><button className="org-icon" aria-label="Refresh admins" title="Refresh admins" disabled={loading} onClick={() => void load()}><RefreshCw size={16}/></button></div>
    <div className="org-content"><header className="org-page-heading"><h1>Rivet admins</h1></header>
      {error && <p className="org-error" role="alert">{error}</p>}{controls.notice}
      {loading ? <p className="org-empty" role="status">Loading admin access...</p> : data && <>
        <div className="org-filters"><label className="org-search"><Search size={17}/><input aria-label="Find a person" placeholder="Find a person" value={search} onChange={event => setSearch(event.target.value)}/></label></div>
        <StaffMembersTable people={people} canManage={data.canManage && !controls.pending} onChange={person => controls.open({kind: 'staff', id: person.id, label: `${person.name} (${person.email || 'verified account'})`, version: person.version, value: person.access === 'admin' ? 0 : 1})}/>
        {!people.length && <p className="org-empty">No matching members.</p>}
        <details className="org-access-history"><summary>Admin access history</summary><div className="org-table-scroll"><table><thead><tr><th>Change</th><th>When</th><th>Approved by</th></tr></thead><tbody>{data.history.map(item => <tr key={item.id}><td><strong>{item.after ? 'Admin access granted' : 'Admin access revoked'}</strong><small>{item.reason}</small><details><summary>Verified account</summary><code>{item.target}</code></details></td><td>{new Date(item.at).toLocaleString()}</td><td><details><summary>Account owner</summary><code>{item.actor}</code></details></td></tr>)}</tbody></table></div>{!data.history.length && <p className="org-empty">No admin access changes yet.</p>}</details>
      </>}
    </div>{controls.dialog}</>;
}
