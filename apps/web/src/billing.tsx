import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Building2, Check, CreditCard, ExternalLink, Link2, RefreshCw, Settings, ShieldCheck } from 'lucide-react';
import type { BillingInvitation, BillingOrganization, BillingSession, BillingSummary } from '../../../packages/core/src/billing-types';
import { RivetMark } from './rivet-mark';

class BillingError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}
function billingPagePath() { return document.querySelector('meta[name="rivet-test-billing"]')?.getAttribute('content') === 'hosted' ? '/billing-test' : '/onboarding'; }

async function billingRequest<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(abort, 15000);
  try {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const response = await fetch(`/api/${billingPagePath() === '/billing-test' ? 'billing-test' : 'billing'}${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      const code = failure?.error?.code;
      throw new BillingError(response.status,
      code === 'invitation_account_mismatch' ? 'This invitation is for a different account. Sign in with the invited account, then retry.' :
        code === 'invitation_unavailable' ? 'This invitation is invalid, expired, or revoked. Ask your administrator for a new invitation link.' :
          code === 'invitation_claimed' ? 'This invitation has already been used by another account. Ask your administrator for a new invitation link.' :
      code === 'checkout_expired' ? 'Billing checkout expired. Try again to open a new test checkout.' :
        code === 'join_pending' ? 'Your invitation needs organization approval. Ask an organization owner to approve it, then try again.' :
          response.status === 400 ? 'Check the organization name or invitation link and try again.' :
      response.status === 401 ? 'Your session has expired. Sign in again to continue.' :
        response.status === 403 ? 'You no longer have permission for this billing action. Reload your organizations.' :
          response.status === 409 ? 'This request could not be completed. Reload billing before trying again.' :
            'Billing could not be loaded or updated. Please try again.', code);
    }
    const result = await response.json() as T;
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return result;
  } catch (error) {
    if (!signal.aborted && controller.signal.aborted) throw new Error('Billing took too long to respond. Please try again.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

function stored<T>(key: string): T | null {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as T | null; } catch { return null; }
}
function store(key: string, value: unknown) {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Requests still retain their identity during this visit. */ }
}
function actorKey(session: BillingSession) { return `rivet.billing.test:${session.actor.key}`; }
function owner(summary: BillingSummary) { return summary.organization.role === 'owner' && summary.canManage; }
function roleName(role: BillingOrganization['role']) { return { owner: 'Administrator', operator: 'Member', reviewer: 'Viewer' }[role]; }
function organizationPath(id: string) { return `/organizations/${encodeURIComponent(id)}`; }

// Provider URLs are untrusted even when returned by our own server.
function redirectUrl(value: string, provider: BillingSession['provider'], kind: 'checkout' | 'portal') {
  const url = new URL(value, window.location.origin);
  if (url.username || url.password) throw new Error('Billing returned an unsafe payment link. Please refresh and try again.');
  const stripeHost = kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
  const stripe = provider === 'stripe' && url.protocol === 'https:' && url.hostname === stripeHost && (!url.port || url.port === '443');
  const fixture = provider === 'fixture' && !url.hash && url.origin === window.location.origin &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol) &&
    url.pathname.startsWith(`/api/billing/fixture/${kind}/`);
  if (!stripe && !fixture) throw new Error('Billing returned an unsafe payment link. Please refresh and try again.');
  return url.href;
}

function checkoutReturn() {
  const query = new URLSearchParams(window.location.search);
  return { organizationId: query.get('organizationId') ?? query.get('organization') ?? query.get('org'),
    sessionId: query.get('session_id'), canceled: query.get('billing') === 'abandoned' || ['canceled', 'cancelled'].includes(query.get('checkout') ?? ''),
    returned: query.get('billing') === 'return' || query.get('checkout') === 'success' || query.has('session_id') };
}

type CreateAttempt = { name: string; requestId: string };
function useBilling(organizationId?: string, invitationLinks = false) {
  const [session, setSession] = useState<BillingSession | null>(null);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('Loading billing');
  const [stage, setStage] = useState<'organization' | 'source' | 'review'>('organization');
  const [name, setName] = useState('');
  const [createAttempt, setCreateAttempt] = useState<CreateAttempt | null>(null);
  const [returnPending, setReturnPending] = useState(false);
  const [invitation, setInvitation] = useState<BillingInvitation | null>(null);
  const [invitationFlow, setInvitationFlow] = useState(() => invitationLinks && typeof window !== 'undefined' && Boolean(window.location.hash));
  const invitationToken = useRef<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const checkoutIds = useRef(new Map<string, string>());
  const returned = useRef<ReturnType<typeof checkoutReturn> | null>(null);

  const execute = async (label: string, action: (signal: AbortSignal) => Promise<void>) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller; setBusy(label); setError('');
    try { await action(controller.signal); }
    catch (reason) { if (!controller.signal.aborted) {
      if (reason instanceof BillingError && [401, 403].includes(reason.status)) setSummary(null);
      if (reason instanceof BillingError && ['invitation_account_mismatch', 'invitation_unavailable', 'invitation_claimed'].includes(reason.code ?? '')) setInvitation(null);
      setError(reason instanceof BillingError || reason instanceof Error && reason.message.startsWith('Billing')
        ? reason.message : 'Billing could not be reached. Your setup is preserved. Please try again.');
    } }
    finally { if (active.current === controller) { active.current = null; setBusy(''); } }
  };

  const accept = (next: BillingSummary, currentSession: BillingSession, expectedId?: string, resetStage = true) => {
    if (expectedId && next.organization.id !== expectedId) throw new Error('Billing returned a different organization. Reload before continuing.');
    if (next.provider !== currentSession.provider || next.offer.testOnly !== true) throw new Error('Billing test configuration is unavailable.');
    setSummary(next);
    setReturnPending(Boolean(!next.covered && ['unpaid', 'pending'].includes(next.state) && returned.current?.returned && !returned.current.canceled &&
      returned.current.organizationId === next.organization.id));
    setSession({ ...currentSession, selectedOrganizationId: next.organization.id,
      organizations: [...currentSession.organizations.filter(org => org.id !== next.organization.id), next.organization] });
    store(`${actorKey(currentSession)}:organization`, next.organization.id);
    if (next.covered) {
      const key = `${actorKey(currentSession)}:checkout:${next.organization.id}`;
      checkoutIds.current.delete(key); store(key, null);
    }
    if (resetStage) setStage(['pending', 'past_due', 'canceled'].includes(next.state) ? 'review' : 'source');
  };

  const load = () => execute(invitationLinks && window.location.hash ? 'Checking invitation' : 'Loading billing', async signal => {
    setSummary(null); setSession(null); setUnavailable(false); setReturnPending(false);
    setInvitation(null); invitationToken.current = null;
    const hash = invitationLinks ? window.location.hash : '';
    setInvitationFlow(Boolean(hash));
    let next: BillingSession;
    try { next = await billingRequest<BillingSession>('/session', signal); }
    catch (reason) { if (reason instanceof BillingError && reason.status === 404) { setUnavailable(true); return; } throw reason; }
    if (next.mode !== 'test' || !['stripe', 'fixture'].includes(next.provider) || next.offer.testOnly !== true || !/^[a-zA-Z0-9_-]{1,128}$/.test(next.actor.key)) throw new Error('Billing test configuration is unavailable.');
    setSession(next);
    const attempt = stored<CreateAttempt>(`${actorKey(next)}:create`);
    const validAttempt = attempt && typeof attempt.name === 'string' && typeof attempt.requestId === 'string' ? attempt : null;
    setCreateAttempt(validAttempt); setName(validAttempt?.name ?? '');
    if (hash) {
      const match = /^#invite=([A-Za-z0-9_-]{43})$/.exec(hash);
      if (!match) throw new BillingError(400, 'This invitation link is invalid. Open the full link from your administrator.');
      invitationToken.current = match[1];
      setInvitation(await billingRequest<BillingInvitation>('/invitation', signal, {token: match[1]}));
      return;
    }
    returned.current ??= checkoutReturn();
    const preferred = organizationId ?? returned.current.organizationId ?? stored<string>(`${actorKey(next)}:organization`) ?? next.selectedOrganizationId;
    const selected = next.organizations.find(org => org.id === preferred) ?? (!organizationId && !returned.current.organizationId ? next.organizations[0] : undefined);
    setStage('source');
    if (!selected) {
      if (organizationId || returned.current.organizationId) throw new Error('Billing organization access is unavailable. Select an organization you belong to.');
      setStage('organization');
      return;
    }
    if (returned.current.returned || returned.current.canceled) returned.current.organizationId ??= selected.id;
    const record = await billingRequest<BillingSummary>(organizationPath(selected.id), signal);
    accept(record, next, selected.id);
    const isReturn = !returned.current.organizationId || returned.current.organizationId === selected.id;
    if (isReturn && returned.current.canceled) setStage('review');
    if (isReturn && returned.current.returned && !returned.current.canceled && !record.covered) {
      if (returned.current.sessionId && owner(record)) {
        const confirmed = await billingRequest<BillingSummary>(`${organizationPath(selected.id)}/confirm`, signal, { sessionId: returned.current.sessionId });
        accept(confirmed, next, selected.id);
      }
    }
  });

  useEffect(() => {
    void load();
    const changed = () => { active.current?.abort(); active.current = null; void load(); };
    if (invitationLinks) window.addEventListener('hashchange', changed);
    return () => { active.current?.abort(); active.current = null; window.removeEventListener('hashchange', changed); };
  }, [organizationId, invitationLinks]);

  const select = (id: string) => execute('Loading organization', async signal => {
    if (!session || !session.organizations.some(org => org.id === id)) return;
    setSummary(null); setReturnPending(false); setStage('source');
    accept(await billingRequest<BillingSummary>(organizationPath(id), signal), session, id);
  });
  const create = (event: FormEvent) => {
    event.preventDefault();
    void execute('Creating organization', async signal => {
      if (!session || !name.trim()) return;
      const attempt = createAttempt ?? { name: name.trim(), requestId: crypto.randomUUID() };
      setCreateAttempt(attempt); store(`${actorKey(session)}:create`, attempt);
      let next: BillingSummary;
      try { next = await billingRequest<BillingSummary>('/organizations', signal, attempt); }
      catch (reason) {
        if (reason instanceof BillingError && reason.status === 400) {
          store(`${actorKey(session)}:create`, null); setCreateAttempt(null);
        }
        throw reason;
      }
      accept(next, session);
      store(`${actorKey(session)}:create`, null); setCreateAttempt(null); setName('');
    });
  };
  const join = () => execute('Accepting invitation', async signal => {
    if (!session || !invitation || !invitationToken.current) return;
    if (window.location.hash !== `#invite=${invitationToken.current}`) throw new BillingError(400, 'This invitation link has changed. Review the current link before accepting.');
    accept(await billingRequest<BillingSummary>('/join', signal, {token: invitationToken.current}), session, invitation.organizationId);
    setStage('review'); setInvitation(null); setInvitationFlow(false); invitationToken.current = null;
    history.replaceState(history.state, '', window.location.pathname + window.location.search);
  });
  const refresh = () => execute('Checking billing status', async signal => {
    if (!session || !summary) return;
    const id = summary.organization.id;
    const confirming = returnPending && returned.current?.sessionId && owner(summary);
    const next = await billingRequest<BillingSummary>(`${organizationPath(id)}${owner(summary) ? confirming ? '/confirm' : '/refresh' : ''}`,
      signal, owner(summary) ? confirming ? { sessionId: returned.current!.sessionId } : {} : undefined);
    accept(next, session, id, false);
  });
  const redirect = (kind: 'checkout' | 'portal') => execute(kind === 'checkout' ? 'Opening checkout' : 'Opening billing portal', async signal => {
    if (!session || !summary || !owner(summary) || kind === 'checkout' &&
      (summary.covered || summary.state === 'past_due' || summary.state === 'active' || returnPending)) return;
    const key = `${actorKey(session)}:checkout:${summary.organization.id}`;
    let requestId = checkoutIds.current.get(key) ?? stored<string>(key);
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) requestId = crypto.randomUUID();
    checkoutIds.current.set(key, requestId); store(key, requestId);
    let result: { url: string };
    try { result = await billingRequest<{ url: string }>(`${organizationPath(summary.organization.id)}/${kind}`, signal, kind === 'checkout' ? { requestId } : {}); }
    catch (reason) {
      if (kind === 'checkout' && reason instanceof BillingError && reason.code === 'checkout_expired') {
        checkoutIds.current.delete(key); store(key, null);
      }
      throw reason;
    }
    window.location.assign(redirectUrl(result.url, summary.provider, kind));
  });
  return { session, summary, unavailable, error, busy, stage, setStage, name, setName, createAttempt, invitation, invitationFlow,
    returnPending, canceled: Boolean(returned.current?.canceled && summary && !summary.covered && (!returned.current.organizationId || returned.current.organizationId === summary.organization.id)),
    load, select, create, join, refresh, redirect };
}

function TestMode({ provider }: { provider?: BillingSession['provider'] }) {
  return <span className="billing-test-label">Test mode{provider ? provider === 'fixture' ? ' / Local fixture' : ' / Stripe test' : ''}</span>;
}
function PrivacyNote() {
  return <p className="billing-privacy"><ShieldCheck size={16} aria-hidden="true"/><span>Billing coverage does not share your private conversations, tasks, or source data with your organization.</span></p>;
}
function SourceState({ summary }: { summary: BillingSummary }) {
  const { source } = summary;
  return <div className="billing-source"><Link2 size={20} aria-hidden="true"/><div><strong>{source.name || 'Workspace source'}</strong>
    <p>{source.state === 'ready' ? source.fictional ? 'Ready / Fictional local QA source' : 'Ready' : 'Not connected'}</p>
    {source.state !== 'ready' && <p>You can connect a source later in Sources.</p>}
  </div></div>;
}
function Offer({ offer }: { offer: BillingSession['offer'] }) {
  let price = 'Price unavailable';
  try { if (Number.isFinite(offer.amount) && offer.amount >= 0) price = new Intl.NumberFormat(undefined, { style: 'currency', currency: offer.currency }).format(offer.amount / 100); } catch { /* An invalid server price must not become an invented offer. */ }
  return <div className="billing-offer"><div><strong>{offer.name}</strong><span>{price}<small> / month</small></span></div>
    <p>Test-only placeholder price supplied by the server. This is not the final commercial offer.</p></div>;
}
function dateLabel(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not available';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function Coverage({ summary, returnPending }: { summary: BillingSummary; returnPending: boolean }) {
  const labels = { unpaid: 'Not subscribed', pending: 'Checkout pending', active: 'Active', past_due: 'Payment needs attention', canceled: 'Canceled' };
  return <dl className="billing-facts">
    <div><dt>Status</dt><dd>{returnPending && !summary.covered ? 'Confirmation pending' : labels[summary.state]}</dd></div>
    <div><dt>Coverage</dt><dd>{summary.covered ? 'Covered by organization' : 'Not covered'}</dd></div>
    <div><dt>Renewal</dt><dd>{summary.cancelAtPeriodEnd ? 'Cancels at period end' : summary.state === 'active' ? 'Renews automatically' : 'Not scheduled'}</dd></div>
    <div><dt>Current period ends</dt><dd>{dateLabel(summary.periodEnd)}</dd></div>
  </dl>;
}

function OrganizationForm({ model, initial = false }: { model: ReturnType<typeof useBilling>; initial?: boolean }) {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const id = useId();
  return <section className="billing-organization-form" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`} className={initial ? 'billing-sr-only' : undefined}>Create or join an organization</h2>
    <fieldset className="billing-mode" disabled={Boolean(model.busy)}><legend className="billing-sr-only">Organization setup</legend>
      <label><input type="radio" name={`${id}-mode`} checked={mode === 'create'} onChange={() => setMode('create')}/>Create</label>
      {!model.session?.hosted && <label><input type="radio" name={`${id}-mode`} checked={mode === 'join'} onChange={() => setMode('join')}/>Join with invitation</label>}
    </fieldset>
    {mode === 'create' ? <form onSubmit={model.create}>
      <div className="billing-field"><label htmlFor={`${id}-name`}>Organization name</label>
      <input id={`${id}-name`} required maxLength={120} autoComplete="organization" value={model.name} readOnly={Boolean(model.createAttempt)} disabled={Boolean(model.busy)}
        aria-describedby={model.createAttempt ? `${id}-retry` : undefined} onChange={event => model.setName(event.target.value)}/></div>
      {model.createAttempt && <p id={`${id}-retry`}>Creation is not confirmed. Retry uses the same name and request to avoid duplicates.</p>}
      <button className="billing-button billing-primary" disabled={Boolean(model.busy) || !model.name.trim()} type="submit">{model.createAttempt ? 'Retry creation' : 'Create organization'}<ArrowRight size={16} aria-hidden="true"/></button>
    </form> : <p className="billing-join-note">Open the invitation link from your administrator. You can review the organization and invited account before accepting.</p>}
  </section>;
}

function OrganizationPicker({ model }: { model: ReturnType<typeof useBilling> }) {
  const id = useId();
  if (!model.session?.organizations.length) return null;
  return <div className="billing-picker"><label htmlFor={id}>Organization</label>
    <select id={id} value={model.summary?.organization.id ?? ''} disabled={Boolean(model.busy)} onChange={event => void model.select(event.target.value)}>
      {!model.summary && <option value="" disabled>Select an organization</option>}
      {model.session.organizations.map((org: BillingOrganization) => <option value={org.id} key={org.id}>{org.name} / {roleName(org.role)}</option>)}
    </select></div>;
}

function BillingContent({ onboarding, organizationId, embedded = false }: { onboarding: boolean; organizationId?: string; embedded?: boolean }) {
  const model = useBilling(organizationId, onboarding);
  const { summary, session, busy } = model;
  const heading = useRef<HTMLHeadingElement>(null);
  const Heading = embedded ? 'h2' : 'h1';
  const focusStep = useRef('organization:');
  useEffect(() => {
    const next = `${model.stage}:${summary?.organization.id ?? ''}`;
    if (!busy && focusStep.current !== next) { focusStep.current = next; heading.current?.focus(); }
  }, [busy, model.stage, summary?.organization.id]);
  const canManage = summary && owner(summary);
  const waiting = summary && !summary.covered && model.returnPending;
  const checkoutPending = summary && !summary.covered && summary.state === 'pending';
  const canCheckout = canManage && !summary.covered && !model.returnPending && ['unpaid', 'canceled', 'pending'].includes(summary.state);
  const resumeCheckout = summary?.state === 'pending';
  const review = !onboarding || model.stage === 'review' || summary?.covered || waiting;
  const ready = summary?.covered;
  const showCoverage = !onboarding || ready || waiting || checkoutPending || summary?.state === 'past_due' || summary?.state === 'canceled';
  const initialReview = onboarding && !showCoverage;
  const offerReview = summary && canCheckout && <><Offer offer={summary.offer}/>
    <p className="billing-review-terms">Renews monthly in test mode. The owner can cancel through Billing; coverage continues until the paid period ends.</p>
    <p className="billing-muted">{summary.provider === 'fixture' ? 'Continue to the local checkout fixture.' : 'Continue to Stripe Checkout in test mode. No live payment is being requested.'}</p></>;
  return <div className="billing-content">
    {!embedded && <a className="billing-brand billing-content-brand" href="/workspaces"><RivetMark size={28}/><span>Rivet</span></a>}
    <header className="billing-heading"><div><Heading ref={heading} tabIndex={-1}>{model.invitationFlow ? 'Organization invitation' : onboarding ? ready ? 'Your organization is covered' : 'Set up your workspace' : 'Billing'}</Heading>
      <p>{model.invitationFlow ? 'Review your invitation before joining' : onboarding ? 'Organization setup and test billing' : 'Organization coverage and subscription'}</p></div>{session && <TestMode provider={session.provider}/>}</header>
    {model.unavailable ? <section className="billing-empty"><h2>Billing unavailable</h2><p>Billing onboarding is not enabled in this environment. Your existing sign-in and private workspace are unchanged.</p>
      <button className="billing-button" onClick={() => void model.load()}><RefreshCw size={16} aria-hidden="true"/>Try again</button></section> : <>
      {model.error && <div className="billing-notice billing-error" role="alert"><p>{model.error}</p>
        {!summary && <button className="billing-button" disabled={Boolean(busy)} onClick={() => void model.load()}><RefreshCw size={16} aria-hidden="true"/>{model.invitationFlow ? 'Retry invitation' : 'Retry billing'}</button>}</div>}
      {busy && <p className="billing-progress" role="status">{busy}...</p>}
      {session && <>
        {model.invitationFlow ? <section className="billing-invitation" aria-label="Invitation review">{model.invitation && <>
          <h2>{model.invitation.organization}</h2><dl className="billing-facts">
            <div><dt>Invited account</dt><dd>{model.invitation.email}</dd></div>
            <div><dt>Role</dt><dd>{roleName(model.invitation.role)}</dd></div>
            <div><dt>Invitation expires</dt><dd>{dateLabel(model.invitation.expiresAt)}</dd></div>
          </dl>{model.invitation.state === 'accepted' && <p>You already accepted this invitation with this account.</p>}
          <p>Accepting joins this organization. Your private conversations, task history, and private source data stay private.</p>
          <div className="billing-actions"><button className="billing-button billing-primary" disabled={Boolean(busy)} onClick={() => void model.join()}>Accept invitation<ArrowRight size={16} aria-hidden="true"/></button></div>
        </>}</section> : <>
        {onboarding && <ol className="billing-steps" aria-label="Onboarding progress">{['Organization', 'Source', 'Review', 'Ready'].map((step, index) => {
          const current = !summary ? 0 : ready ? 3 : review ? 2 : 1;
          return <li key={step} data-complete={index < current || undefined} aria-current={index === current ? 'step' : undefined}><span>{index < current ? <Check size={13} aria-hidden="true"/> : index + 1}</span>{step}</li>;
        })}</ol>}
        <OrganizationPicker model={model}/>
        {!summary ? model.stage === 'organization' && (!busy || ['Creating organization', 'Joining organization'].includes(busy)) && <OrganizationForm model={model} initial/> : <>
          <div className="billing-org-heading"><Building2 size={20} aria-hidden="true"/><h2>{summary.organization.name}</h2><span>{roleName(summary.organization.role)}</span></div>
          {model.canceled && <p className="billing-notice" role="status">Checkout canceled. Your organization and source setup are preserved. You can retry when you are ready.</p>}
          {summary.provider === 'fixture' && <p className="billing-fixture">Local test fixture. No real Stripe payment or subscription is created.</p>}
          {onboarding && !review ? <section className="billing-section"><h2>Workspace source</h2><SourceState summary={summary}/>
            <div className="billing-actions"><button className="billing-button billing-primary" disabled={Boolean(busy)} onClick={() => model.setStage('review')}>{summary.source.state === 'ready' ? 'Continue to review' : 'Set up source later'}<ArrowRight size={16} aria-hidden="true"/></button></div>
          </section> : <section className="billing-section" aria-label="Billing details">
            {initialReview && <><h2>Review subscription</h2>{offerReview}</>}
            {showCoverage && <Coverage summary={summary} returnPending={model.returnPending}/>}
            {ready ? <p className="billing-covered"><Check size={18} aria-hidden="true"/>{canManage ? 'Your organization has billing coverage.' : 'You are covered by your organization. You do not need to pay again.'}</p> : waiting ? <div className="billing-notice"><h2>Waiting for confirmation</h2>
              <p>Payment has not been confirmed by the server. Check the status again to continue. Returning from checkout does not activate coverage.</p></div> : checkoutPending && canManage ? <div className="billing-notice"><h2>Continue your checkout</h2>
              <p>Your organization is saved, but billing coverage is not confirmed. Resume the same test checkout, or refresh the status if you already paid.</p></div> : !canManage ? <p className="billing-notice">Your organization is not covered yet. Ask an organization owner to manage billing. Members cannot start another subscription.</p> : null}
            {!initialReview && offerReview}
            {canManage && !ready && !waiting && !canCheckout && <p className="billing-notice">This subscription needs attention. Manage billing or refresh its status before continuing.</p>}
            <div className="billing-actions">
              {canCheckout && <button className="billing-button billing-primary" disabled={Boolean(busy) || !Number.isFinite(summary.offer.amount) || summary.offer.amount < 0} onClick={() => void model.redirect('checkout')}><CreditCard size={16} aria-hidden="true"/>{resumeCheckout ? 'Resume test checkout' : summary.provider === 'fixture' ? 'Open test checkout fixture' : 'Continue to Stripe test checkout'}<ExternalLink size={14} aria-hidden="true"/></button>}
              {canManage && summary.state !== 'unpaid' && <button className="billing-button" disabled={Boolean(busy)} onClick={() => void model.redirect('portal')}>Manage {summary.provider === 'fixture' ? 'fixture billing' : 'billing'}<ExternalLink size={14} aria-hidden="true"/></button>}
              <button className="billing-button billing-icon" title={canManage ? 'Refresh billing status' : 'Reload organization coverage'} aria-label={canManage ? 'Refresh billing status' : 'Reload organization coverage'} disabled={Boolean(busy)} onClick={() => void model.refresh()}><RefreshCw size={17} aria-hidden="true"/></button>
              {onboarding && !ready && !waiting && <button className="billing-button billing-quiet" disabled={Boolean(busy)} onClick={() => model.setStage('source')}><ArrowLeft size={16} aria-hidden="true"/>Source</button>}
            </div>
            {summary.checkedAt && <p className="billing-muted">Last checked {dateLabel(summary.checkedAt)}</p>}
            <SourceState summary={summary}/>
            {onboarding && ready && <div className="billing-actions"><a className="billing-button billing-primary" href={`/w/${encodeURIComponent(summary.organization.id)}/`}>Continue to workspace<ArrowRight size={16} aria-hidden="true"/></a>
              {summary.source.state !== 'ready' && <span className="billing-muted">Your source can be connected later.</span>}</div>}
          </section>}
          <div className="billing-more"><button className="billing-button billing-quiet" disabled={Boolean(busy)} onClick={() => model.setStage(model.stage === 'organization' ? 'source' : 'organization')}>Create or join another organization</button>
            {model.stage === 'organization' && <OrganizationForm model={model}/>}</div>
        </>}
        </>}
        <PrivacyNote/>
      </>}
    </>}
  </div>;
}

export function BillingOnboardingApp() {
  const billingView = new URLSearchParams(window.location.search).get('view') === 'billing';
  const page = billingPagePath();
  return <main className="billing-app"><div className="billing-surface"><header className="billing-shell-header">
    <nav aria-label="Onboarding navigation"><TestMode/>{billingView ? <a className="billing-button billing-icon" href={page} aria-label="Back to onboarding" title="Back to onboarding"><ArrowLeft size={18} aria-hidden="true"/></a> :
      <a className="billing-button billing-icon" href={`${page}?view=billing`} aria-label="Billing settings" title="Billing settings"><Settings size={18} aria-hidden="true"/></a>}</nav></header>
    <div className="billing-workarea"><BillingContent onboarding={!billingView}/></div></div>
  </main>;
}

export function BillingSettings({ organizationId, embedded = false }: { organizationId?: string; embedded?: boolean }) {
  return <section className={`billing-settings${embedded ? ' billing-embedded' : ''}`} aria-label="Organization billing"><BillingContent onboarding={false} organizationId={organizationId} embedded={embedded}/></section>;
}
