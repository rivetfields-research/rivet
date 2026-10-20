import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Gauge, Pencil, RefreshCw, RotateCcw, Search } from 'lucide-react';
import type { AdminUsage, AdminUsageRow, UsageResetPreview, UsageResetReceipt } from '../../../packages/core/src/usage-admin-types';
import { api, ApiError, message } from './api';
import { OrganizationDialog } from './organization-dialog';
import { useAdminControls } from './admin-control-dialog';

const endpoint = '/api/admin/usage';
const pendingKey = 'rivet.admin.pending-allowance-reset.v1';
const number = (value: number) => value.toLocaleString();
const remaining = (value: {used: number; limit: number}) => Math.max(0, value.limit - value.used);
type Pending = {requestId: string; scope: string; expected: string; reason: string};
function pending(): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
    return value && ['requestId','scope','expected','reason'].every(key => typeof value[key] === 'string') ? value : null;
  } catch { return null; }
}

function ResetDialog({preview, label, recovery, onClose, onSaved}: {
  preview: UsageResetPreview | null; label: string; recovery?: Pending;
  onClose: () => void; onSaved: (receipt: UsageResetReceipt) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(Boolean(recovery));
  const request = useRef<Pending | null>(recovery ?? null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') || '').trim();
    const input = request.current ?? {requestId: crypto.randomUUID(), scope: preview!.scope, expected: preview!.expected, reason};
    try { sessionStorage.setItem(pendingKey, JSON.stringify(input)); }
    catch { setError('Browser storage is unavailable. Enable session storage before submitting a reset.'); return; }
    request.current = input;
    setBusy(true); setError('');
    try {
      const receipt = await api<UsageResetReceipt>(`${endpoint}/resets`, {method: 'POST', body: JSON.stringify(input)});
      sessionStorage.removeItem(pendingKey);
      onSaved(receipt);
    } catch (reason) {
      setError(message(reason)); setUncertain(true);
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500) {
        sessionStorage.removeItem(pendingKey); setStale(true); setUncertain(false);
      }
    } finally { setBusy(false); }
  };
  const pool = (preview?.scope ?? recovery?.scope) === 'installation';
  const daily = (preview?.scope ?? recovery?.scope)?.startsWith('daily:');
  return <OrganizationDialog title={pool ? 'Replenish shared pool' : daily ? 'Reset daily tasks' : 'Reset monthly tokens'} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <p><strong>{label}</strong></p>
      {preview && <dl className="org-reset-amounts">{daily ? <><dt>Additional tasks today</dt><dd>{number(preview.dailyRuns ?? 0)}</dd></> : <><dt>Additional output tokens</dt><dd>{number(preview.outputTokens)}</dd><dt>Additional input byte units</dt><dd>{number(preview.inputByteUnits)}</dd></>}{!pool && <><dt>People receiving a reset</dt><dd>{preview.people}</dd></>}</dl>}
      <p className="org-note">{pool ? 'This permits additional service usage this month. Personal allowances stay unchanged.' : daily ? 'Restores the normal daily task allowance remaining until 00:00 UTC. Monthly tokens and the shared pool stay unchanged; both must also have room.' : 'Restores the normal monthly token allowance remaining. The shared pool stays unchanged.'} Usage history, files and tasks are kept. Default limits do not change.</p>
      <label>Reason<input name="reason" required maxLength={240} defaultValue={recovery?.reason ?? ''} readOnly={uncertain} disabled={busy || stale}/></label>
      {uncertain && <p className="org-note">Confirmation is still pending. Retrying this request cannot grant the allowance twice.</p>}
      {error && <p role="alert" className="org-error">{error}</p>}
      <footer><button type="button" className="org-button" disabled={busy} onClick={onClose}>{stale ? 'Close and refresh' : 'Cancel'}</button><button type="submit" className="org-button org-primary" disabled={busy || stale}>{busy ? 'Applying...' : uncertain ? 'Retry same request' : pool ? 'Confirm replenishment' : 'Confirm reset'}</button></footer>
    </form>
  </OrganizationDialog>;
}

export function UsageMembersTable({users, onReset, onDailyReset, onLimit}: {users: AdminUsageRow[]; onReset: (row: AdminUsageRow) => void; onDailyReset?: (row: AdminUsageRow) => void; onLimit?: (row: AdminUsageRow) => void}) {
  const showDaily = users.some(row => row.daily || row.dailyLimit);
  return <div className="org-table-scroll"><table className="org-members-table"><caption className="sr-only">Personal model allowances</caption><thead><tr><th>Member</th><th>Organization</th>{showDaily && <th>Daily tasks left</th>}<th>Output remaining</th><th>Input remaining</th><th>Status</th><th><span className="sr-only">Reset monthly tokens</span></th></tr></thead><tbody>{users.map(row => <tr key={row.id}>
    <td><strong>{row.name}</strong><small>{row.email}</small></td><td>{row.organization}</td>
    {showDaily && <td>{row.daily ? <><span>{number(remaining(row.daily))}</span><button className="org-icon" title={`Reset daily tasks for ${row.name}`} aria-label={`Reset daily tasks for ${row.name}`} disabled={!onDailyReset || !row.dailyPreview?.dailyRuns} onClick={() => onDailyReset?.(row)}><RotateCcw size={16}/></button><small>{number(row.daily.used)} started today</small></> : 'Unavailable'}{row.dailyLimit && <div><small>{number(row.dailyLimit.value)} per day</small><button className="org-icon" title={`Change daily limit for ${row.name}`} aria-label={`Change daily limit for ${row.name}`} disabled={!onLimit || !['ready','read_only'].includes(row.status)} onClick={() => onLimit?.(row)}><Pencil size={15}/></button></div>}</td>}
    <td>{row.allowance ? number(remaining(row.allowance.outputTokens)) : 'Unavailable'}{row.allowance && <small>{number(row.allowance.outputTokens.used)} reserved</small>}</td>
    <td>{row.allowance ? number(remaining(row.allowance.inputByteUnits)) : 'Unavailable'}{row.allowance && <small>{number(row.allowance.inputByteUnits.used)} reserved</small>}</td>
    <td>{{ready: 'Active', inactive: 'Access paused', read_only: 'Read-only', unavailable: 'Needs attention'}[row.status]}</td>
    <td><button className="org-icon" title={`Reset monthly tokens for ${row.name}`} aria-label={`Reset monthly tokens for ${row.name}`} disabled={!row.preview || (!row.preview.inputByteUnits && !row.preview.outputTokens)} onClick={() => onReset(row)}><RotateCcw size={16}/></button></td>
  </tr>)}</tbody></table></div>;
}

export function UsageAdminPanel() {
  const [data, setData] = useState<AdminUsage | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true), [search, setSearch] = useState('');
  const [reset, setReset] = useState<{preview: UsageResetPreview | null; label: string; recovery?: Pending} | null>(null);
  const [recovery, setRecovery] = useState<Pending | null>(pending);
  const sequence = useRef(0);
  const load = async () => {
    const current = ++sequence.current; setLoading(true); setError('');
    try {
      const next = await api<AdminUsage>(endpoint);
      if (sequence.current !== current) return;
      setData(next);
      const stored = pending();
      if (stored && next.history.some(item => item.id === stored.requestId)) {
        sessionStorage.removeItem(pendingKey); setRecovery(null); setNotice('The pending allowance change was applied.');
      } else setRecovery(stored);
    } catch (reason) { if (sequence.current === current) { setError(message(reason)); setData(null); } }
    finally { if (sequence.current === current) setLoading(false); }
  };
  useEffect(() => { document.title = 'Usage & limits | Rivet Admin'; void load(); return () => { sequence.current++; }; }, []);
  const controls = useAdminControls(load);
  const hasDailyCaps = Boolean(data?.users.some(row => row.daily || row.dailyLimit));
  const users = data?.users.filter(row => `${row.name} ${row.email} ${row.organization}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <>
    <div className="org-topline"><span><Gauge size={15}/>Usage administration</span><button className="org-icon" title="Refresh usage" aria-label="Refresh usage" disabled={loading} onClick={() => void load()}><RefreshCw size={16}/></button></div>
    <div className="org-content"><header className="org-page-heading"><h1>Usage &amp; limits</h1></header>
      {error && <p className="org-error" role="alert">{error}</p>}{notice && <p className="org-notice" role="status">{notice}</p>}
      {controls.notice}
      {loading && <p className="org-empty" role="status">Loading allowances...</p>}
      {recovery && <p className="org-notice">An allowance change needs confirmation. <button className="org-button" onClick={() => setReset({preview: null, label: 'Pending allowance change', recovery})}>Review pending change</button></p>}
      {data && !loading && <>
        <p className="org-muted">Monthly reset: {new Date(data.resetsAt).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})}. {hasDailyCaps ? 'Daily tasks reset at 00:00 UTC.' : 'No daily task cap.'}</p>
        <section><div className="org-section-heading"><h2>Shared model pool</h2><button className="org-button" disabled={Boolean(recovery)} onClick={() => setReset({preview: data.installation.preview, label: 'Shared model pool'})}><RotateCcw size={16}/>Replenish pool</button></div>
          <div className="org-usage-pool"><div><span>Output tokens remaining</span><strong>{number(remaining(data.installation.allowance.outputTokens))}</strong><small>{number(data.installation.allowance.outputTokens.used)} reserved of {number(data.installation.allowance.outputTokens.limit)}</small></div><div><span>Input byte units remaining</span><strong>{number(remaining(data.installation.allowance.inputByteUnits))}</strong><small>{number(data.installation.allowance.inputByteUnits.used)} reserved of {number(data.installation.allowance.inputByteUnits.limit)}</small></div></div>
          <p className="org-note">Conservative reservations, not billing totals or a dollar cap. Both the personal allowance and shared pool must have room for a task.</p>
        </section>
        <section><div className="org-section-heading"><h2>Personal allowances</h2><div className="org-actions">{hasDailyCaps && <button className="org-button" disabled={Boolean(recovery) || !data.allDaily?.people} onClick={() => setReset({preview: data.allDaily!, label: 'All active users'})}><RotateCcw size={16}/>Reset daily tasks</button>}<button className="org-button" disabled={Boolean(recovery) || !data.allUsers.people} onClick={() => setReset({preview: data.allUsers, label: 'All active users'})}><RotateCcw size={16}/>Reset monthly tokens</button></div></div>
          <div className="org-filters"><label className="org-search"><Search size={17}/><input aria-label="Search usage by member or organization" placeholder="Find a member or organization" value={search} onChange={event => setSearch(event.target.value)}/></label></div>
          <UsageMembersTable users={users.map(row => recovery ? {...row, preview: null, dailyPreview: null} : row)} onReset={row => setReset({preview: row.preview, label: `${row.name} / ${row.organization}`})} onDailyReset={row => setReset({preview: row.dailyPreview!, label: `${row.name} / ${row.organization}`})} onLimit={recovery || controls.pending ? undefined : row => controls.open({kind: 'daily_limit', id: row.id, label: `${row.name} / ${row.organization}`, version: row.dailyLimit!.version, value: row.dailyLimit!.value})}/>
          {!users.length && <p className="org-empty">No matching private workspaces.</p>}
          {Boolean(data.limitHistory?.length) && <details><summary>Daily limit history</summary><div className="org-table-scroll"><table><thead><tr><th>Person</th><th>Daily limit</th><th>Reason</th><th>When</th></tr></thead><tbody>{data.limitHistory!.map(item => <tr key={item.id}><td>{data.users.find(row => row.id === item.target)?.name || 'Member'}</td><td>{number(item.before)} to {number(item.after)}</td><td>{item.reason}</td><td>{new Date(item.at).toLocaleString()}</td></tr>)}</tbody></table></div></details>}
        </section>
        <section><div className="org-section-heading"><h2>Recent allowance changes</h2></div><div className="org-table-scroll"><table><thead><tr><th>Change</th><th>Added allowance</th><th>When</th><th>Approved by</th></tr></thead><tbody>{data.history.map(item => <tr key={item.id}><td><strong>{item.scope === 'installation' ? 'Shared pool replenished' : `${item.scope.startsWith('daily:') ? 'Daily' : 'Monthly'} reset: ${item.adjustments.length} ${item.adjustments.length === 1 ? 'person' : 'people'}`}</strong><small>{item.reason}</small></td><td>{item.scope.startsWith('daily:') ? `${number(item.adjustments.reduce((sum, row) => sum + (row.dailyRuns ?? 0), 0))} tasks` : <>{number(item.adjustments.reduce((sum, row) => sum + row.outputTokens, 0))} output / {number(item.adjustments.reduce((sum, row) => sum + row.inputByteUnits, 0))} input</>}</td><td>{new Date(item.at).toLocaleString()}</td><td><details><summary>Staff account</summary><code>{item.actor}</code></details></td></tr>)}</tbody></table></div>{!data.history.length && <p className="org-empty">No manual resets yet.</p>}</section>
      </>}
    </div>
    {reset && <ResetDialog {...reset} onClose={() => { setReset(null); void load(); }} onSaved={() => { setReset(null); setRecovery(null); setNotice('Allowance updated. Usage history and saved work are unchanged.'); void load(); }}/ >}
    {controls.dialog}
  </>;
}
