import { useEffect, useRef, useState } from 'react';
import { FileText, RefreshCw, Save } from 'lucide-react';
import { message } from './api';
import { olderDraftLabels, olderDraftNotes, readOlderDrafts, saveOlderDraftNotes, type OlderDraft } from './older-drafts';
import { workspaceProfileStorage } from './workflow-workspace';

export function OlderDraftRecovery({ profile, canSave, refreshVersion, onSaved }: { profile: string; canSave: boolean; refreshVersion: number; onSaved: () => void | Promise<void> }) {
  const [state, setState] = useState<ReturnType<typeof readOlderDrafts>>({ items: [], error: '' });
  const [revision, setRevision] = useState(0);
  useEffect(() => { setState(readOlderDrafts(workspaceProfileStorage(profile))); }, [profile, refreshVersion, revision]);
  if (!state.items.length && !state.error) return null;
  return <section className="older-drafts" aria-label="Recover older drafts">
    <h2>Recover older drafts</h2>
    {state.error && <p className="module-alert" role="alert">{state.error} <button className="text-button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14}/>Retry drafts</button></p>}
    {state.items.map(item => <OlderDraftNote key={item.key} item={item} canSave={canSave} onSaved={onSaved}/>)}
  </section>;
}

function OlderDraftNote({ item, canSave, onSaved }: { item: OlderDraft; canSave: boolean; onSaved: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const input = olderDraftNotes(item);
  const saved = savedContent === input.content;
  async function save() {
    if (!canSave || pending.current || saved) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await saveOlderDraftNotes(input);
      setSavedContent(input.content); setNotice('Notes saved in Tables. The original browser draft is unchanged.');
      try { await onSaved(); } catch { setNotice('Notes saved. Refresh Tables to update the list. The original browser draft is unchanged.'); }
    } catch (cause) { setError(message(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <details className="older-draft-note">
    <summary><FileText size={17}/><span><strong>{item.draft.name || 'Untitled draft'}</strong><small>{olderDraftLabels[item.draft.kind]}{item.unfinished ? ' / Unfinished' : ''} / This browser only</small></span></summary>
    <pre tabIndex={0}>{input.content}</pre>
    <button className="button secondary" disabled={!canSave || busy || saved} onClick={() => void save()}><Save size={14}/>{saved ? 'Notes saved' : busy ? 'Saving notes...' : 'Save notes to files'}</button>
    {notice && <p role="status">{notice}</p>}{error && <p className="module-alert" role="alert">{error}</p>}
  </details>;
}
