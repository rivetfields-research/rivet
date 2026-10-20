import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Pencil, RefreshCw } from 'lucide-react';
import type { OrganizationEmailRecipient, OrganizationRecipientSettings } from '../../../packages/core/src/organization-types';
import { api, message } from './api';
import { OrganizationDialog } from './organization-dialog';

export function RecipientFirstName({memberId, firstName, person, disabled = false, onSaved}: {
  memberId: string; firstName: string | null; person?: string; disabled?: boolean;
  onSaved: (recipient: OrganizationEmailRecipient) => void;
}) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const label = person ? `Edit first name for ${person}` : 'Edit your first name';
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const recipient = await api<OrganizationEmailRecipient>(`/api/email-recipients/${encodeURIComponent(memberId)}`, {
        method: 'PATCH', body: JSON.stringify({firstName: draft.trim() || null}),
      });
      onSaved(recipient); setEditing(false);
    } catch (reason) { setError(message(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <>
    <span className="recipient-first-name"><span>{firstName ?? 'Not set'}</span><button type="button" className="icon-button" aria-label={label} title={label} disabled={disabled} onClick={() => {
      setDraft(firstName ?? ''); setError(''); setEditing(true);
    }}><Pencil size={16}/></button></span>
    {editing && <OrganizationDialog title={person ? `First name for ${person}` : 'Your first name'} onClose={() => { if (!pending.current) setEditing(false); }}>
      <form onSubmit={event => void save(event)}>
        <label>First name (optional)<input name="firstName" autoComplete={person ? 'off' : 'given-name'} maxLength={80} value={draft} disabled={busy || disabled} onChange={event => setDraft(event.target.value)}/></label>
        {error && <p className="org-error" role="alert">{error}</p>}
        <footer><button type="button" className="org-button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button><button type="submit" className="org-button org-primary" disabled={busy || disabled}>{busy ? 'Saving...' : 'Save'}</button></footer>
      </form>
    </OrganizationDialog>}
  </>;
}

export function AccountFirstName() {
  const [recipient, setRecipient] = useState<OrganizationEmailRecipient | null>(null);
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setRecipient(null); setError('');
    void api<OrganizationRecipientSettings>('/api/email-recipients', {signal: controller.signal}).then(settings => {
      if (controller.signal.aborted) return;
      const self = settings.recipients.find(item => item.memberId === settings.selfMemberId);
      if (!self) throw new Error('Your recipient settings are unavailable.');
      setRecipient(self);
    }).catch(reason => { if (!controller.signal.aborted) setError(message(reason)); });
    return () => controller.abort();
  }, [attempt]);
  return <div><dt>First name (optional)</dt><dd>
    {recipient ? <RecipientFirstName memberId={recipient.memberId} firstName={recipient.firstName} onSaved={setRecipient}/> : error ? <>
      <span role="alert">{error}</span><button type="button" className="icon-button" title="Retry recipient settings" aria-label="Retry recipient settings" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16}/></button>
    </> : <span role="status">Loading first name...</span>}
  </dd></div>;
}
