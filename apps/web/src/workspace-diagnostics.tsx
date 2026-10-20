import { useEffect, useId, useState } from 'react';
import { Download, Gauge } from 'lucide-react';
import type { RunSummary, WorkspaceStatus } from '../../../packages/core/src/types';
import type { AllowanceCounter, WorkspaceDiagnostics } from '../../../packages/core/src/workspace-diagnostics';
import { api } from './api';
import { allowanceCapacity, allowanceReset } from './workspace-diagnostics-presentation';

type Props = {
  workspace: WorkspaceStatus;
  runs: RunSummary[];
};

const number = (value: number) => value.toLocaleString('en-US');

function Counter({ label, description, unit, value }: { label: string; description: string; unit: string; value: AllowanceCounter }) {
  const uid = useId(), capacity = allowanceCapacity(value);
  return <div className="workspace-allowance-counter" data-exhausted={capacity.status === 'available' && capacity.exhausted || undefined}>
    <div><span>{label}</span><strong>{capacity.status === 'available' ? `${number(capacity.remaining)} remaining` : 'Capacity unavailable'}</strong></div>
    <p id={`${uid}-description`} className="workspace-allowance-description">{description}</p>
    {capacity.status === 'available' && <>
      <meter aria-label={`${label} remaining`} aria-describedby={`${uid}-description ${uid}-reservation`}
        aria-valuetext={`${number(capacity.remaining)} of ${number(value.limit)} ${unit} remaining${capacity.exhausted ? '; no capacity remains in this allowance' : ''}`}
        {...capacity.gauge} />
      <small id={`${uid}-reservation`}>{number(value.used)} of {number(value.limit)} {unit} reserved</small>
    </>}
  </div>;
}

/** Deliberately excludes task text, errors, identities, sources and provider messages. */
export function diagnosticExport(diagnostics: WorkspaceDiagnostics, workspace: WorkspaceStatus, runs: RunSummary[]) {
  const snapshot = diagnostics.allowance.status === 'available' ? diagnostics.allowance.snapshot : null;
  const counter = (value: AllowanceCounter) => ({ used: value.used, limit: value.limit });
  const members = diagnostics.access.members;
  return {
    version: 1, checkedAt: diagnostics.checkedAt,
    mode: workspace.mode,
    service: { configured: workspace.provider.configured, available: workspace.provider.available },
    allowance: snapshot ? { status: 'available', snapshot: {
      period: snapshot.period, label: snapshot.label, resetsAt: snapshot.resetsAt,
      inputByteUnits: counter(snapshot.inputByteUnits), outputTokens: counter(snapshot.outputTokens),
      ...(snapshot.calls ? { calls: counter(snapshot.calls) } : {}),
    } } : { status: diagnostics.allowance.status },
    access: { mode: diagnostics.access.mode, role: diagnostics.access.role,
      members: members ? { owner: members.owner, operator: members.operator, reviewer: members.reviewer } : null },
    dailyTaskAllowance: workspace.runBudget ? { used: workspace.runBudget.used, limit: workspace.runBudget.limit, resetsAt: workspace.runBudget.resetsAt } : null,
    activeRunId: workspace.activeRunId,
    recentRuns: runs.map(run => ({ id: run.id, status: run.status, updatedAt: run.updatedAt,
      usage: { inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens } })),
  };
}

export function DiagnosticsDetails({ diagnostics, workspace, runs }: Props & { diagnostics: WorkspaceDiagnostics }) {
  const [downloadError, setDownloadError] = useState('');
  const allowance = diagnostics.allowance.status === 'available' ? diagnostics.allowance.snapshot : null;
  const checked = new Date(diagnostics.checkedAt);
  const reset = allowance ? allowanceReset(allowance) : null;
  const exhausted = allowance && [allowance.outputTokens, allowance.inputByteUnits, ...(allowance.calls ? [allowance.calls] : [])]
    .some(counter => { const capacity = allowanceCapacity(counter); return capacity.status === 'available' && capacity.exhausted; });

  function download() {
    setDownloadError('');
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(diagnosticExport(diagnostics, workspace, runs), null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'rivet-workspace-status.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setDownloadError('The status snapshot could not be downloaded. Try again.'); }
  }

  return <section className="workspace-diagnostics" aria-label="Rivet usage">
    <div className="connection-row">
      <span className="connection-icon"><Gauge size={19} /></span>
      <div className="workspace-usage-content">
        <h2>{allowance ? 'Remaining capacity' : 'Rivet usage'}</h2>
        {allowance ? <>
          <p>{allowance.period === 'batch' ? 'Local testing batch' : 'Monthly allowance'}</p>
          <div className="workspace-allowance-counters">
            <Counter label="Answer capacity" description="For generated answers, counted in tokens (small pieces of text)." unit="tokens" value={allowance.outputTokens} />
            <Counter label="Reading capacity" description="For text Rivet reads, counted in byte units that include request overhead." unit="byte units" value={allowance.inputByteUnits} />
            {allowance.calls && <Counter label="Request capacity" description="One task can make several requests, each with its own reservation." unit="requests" value={allowance.calls} />}
          </div>
          {exhausted && <p className="workspace-allowance-notice" role="status">An allowance has no capacity remaining. New requests may be blocked until capacity is renewed.</p>}
          {reset && <p className="workspace-allowance-reset">{reset.dateTime ? <>Next reset: <time dateTime={reset.dateTime}>{reset.text}</time></> : reset.text}</p>}
          <p className="workspace-allowance-explanation">Reserved means capacity conservatively set aside before a request, not measured actual usage or billing. Failed requests keep their reservation.</p>
        </> : <p role={diagnostics.allowance.status === 'unavailable' ? 'alert' : undefined}>{diagnostics.allowance.status === 'unavailable'
          ? 'Allowance could not be verified. Tasks are paused until usage can be checked.'
          : 'No allowance is reported by this server. This does not mean unlimited usage.'}</p>}
        <details className="settings-detail">
          <summary>Usage details</summary>
          <p>These are capacity allowances, not task counts or costs. Each request must fit within every applicable allowance.</p>
          {allowance && <p>Period: <code>{allowance.label}</code></p>}
          <p>Checked <time dateTime={diagnostics.checkedAt}>{Number.isFinite(checked.getTime()) ? checked.toLocaleString() : 'time unavailable'}</time></p>
          <button type="button" className="text-button" onClick={download} title="Status, allowance and task IDs only; no task text, file contents or account identities"><Download size={14} />Download status</button>
          {downloadError && <p className="module-alert" role="alert">{downloadError}</p>}
        </details>
      </div>
    </div>
  </section>;
}

export function WorkspaceDiagnosticsPanel({ refreshVersion, ...props }: Props & { refreshVersion: number }) {
  const [state, setState] = useState<{ data: WorkspaceDiagnostics | null; loading: boolean; error: boolean }>({ data: null, loading: true, error: false });
  useEffect(() => {
    const controller = new AbortController();
    setState({ data: null, loading: true, error: false });
    void api<WorkspaceDiagnostics>('/api/workspace/diagnostics', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(data => { if (!controller.signal.aborted) setState({ data, loading: false, error: false }); })
      .catch(() => { if (!controller.signal.aborted) setState({ data: null, loading: false, error: true }); });
    return () => controller.abort();
  }, [refreshVersion]);
  if (state.loading) return <p className="empty-note" role="status">Loading Rivet usage...</p>;
  if (state.error || !state.data) return <p className="module-alert" role="alert">Rivet usage could not be loaded. Refresh to retry.</p>;
  return <DiagnosticsDetails {...props} diagnostics={state.data} />;
}
