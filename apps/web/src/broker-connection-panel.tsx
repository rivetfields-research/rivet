import { useState } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';
import type { useBrokerConnection } from './use-broker-connection';
import { PlatformIcon } from './platform-icon';

export function BrokerConnectionPanel({ broker, label, icon, onDone }: {
  broker: ReturnType<typeof useBrokerConnection>; label?: string; icon?: string; onDone(): void;
}) {
  const [selected, setSelected] = useState('');
  if (!broker.pending) return null;
  const accounts = broker.choice?.accounts ?? [];
  const accountId = accounts.length === 1 ? accounts[0]!.id : accounts.some(account => account.id === selected) ? selected : '';
  const interrupted = broker.signInState !== 'waiting';
  return <section className="source-provider-form" aria-label="Source connection">
    {accounts.length ? <>
      {accounts.length === 1 ? <div className="source-connected-account"><PlatformIcon provider={icon ?? broker.pending.provider}/>
        <div><strong>{accounts[0]!.displayName}</strong><span>{accounts[0]!.providerLabel} account</span></div></div>
        : <div className="module-field"><label htmlFor="source-account">{accounts[0]?.providerLabel} account</label>
        <select id="source-account" value={selected} onChange={event => setSelected(event.target.value)} disabled={broker.busy}>
          <option value="">Choose an account</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.displayName}</option>)}
        </select></div>}
      <p>Sync starts after you connect. Updates daily.</p>
      <button className="button primary" disabled={!accountId || broker.busy} onClick={() => void broker.confirm(accountId).then(done => { if (done) onDone(); })}>
        {broker.busy ? 'Connecting...' : 'Connect account'}</button>
    </> : <>
      <p className="source-sign-in-status" role="status">{!interrupted && <LoaderCircle size={18} aria-hidden="true"/>}
        {broker.signInState === 'blocked' ? 'Open sign-in to continue.' : broker.signInState === 'closed' ? 'Sign-in closed. Finish connecting to continue.' : `Waiting for ${label ?? 'your account'} sign-in...`}</p>
      {interrupted && <div className="source-sign-in-actions">
        <button className="button primary source-sign-in" onClick={broker.openSignIn}>
          <PlatformIcon provider={icon ?? broker.pending.provider} size={18}/>{label ? `Sign in with ${label}` : 'Open sign-in'}<ExternalLink size={14} aria-hidden="true"/>
        </button>
      </div>}
    </>}
    {broker.error && <button className="text-button" disabled={broker.busy} onClick={() => void broker.check()}>Try again</button>}
    <details className="source-connect-details"><summary>Connection details</summary>
      <p>Windsor handles account authorization and collection for Rivet. Choose only the accounts you want to share.</p>
    </details>
    <div className="source-connect-actions"><button className="button secondary" disabled={broker.busy} onClick={() => void broker.cancel().then(done => { if (done) onDone(); })}>Cancel</button></div>
  </section>;
}
