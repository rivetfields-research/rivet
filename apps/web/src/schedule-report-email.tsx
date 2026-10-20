import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RefreshCw, Send } from 'lucide-react';
import { ApiError, api, message } from './api';
import { workspaceBrowserStorage } from './workspace-scope';

export interface ScheduleReportEmailStatus {
  configured: boolean;
  enabled: boolean;
  recipient: string | null;
  version: number;
  localOnly: boolean;
  deliveries: {
    runId: string;
    status: 'pending' | 'sending' | 'retry' | 'submitted' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed' | 'suppressed' | 'captured' | 'cancelled' | 'needs_attention';
    idempotencyKey?: string;
    template?: 'intro' | 'weekly';
    isTest?: boolean;
    localOnly: boolean | null;
    attempts: number;
    createdAt: string;
    updatedAt: string;
    error: string | null;
  }[];
  retainedJobs: number;
  jobLimit: number;
  limitReached: boolean;
}

const deliveryLabels: Record<ScheduleReportEmailStatus['deliveries'][number]['status'], string> = {
  pending: 'Pending', sending: 'Sending', retry: 'Waiting to retry', submitted: 'Submitted to email service',
  delivered: 'Delivered', captured: 'Captured locally', cancelled: 'Cancelled', needs_attention: 'Needs attention',
  delayed: 'Delivery delayed', bounced: 'Bounced', complained: 'Unsubscribed after complaint', failed: 'Delivery failed', suppressed: 'Sending stopped',
};

type EmailProps = { scheduleId: string | null; disabled?: boolean; compact?: boolean; onStatus?: (value: ScheduleReportEmailStatus | null) => void };
export function ScheduleReportEmail({ scheduleId, disabled = false, compact = false, onStatus }: EmailProps) {
  const heading = useId();
  useEffect(() => { if (!scheduleId) onStatus?.(null); }, [scheduleId, onStatus]);
  return <section className="schedule-report-email" aria-labelledby={heading}>
    <h2 id={heading} className={compact ? 'sr-only' : undefined}>Review email</h2>
    {scheduleId ? <SavedScheduleReportEmail key={scheduleId} scheduleId={scheduleId} disabled={disabled} onStatus={onStatus}/>
      : <p>Save this schedule first to enable email.</p>}
  </section>;
}

function SavedScheduleReportEmail({ scheduleId, disabled, onStatus }: { scheduleId: string; disabled: boolean; onStatus?: EmailProps['onStatus'] }) {
  const storageKey = `rivetfields.review-email-test.${scheduleId}`;
  const [initialTest] = useState(() => {
    try {
      const raw = workspaceBrowserStorage('sessionStorage').getItem(storageKey);
      const value = raw ? JSON.parse(raw) : null;
      if (raw !== null && (!value || typeof value !== 'object' || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(value.requestId) || typeof value.forceIntro !== 'boolean')) throw Error();
      return { value: value as {requestId: string; forceIntro: boolean} | null, unreadable: false };
    } catch { return {value: null, unreadable: true}; }
  });
  const [status, setStatus] = useState<ScheduleReportEmailStatus | null>(null);
  useEffect(() => { onStatus?.(status); }, [status, onStatus]);
  useEffect(() => () => onStatus?.(null), [onStatus]);
  const [busy, setBusy] = useState<'loading' | 'saving' | 'testing' | null>('loading');
  const [forceIntro, setForceIntro] = useState(initialTest.value?.forceIntro ?? false);
  const testRequest = useRef<{requestId: string; forceIntro: boolean} | null>(initialTest.value);
  const [error, setError] = useState('');
  const [reloadRequired, setReloadRequired] = useState(false);
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const description = useId();
  const path = `/api/schedules/${encodeURIComponent(scheduleId)}/email`;
  const reload = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy('loading'); setStatus(null); setError(''); setNotice(''); setReloadRequired(false);
    try {
      const fresh = await api<ScheduleReportEmailStatus>(path, { signal: controller.signal, cache: 'no-store' });
      if (!controller.signal.aborted) setStatus(fresh);
    } catch (error) {
      if (!controller.signal.aborted) setError(`Email settings could not be loaded. ${message(error)}`);
    } finally { if (!controller.signal.aborted) setBusy(null); }
  }, [path]);
  useEffect(() => { void reload(); return () => request.current?.abort(); }, [reload]);

  async function save(enabled: boolean) {
    if (!status || busy || disabled || reloadRequired || (!status.enabled && (!status.configured || status.limitReached))) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy('saving'); setError(''); setNotice('');
    try {
      const saved = await api<ScheduleReportEmailStatus>(path, { method: 'PUT', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        body: JSON.stringify({ version: status.version, enabled }) });
      if (controller.signal.aborted) return;
      setStatus(saved);
      setNotice(saved.enabled ? saved.localOnly ? 'Local capture enabled. No external email will be sent.' : 'Review email enabled.' : 'Review email turned off.');
    } catch (error) {
      if (controller.signal.aborted) return;
      setReloadRequired(true);
      setError(error instanceof ApiError && error.status === 409 && (!error.code || error.code === 'report_email_version_conflict')
        ? 'Email settings changed elsewhere. Reload email settings before trying again.'
        : `Email change not confirmed. ${message(error)} Reload email settings to check before trying again.`);
    } finally { if (!controller.signal.aborted) setBusy(null); }
  }

  async function sendTest() {
    if (!status?.configured || busy || disabled || initialTest.unreadable) return;
    const controller = new AbortController(); request.current = controller;
    testRequest.current ??= {requestId: crypto.randomUUID(), forceIntro};
    setBusy('testing'); setError(''); setNotice('');
    try {
      workspaceBrowserStorage('sessionStorage').setItem(storageKey, JSON.stringify(testRequest.current));
      const saved = await api<ScheduleReportEmailStatus>(`${path}/test`, {method: 'POST',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), body: JSON.stringify(testRequest.current)});
      if (controller.signal.aborted) return;
      setStatus(saved);
      workspaceBrowserStorage('sessionStorage').removeItem(storageKey);
      testRequest.current = null;
      setNotice(saved.localOnly ? 'Test captured locally. No email sent.' : 'Test recorded. Check its delivery status below.');
    } catch (error) {
      if (!controller.signal.aborted) setError(`Test not confirmed. ${message(error)} Retrying uses the same request.`);
    } finally { if (!controller.signal.aborted) setBusy(null); }
  }

  return <>
    <div className="schedule-report-email-control">
      <label className="module-check-field"><input type="checkbox" checked={status?.enabled ?? false}
        disabled={disabled || Boolean(busy) || !status || reloadRequired || (!status.enabled && (!status.configured || status.limitReached))}
        aria-describedby={description} onChange={event => void save(event.target.checked)}/><span>Email me this review</span></label>
      <button type="button" className="icon-button" aria-label="Reload email settings" title="Reload email settings"
        disabled={disabled || Boolean(busy)} onClick={() => void reload()}><RefreshCw size={14} aria-hidden="true"/></button>
    </div>
    <div id={description}>
      <p role="status" aria-live="polite">{busy === 'loading' ? 'Loading email settings...' : busy === 'saving' ? 'Saving email setting...' : busy === 'testing' ? 'Preparing test email...'
        : reloadRequired ? `Last confirmed: ${status?.enabled ? 'On' : 'Off'}. Reload to check the current setting.`
        : status ? status.enabled ? 'On for future completed reviews.' : 'Off.' : 'Email status unavailable.'}</p>
      {status && <>
        <p>{status.recipient ? <>To: <span>{status.recipient}</span> (verified owner inbox).</> : 'Recipient: your verified owner inbox, selected by the server.'}</p>
        <p>{status.localOnly ? 'Local capture only. No external email is sent.' : 'External email mode. Delivery is confirmed only when reported by the email service.'}</p>
        {!status.configured && <p>Email is unavailable in this workspace.{status.enabled && ' You can still turn it off.'}</p>}
        {status.limitReached && <p>Email history is full ({status.retainedJobs} of {status.jobLimit} retained jobs). An operator must review it before new email can be enabled.{status.enabled && ' You can still turn it off.'}</p>}
      </>}
    </div>
    {error && <p role="alert" className="schedule-report-email-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {initialTest.unreadable && <p role="alert">The previous test request could not be read. Check delivery history before repairing this browser's saved request.</p>}
    {status?.configured && <div className="schedule-report-email-control">
      <button type="button" className="button" disabled={disabled || Boolean(busy) || initialTest.unreadable} onClick={() => void sendTest()}><Send size={14} aria-hidden="true"/>{testRequest.current ? 'Retry same test' : 'Send a test now'}</button>
      <label className="module-check-field"><input type="checkbox" checked={forceIntro} disabled={disabled || Boolean(busy) || Boolean(testRequest.current)} onChange={event => setForceIntro(event.target.checked)}/><span>Include introduction</span></label>
    </div>}
    {status && <details className="schedule-report-email-history"><summary>Recent email activity ({status.deliveries.length})</summary>
      {status.deliveries.length ? <ul>{status.deliveries.map(delivery => {
        const local = delivery.localOnly === true || delivery.status === 'captured';
        return <li key={delivery.idempotencyKey ?? `${delivery.runId}-${delivery.createdAt}`}>
          <strong>{local && ['submitted', 'delivered'].includes(delivery.status) ? 'Recorded locally' : deliveryLabels[delivery.status]}</strong>
          {local ? <span>No email sent.</span> : delivery.status === 'submitted' && <span>Delivery not confirmed.</span>}
          {delivery.template && <span>{delivery.isTest ? 'Test' : 'Scheduled'} / {delivery.template === 'intro' ? 'Introduction' : 'Weekly review'}</span>}
          <small><time dateTime={delivery.updatedAt}>{new Date(delivery.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time> / {delivery.attempts} {delivery.attempts === 1 ? 'attempt' : 'attempts'}</small>
          {delivery.error && <span>{delivery.error}</span>}
        </li>;
      })}</ul> : <p>No email activity recorded.</p>}
    </details>}
  </>;
}
