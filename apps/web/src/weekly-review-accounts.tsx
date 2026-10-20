import { RefreshCw } from 'lucide-react';
import type { ConnectionListEntry } from '../../../packages/core/src/sync-jobs';
import { localTime } from './connection-model';
import { SOURCE_PROVIDERS } from './source-connect-options';

export function WeeklyReviewAccounts({ connections, selectedIds, onChange, loading, error, onRetry, disabled = false }: {
  connections: ConnectionListEntry[]; selectedIds: string[]; onChange: (ids: string[]) => void;
  loading: boolean; error: string; onRetry: () => void; disabled?: boolean;
}) {
  const missing = selectedIds.filter(id => !connections.some(item => item.id === id));
  return <fieldset className="weekly-review-accounts" disabled={disabled}>
    <legend>Connected accounts</legend>
    {loading && <p role="status" className="module-tiny">Loading accounts...</p>}
    {error && <div role="alert" className="module-alert"><span>{error}</span><button type="button" onClick={onRetry}><RefreshCw size={13}/> Retry</button></div>}
    {connections.map(connection => {
      const checked = selectedIds.includes(connection.id);
      const provider = SOURCE_PROVIDERS.find(item => item.id === connection.provider)?.label;
      return <label className="module-check-field" key={connection.id}>
        <input type="checkbox" checked={checked} disabled={!checked && (selectedIds.length >= 5 || connection.status === 'disconnected')}
          onChange={event => onChange(event.target.checked ? [...selectedIds, connection.id].sort() : selectedIds.filter(id => id !== connection.id))}/>
        <span>{connection.displayName}<small>{provider ? `${provider} · ` : ''}{connection.status === 'disconnected' ? 'Disconnected' : connection.status === 'needs_attention' ? 'Needs attention' : connection.latestVersion ? `Data as of ${localTime(connection.latestVersion.observedAt)}` : 'Will sync before the first review'}</small></span>
      </label>;
    })}
    {missing.map(id => <label className="module-check-field" key={id}><input type="checkbox" checked onChange={() => onChange(selectedIds.filter(item => item !== id))}/><span>Account unavailable<small>Remove it or restore access before running.</small></span></label>)}
    {!loading && !error && !connections.length && <p className="module-tiny">No connected accounts yet.</p>}
  </fieldset>;
}
