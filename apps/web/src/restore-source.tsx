import { useState } from 'react';
import { ArchiveRestore } from 'lucide-react';
import type { ArchivedSource } from '../../../packages/core/src/types';
import { message } from './api';

export type RestoreSource = (id: string) => Promise<void>;

export function RestoreSourceButton({ archived, onRestore, disabled = false }: {
  archived: ArchivedSource; onRestore?: RestoreSource; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function restore() {
    if (!onRestore || busy) return;
    setBusy(true); setError('');
    try { await onRestore(archived.source.id); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <span className="source-restore">
    {!archived.canRestore ? <small>Original file unavailable. Upload it again to use it in new work.</small>
      : onRestore ? <button type="button" className="text-button" disabled={disabled || busy} onClick={() => void restore()} aria-label={`Restore ${archived.source.title}`}><ArchiveRestore size={14}/>{busy ? 'Restoring...' : 'Restore file'}</button>
        : <small>Ask a workspace owner to restore this file.</small>}
    {error && <span role="alert">{error}</span>}
  </span>;
}
