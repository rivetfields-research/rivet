import { useRef, useState, type FormEvent } from 'react';
import type { AdminControlChange } from '../../../packages/core/src/admin-control-types';
import { api, ApiError, message } from './api';
import { OrganizationDialog } from './organization-dialog';

type Change = {kind: 'daily_limit' | 'staff'; id: string; label: string; version: number; value: number};
type Pending = Change & {requestId: string; reason: string};
const key = 'rivet.admin.pending-control.v1';
function readPending(): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null');
    return value && ['daily_limit','staff'].includes(value.kind) && /^[a-f0-9-]{36}$/.test(value.id) &&
      ['requestId','label','reason'].every(name => typeof value[name] === 'string') && Number.isInteger(value.version) && Number.isInteger(value.value) ? value : null;
  } catch { return null; }
}

function ControlDialog({change, recovery, onClose, onSaved}: {change: Change; recovery?: Pending; onClose: () => void; onSaved: () => void}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(Boolean(recovery));
  const request = useRef<Pending | null>(recovery ?? null);
  const daily = change.kind === 'daily_limit';
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const input = request.current ?? {...change, requestId: crypto.randomUUID(), reason: String(fields.get('reason') || '').trim(), value: daily ? Number(fields.get('dailyRuns')) : change.value};
    try { sessionStorage.setItem(key, JSON.stringify(input)); }
    catch { setError('Enable browser session storage before saving.'); return; }
    request.current = input; setBusy(true); setError('');
    try {
      await api<AdminControlChange>(daily ? `/api/admin/usage/limits/${input.id}` : `/api/admin/staff/${input.id}`, {method: 'PUT', body: JSON.stringify({
        requestId: input.requestId, version: input.version, reason: input.reason,
        ...(daily ? {dailyRuns: input.value} : {active: input.value === 1}),
      })});
      sessionStorage.removeItem(key); onSaved();
    } catch (reason) {
      setError(message(reason)); setUncertain(true);
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500) { sessionStorage.removeItem(key); setUncertain(false); setStale(true); }
    } finally { setBusy(false); }
  };
  return <OrganizationDialog title={daily ? 'Change daily task limit' : change.value ? 'Grant Rivet admin access' : 'Revoke Rivet admin access'} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit}><p><strong>{change.label}</strong></p>
      {daily ? <><label>Tasks per day<input name="dailyRuns" type="number" min={1} max={1000} step={1} required defaultValue={change.value} readOnly={uncertain} disabled={busy || stale}/></label>
        <p className="org-note">Applies immediately and each new UTC day. Today's task history and manual credits remain. Monthly tokens and the shared pool stay unchanged. A higher limit can permit more service usage.</p></> : <>
        <p>{change.value ? 'This person can manage all customer organizations, invitations, roles and usage limits. This does not grant access to private prompts, files, or infrastructure administration. Only account owners can appoint other Rivet admins.' : 'Customer-management access ends immediately. Organization membership and private workspace access stay unchanged.'}</p>
        <label><input type="checkbox" required disabled={busy || stale || uncertain} defaultChecked={uncertain}/>Confirm {change.value ? 'customer-management access' : 'removal of admin access'}</label>
      </>}
      <label>Reason<input name="reason" required maxLength={240} defaultValue={recovery?.reason ?? ''} readOnly={uncertain} disabled={busy || stale}/></label>
      {uncertain && <p className="org-note">Confirmation is pending. Retry the same request to check its outcome.</p>}
      {error && <p className="org-error" role="alert">{error}</p>}
      <footer><button type="button" className="org-button" disabled={busy} onClick={onClose}>{stale ? 'Close and refresh' : 'Cancel'}</button><button type="submit" className="org-button org-primary" disabled={busy || stale}>{busy ? 'Saving...' : uncertain ? 'Retry same request' : daily ? 'Save limit' : change.value ? 'Grant admin access' : 'Revoke admin access'}</button></footer>
    </form>
  </OrganizationDialog>;
}

export function useAdminControls(onRefresh: () => Promise<void>) {
  const [pending, setPending] = useState(readPending);
  const [editor, setEditor] = useState<{change: Change; recovery?: Pending} | null>(null);
  const close = () => { setEditor(null); setPending(readPending()); void onRefresh(); };
  return {
    pending: Boolean(pending),
    open: (change: Change) => setEditor(pending ? {change: pending, recovery: pending} : {change}),
    notice: pending ? <p className="org-notice">An admin change needs confirmation. <button className="org-button" onClick={() => setEditor({change: pending, recovery: pending})}>Review pending change</button></p> : null,
    dialog: editor ? <ControlDialog {...editor} onClose={close} onSaved={close}/> : null,
  };
}
