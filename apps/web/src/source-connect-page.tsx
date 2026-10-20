import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { ApifySetupFields, ConnectionChooser, ConnectionReview, GoogleConnectionNotice } from './connection-forms';
import { accessDescription, apifySetupReady, EMPTY_APIFY_SETUP, collectionScope } from './connection-model';
import type { WorkspaceSession } from './session-access';
import type { ConnectionsController } from './use-connections';
import { SOURCE_PROVIDERS, sourceConnectOptions, metaConnectOption, type SourceConnectOption } from './source-connect-options';
import './source-connect-page.css';
import { BrokerConnectionPanel } from './broker-connection-panel';
import { PlatformIcon } from './platform-icon';
import { allowsManualImports } from './workspace-scope';

function SourceProviderRow({ option, unavailable, desktop, busy, onStep }: {
  option: SourceConnectOption; unavailable: boolean; desktop: boolean; busy: boolean; onStep(step: string): void;
}) {
  return <button className="source-provider-row" aria-label={option.label} disabled={busy} onClick={() => onStep(option.id)}>
    <span className="source-provider-brand"><PlatformIcon provider={option.id}/></span>
    <span className="source-provider-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
    {unavailable && <span className="source-provider-state">{desktop && !option.deferred ? 'Not in desktop alpha' : 'Not available yet'}</span>}
    <ChevronRight size={16} aria-hidden="true"/>
  </button>;
}

export function SourceConnectPage({ step, onStep, onBack, controller, session, upload }: {
  step: string | null; onStep: (step: string) => void; onBack: () => void;
  controller: ConnectionsController; session: WorkspaceSession | null | undefined; upload: ReactNode;
}) {
  const options = sourceConnectOptions(controller.data?.providers ?? []);
  const allOptions = options.flatMap(option => [option, ...option.choices ?? []]);
  const selected = step === 'meta' ? metaConnectOption(controller.data?.providers ?? [])
    : allOptions.find(option => option.id === step) ?? allOptions.find(option => option.provider.id === controller.broker?.pending?.provider);
  const choice = controller.choice;
  const choicePlatform = choice?.product ?? choice?.provider;
  const choiceLabel = SOURCE_PROVIDERS.find(provider => provider.id === choicePlatform)?.label ?? (choicePlatform === 'meta' ? 'Meta' : 'account');
  const heading = useRef<HTMLHeadingElement>(null);
  const busy = Boolean(controller.busy);
  const desktop = controller.data?.runtimeEnabled === false && controller.data.unavailableReason === 'desktop';
  useEffect(() => { if (!choice) heading.current?.focus(); }, [step, choice]);
  const back = () => {
    if (controller.broker?.pending) { void controller.broker.cancel().then(done => { if (done) onBack(); }); return; }
    if (choice) controller.onCancelChoice?.(); onBack();
  };
  return <section className="source-connect-page">
    <nav className="source-connect-breadcrumb" aria-label="Breadcrumb">
      <button className="text-button" disabled={busy} onClick={back}>Sources</button><ChevronRight size={13}/>
      {selected || choice ? <button className="text-button" disabled={busy} onClick={() => {
        if (controller.broker?.pending) { void controller.broker.cancel().then(done => { if (done) onStep('data'); }); return; }
        if (choice) controller.onCancelChoice?.(); onStep('data');
      }}>Connect data</button> : <span>Connect data</span>}
    </nav>
    <header className="source-connect-title">
      <div className="source-connect-heading">
      {(selected || choice) && <PlatformIcon provider={choicePlatform ?? selected!.id} size={30}/>}
      <h1 ref={heading} tabIndex={-1}>{choice ? `Connect ${choiceLabel}` : selected ? `Connect ${selected.label}` : 'Connect data'}</h1>
      </div>
      <p>{choice ? 'Choose your accounts' : selected?.choices ? 'Choose a platform' : selected?.id === 'meta' ? 'Facebook Pages and Instagram' : selected ? 'Connect your account' : 'Choose a source'}</p>
    </header>
    {desktop && !selected && <p className="source-connect-availability" role="status">Account connections are not available in this desktop alpha. CSV and document imports stay on this computer.</p>}
    {controller.loadError && <p role="alert" className="module-alert">{controller.loadError} <button className="text-button" onClick={() => void controller.refresh()}>Retry connections</button></p>}
    {controller.actionError && <p role="alert" className="module-alert">{controller.actionError}</p>}
    {controller.broker?.pending ? <BrokerConnectionPanel key={controller.broker.pending.id} broker={controller.broker} label={selected?.label} icon={selected?.id} onDone={onBack}/> : choice ? <ConnectionChooser choice={choice} busy={busy}
      providers={controller.data?.providers} onConnect={async accounts => { if (await controller.onChoose?.(accounts)) onBack(); }} onCancel={back}/>
      : !controller.data ? !controller.loadError && <p role="status">Loading available sources...</p>
      : selected?.choices ? <div className="source-provider-list" aria-label="Meta platforms">{selected.choices.map(option =>
        <SourceProviderRow key={option.id} option={option} unavailable={!option.provider.enabled || !controller.data?.runtimeEnabled} desktop={desktop} busy={busy} onStep={onStep}/>)}</div>
      : selected ? <SourceProviderStep key={selected.id} option={selected} session={session} controller={controller}
        onDone={onBack} onBack={() => onStep('data')}/>
      : <>
        <div className="source-provider-list" aria-label="Data providers">
          {options.map(option => <SourceProviderRow key={option.id} option={option} unavailable={!option.provider.enabled || !controller.data?.runtimeEnabled} desktop={desktop} busy={busy} onStep={onStep}/>)}
        </div>
        {!options.length && <p>No account connections are available in this workspace yet.</p>}
      </>}
    {upload && allowsManualImports() && !choice && !selected && !controller.broker?.pending && <div className="source-connect-upload">{upload}</div>}
  </section>;
}

function SourceProviderStep({ option, controller, session, onDone, onBack }: {
  option: SourceConnectOption; controller: ConnectionsController; session: WorkspaceSession | null | undefined;
  onDone: () => void; onBack: () => void;
}) {
  const provider = option.provider;
  const meta = provider.signInProvider === 'meta';
  const namedLater = Boolean(provider.signInProvider) || provider.signIn === 'broker';
  const token = provider.credential === 'api_token' && provider.signIn !== 'broker';
  const [name, setName] = useState(provider.label);
  const [setup, setSetup] = useState(EMPTY_APIFY_SETUP);
  const busy = Boolean(controller.busy);
  const available = !option.deferred && provider.enabled && controller.data?.runtimeEnabled;
  const desktop = controller.data?.runtimeEnabled === false && controller.data.unavailableReason === 'desktop';
  const ready = available && (namedLater || name.trim()) && (!token || apifySetupReady(setup));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    const id = await controller.onAdd(provider.id, namedLater ? '' : name.trim(), token ? setup : undefined);
    if (id) onDone();
  }
  return <form className="source-provider-form" aria-label={`Connect ${option.label}`} onSubmit={event => void submit(event)}>
    {!available && <p role="status">{option.deferred ? 'Not available yet.' : desktop ? `${option.label} connections are not available in this desktop alpha. You can import a CSV or document from Connect data instead.` : `${option.label} isn't available in this workspace yet. Rivet's server setup must be completed before you can connect.`}</p>}
    {available && !namedLater && <div className="module-field"><label htmlFor="source-connect-name">Name</label>
      <input id="source-connect-name" value={name} maxLength={160} required disabled={busy || !available} onChange={event => setName(event.target.value)}/></div>}
    {available && token && <ApifySetupFields value={setup} busy={busy || !available} onChange={setSetup}/>}
    {available && <>{meta && option.id === 'instagram' && <p>Use the Facebook account linked to your professional Instagram account.</p>}
    <p className="source-connect-scope">{collectionScope(provider) ?? 'Rivet only reads data. Nothing is posted or changed.'}{provider.automaticDailySync ? ' · Daily updates' : ''}</p>
    <p className="source-connect-access">{accessDescription(session)}</p>
    <details className="source-connect-details"><summary>Connection details</summary>{meta ? <dl className="data-connection-review">
      <div><dt>Data</dt><dd>Up to 500 posts per account, with available likes, comments, shares and reactions.</dd></div>
      <div><dt>Sync</dt><dd>Starts after you choose your accounts.{provider.automaticDailySync ? ' Updates daily.' : ' Set a schedule later.'}</dd></div>
      <div><dt>Sign-in</dt><dd>Stored encrypted. Reconnect when Meta access expires.</dd></div>
    </dl> : <ConnectionReview provider={provider} session={session}/>}</details>
    <GoogleConnectionNotice provider={provider}/></>}
    <div className="source-connect-actions">
      {available && <button type="submit" className="button primary" disabled={!ready || busy}>{provider.signIn === 'broker' ? busy ? 'Opening...' : `Continue with ${option.label}` : provider.signIn === 'oauth' ? busy ? 'Opening sign-in...' : meta ? 'Continue with Facebook' : ['youtube', 'google-analytics'].includes(option.id) ? 'Continue with Google' : option.id === 'mailchimp' ? 'Continue with Mailchimp' : 'Continue to sign in' : busy ? 'Adding...' : 'Add connection'}</button>}
      <button type="button" className="button secondary" disabled={busy} onClick={onBack}>Back</button>
    </div>
  </form>;
}
