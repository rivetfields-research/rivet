import { useEffect, useState, type FormEvent } from 'react';
import type { WorkspaceSession } from './session-access';
import { accessDescription, EMPTY_APIFY_SETUP, apifySetupReady, localTime, collectionScope, type ApifySetup, type ConnectionProviderOption, type ConnectionChoice, type ConnectionChoiceAccount } from './connection-model';

function googleDataDescription(provider: ConnectionProviderOption): string | null {
  if (provider.signIn !== 'oauth') return null;
  if (provider.id === 'youtube') return 'Your channel identity and up to 500 recent videos: titles, publication dates, and available view, like and comment counts. These are counts at the time of sync, not activity during a selected week.';
  if (provider.id === 'google-analytics') return 'Your GA4 property name and timezone, plus daily sessions, active users, page and screen views, and engaged sessions by channel for the last 90 completed days. Up to 5,000 date/channel rows per sync; partial results are marked.';
  return null;
}

/** Visible before either entry point starts Google's authorization flow. */
export function GoogleConnectionNotice({ provider }: { provider: ConnectionProviderOption }) {
  if (!googleDataDescription(provider)) return null;
  return <div className="module-tiny" aria-label="Google data use">
    <p>Rivet Sources requests read-only Google access. Rivet stores the synced data for your workspace and reports, and keeps authorization tokens encrypted for future syncs.</p>
    <p>By continuing, you agree to <a href="https://rivetfields.com/privacy" target="_blank" rel="noopener noreferrer">Rivet's Privacy Policy</a>{provider.id === 'youtube'
      ? <> and the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a>. Rivet uses YouTube API Services.</> : '.'} See <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google's Privacy Policy</a>.</p>
  </div>;
}

/** Reviewed before anything is read: the source, who can see its data, and that the first sync is the read check. */
export function ConnectionReview({ provider, session }: { provider: ConnectionProviderOption; session: WorkspaceSession | null | undefined }) {
  const meta = provider.signInProvider === 'meta';
  const token = provider.credential === 'api_token' && provider.signIn !== 'broker';
  const googleData = googleDataDescription(provider);
  return <dl className="data-connection-review">
    {provider.signIn === 'broker' && <div><dt>Connection</dt><dd>Rivet opens a secure sign-in for the source you choose, then stores synced copies in this workspace. Disconnecting here stops future Rivet syncs.</dd></div>}
    <div><dt>What Rivet reads</dt><dd>{meta
      ? 'For each account you pick: its posts from the last 90 days (at most 500) and each post\'s likes, comments, shares or reactions, read again at each sync. Syncs only read; nothing is posted or changed there.'
      : token ? 'Public posts in the Apify dataset you name, or in the newest successful run of the task you name: up to 1,000 records per sync, continuing where the last sync stopped. A task\'s newer run is read from its start. Syncs only read; nothing is run, posted or changed in Apify.'
        : googleData ?? <>Data from {provider.label}, each time it syncs. Syncs only read; nothing is posted or changed there.</>}</dd></div>
    {token && <div><dt>API token</dt><dd>Rivet keeps your Apify token encrypted for this connection only and shows it only as configured. Disconnecting deletes it.</dd></div>}
    <div><dt>Who can see it</dt><dd>{accessDescription(session)}</dd></div>
    {provider.signIn === 'oauth' && <div><dt>Sign-in</dt><dd>{meta
      ? 'You sign in with Facebook next, then choose which Instagram accounts and Facebook Pages to connect. Nothing is connected until you choose. Rivet keeps the sign-in encrypted and never shows it; Meta asks you to sign in again about every 60 days.'
      : <>You sign in to {provider.label} next, and come back here. Rivet keeps that sign-in encrypted and never shows it.</>}</dd></div>}
    <div><dt>First sync</dt><dd>{provider.automaticDailySync ? 'Starts after you choose your accounts. Updates daily.' : meta ? 'After you confirm your accounts, Rivet starts the first sync. You can choose a schedule later.' : 'Choose Sync now to read it for the first time. No data is shown until that sync succeeds.'}</dd></div>
  </dl>;
}

/** Apify setup (M9): what to read, whose posts they are, and the owner's API token. Labels say what each field is for. */
export function ApifySetupFields({ value, busy, onChange }: { value: ApifySetup; busy: boolean; onChange: (next: ApifySetup) => void }) {
  const set = (change: Partial<ApifySetup>) => onChange({ ...value, ...change });
  return <>
    <fieldset className="data-connection-providers"><legend>Read from</legend>
      <label className="module-check-field"><input type="radio" name="apify-source" value="dataset" checked={value.source === 'dataset'} disabled={busy} onChange={() => set({ source: 'dataset' })} /><span>A dataset</span></label>
      <label className="module-check-field"><input type="radio" name="apify-source" value="task" checked={value.source === 'task'} disabled={busy} onChange={() => set({ source: 'task' })} /><span>A task's newest successful run</span></label>
    </fieldset>
    <div className="module-field"><label htmlFor="apify-id">{value.source === 'task' ? 'Task ID' : 'Dataset ID'}</label>
      <input id="apify-id" value={value.id} maxLength={129} required disabled={busy} autoComplete="off" spellCheck={false} onChange={event => set({ id: event.target.value })} />
      <small>{value.source === 'task' ? 'From Apify Console: the task ID, or owner~task-name.' : 'From Apify Console: the dataset ID of a finished run.'}</small></div>
    <div className="module-field"><label htmlFor="apify-platform">Platform</label>
      <select id="apify-platform" value={value.platform} required disabled={busy} onChange={event => set({ platform: event.target.value as ApifySetup['platform'] })}>
        <option value="">Choose a platform</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option></select></div>
    <div className="module-field"><label htmlFor="apify-account">Account</label>
      <input id="apify-account" value={value.account} maxLength={120} required disabled={busy} onChange={event => set({ account: event.target.value })} />
      <small>Whose posts these are, such as the handle or Page name.</small></div>
    <div className="module-field"><label htmlFor="apify-token">Apify API token</label>
      <input id="apify-token" type="password" value={value.token} maxLength={256} required disabled={busy} autoComplete="off" spellCheck={false} onChange={event => set({ token: event.target.value })} />
      <small>From Apify Console → Settings → API &amp; Integrations.</small></div>
  </>;
}

export function AddConnectionPanel({ workspaceName, providers, session, busy, onCreate, onCancel }: {
  workspaceName: string; providers: ConnectionProviderOption[]; session: WorkspaceSession | null | undefined; busy: boolean;
  onCreate: (provider: string, displayName: string, apify?: ApifySetup) => Promise<unknown> | void; onCancel: () => void;
}) {
  const enabled = providers.filter(item => item.enabled), unavailable = providers.filter(item => !item.enabled);
  const [provider, setProvider] = useState('');
  const [name, setName] = useState('');
  const [apify, setApify] = useState<ApifySetup>(EMPTY_APIFY_SETUP);
  const selected = enabled.find(item => item.id === provider);
  // A sign-in that lists accounts names each connection from its account; names are confirmed after signing in.
  const namedLater = Boolean(selected?.signInProvider) || selected?.signIn === 'broker';
  const token = selected?.credential === 'api_token' && selected?.signIn !== 'broker';
  const ready = Boolean(selected && (namedLater || name.trim()) && (!token || apifySetupReady(apify)));
  function submit(event: FormEvent) {
    event.preventDefault();
    if (selected && ready && !busy) void onCreate(selected.id, namedLater ? '' : name.trim(), token ? apify : undefined);
  }
  // The user picks a source; nothing is attached automatically.
  return <form className="data-connection-add" aria-labelledby="data-connection-add-heading" onSubmit={submit}>
    <h3 id="data-connection-add-heading" tabIndex={-1}>Add data to {workspaceName}</h3>
    {enabled.length ? <fieldset className="data-connection-providers"><legend>Connect a source</legend>
      {enabled.map(item => <label key={item.id} className="module-check-field"><input type="radio" name="connection-provider" value={item.id} checked={provider === item.id} disabled={busy}
        onChange={() => { setProvider(item.id); if (!name.trim() && !item.signInProvider) setName(item.label); }} /><span>{item.label}</span></label>)}
    </fieldset> : <p className="data-connection-hint">No connections are available yet. You can still upload an export in Sources.</p>}
    {unavailable.length > 0 && <details className="data-connection-unavailable"><summary>Other sources</summary>
      <ul>{unavailable.map(item => <li key={item.id}>{item.label}</li>)}</ul><p>These connections are not available yet. You can upload an export in Sources.</p></details>}
    {selected && <>
      {namedLater ? <p className="data-connection-hint">Each account you choose is named from the account, such as "@handle · Instagram". You can change the names before connecting.</p>
        : <div className="module-field"><label htmlFor="data-connection-name">Name</label><input id="data-connection-name" value={name} maxLength={160} required disabled={busy} onChange={event => setName(event.target.value)} /></div>}
      {token && <ApifySetupFields value={apify} busy={busy} onChange={setApify} />}
      <ConnectionReview provider={selected} session={session} />
      <GoogleConnectionNotice provider={selected} />
    </>}
    <div className="data-connection-actions">
      {enabled.length > 0 && <button type="submit" className="button secondary compact" disabled={busy || !ready}>{selected?.signIn === 'oauth' ? busy ? 'Opening sign-in…' : 'Continue to sign in' : busy ? 'Adding…' : 'Add connection'}</button>}
      <button type="button" className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

const CHOICE_STATE: Record<ConnectionChoiceAccount['state'], string> = {
  new: '', reconnect: 'Reconnects your saved connection', connected: 'Already connected', unavailable: 'Connected here by another person',
};
/**
 * After a sign-in that lists accounts (M8): the person picks which accounts become connections. Nothing is chosen in
 * advance, each pick is its own connection named from the account, and names can be changed before connecting.
 */
export function ConnectionChooser({ choice, busy, onConnect, onCancel, providers = [] }: {
  choice: ConnectionChoice; busy: boolean; onConnect: (accounts: { id: string; displayName: string }[]) => void; onCancel: () => void;
  providers?: ConnectionProviderOption[];
}) {
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(choice.accounts.map(account => [account.id, account.displayName])));
  // Back from the sign-in, focus (and so scroll to) the choice the person has to make.
  useEffect(() => { document.getElementById('data-connection-choose-heading')?.focus(); }, []);
  const choosable = (account: ConnectionChoiceAccount) => account.state === 'new' || account.state === 'reconnect';
  const ready = picked.length > 0 && picked.every(id => names[id]?.trim());
  function submit(event: FormEvent) {
    event.preventDefault();
    if (ready && !busy) onConnect(picked.map(id => ({ id, displayName: names[id]!.trim() })));
  }
  return <form className="data-connection-add data-connection-choose" aria-labelledby="data-connection-choose-heading" onSubmit={submit}>
    <h3 id="data-connection-choose-heading" tabIndex={-1}>Choose accounts to connect</h3>
    <p>Sync starts when you connect.</p>
    {choice.accounts.length ? <ul className="data-connection-choices">{choice.accounts.map(account => {
      const checked = picked.includes(account.id);
      return <li key={account.id}>
        <label className="module-check-field"><input type="checkbox" checked={checked} disabled={busy || !choosable(account)}
          onChange={event => setPicked(current => event.target.checked ? [...current, account.id] : current.filter(id => id !== account.id))} />
          <span>{account.displayName}<small>{account.providerLabel}{CHOICE_STATE[account.state] ? ` · ${CHOICE_STATE[account.state]}` : ''}</small></span></label>
        {checked && <details><summary>Rename</summary><div className="module-field"><label htmlFor={`data-connection-choice-${account.id}`}>Name</label>
          <input id={`data-connection-choice-${account.id}`} value={names[account.id] ?? ''} maxLength={160} required disabled={busy}
            onChange={event => setNames(current => ({ ...current, [account.id]: event.target.value }))} /></div></details>}
      </li>;
    })}</ul> : <p className="data-connection-hint">This sign-in did not include an account Rivet can read.</p>}
    {picked.length > 0 && <div className="source-collection-summary">{[...new Set(picked.map(id => choice.accounts.find(account => account.id === id)!.provider))].map(id => {
      const provider = providers.find(item => item.id === id);
      if (!provider) return null;
      const scope = collectionScope(provider);
      const reconnecting = choice.accounts.some(account => picked.includes(account.id) && account.provider === id && account.state === 'reconnect');
      return <p key={id}>{scope ?? provider.label}{reconnecting ? ' · Existing schedules kept' : provider.automaticDailySync ? ' · Daily updates' : ''}</p>;
    })}</div>}
    <p className="module-tiny">Choose before <time dateTime={choice.expiresAt}>{localTime(choice.expiresAt)}</time>. After that, sign in again.</p>
    <div className="data-connection-actions">
      <button type="submit" className="button secondary compact" disabled={busy || !ready}>{busy ? 'Connecting…' : picked.length > 1 ? `Connect ${picked.length} accounts` : 'Connect account'}</button>
      <button type="button" className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
