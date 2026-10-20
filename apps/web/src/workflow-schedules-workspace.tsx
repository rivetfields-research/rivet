import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import type { Workflow, WorkspaceStatus } from '../../../packages/core/src/types';
import type { WorkflowSchedule, WorkflowScheduleInput } from '../../../packages/core/src/workflow-schedules';
import type { ConnectionListEntry } from '../../../packages/core/src/sync-jobs';
import { ApiError, api, message } from './api';
import { localTime, type ConnectionsResponse } from './connections';
import { workspaceProfileStorage } from './workflow-storage';
import { ScheduleReportEmail, type ScheduleReportEmailStatus } from './schedule-report-email';
import { Temporal } from '@js-temporal/polyfill';

type Editor = { input: WorkflowScheduleInput; id: string | null; version: number | null; requestId: string; pending: boolean; weeklyReview?: boolean };
const KEY = 'rivetfields.schedule-editor.v1';
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const stamp = (value: string) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fields = ['name', 'workflowId', 'workflowVersion', 'sourceIds', 'connectionIds', 'refreshBeforeRun', 'frequency', 'time', 'weekday', 'timezone', 'enabled', 'signOff'] as const;
const MAX_CONNECTIONS = 5;
function scheduleInput(value: WorkflowSchedule): WorkflowScheduleInput { return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]])) as unknown as WorkflowScheduleInput; }
function sameInput(a: WorkflowScheduleInput, b: WorkflowScheduleInput) { return fields.every(key => JSON.stringify(key === 'signOff' ? a[key]?.trim() || 'The Rivet team' : a[key]) === JSON.stringify(key === 'signOff' ? b[key]?.trim() || 'The Rivet team' : b[key])); }
export function workflowScheduleSelection(input: WorkflowScheduleInput, workflow: Workflow): WorkflowScheduleInput {
  return { ...input, workflowId: workflow.id, workflowVersion: workflow.version,
    ...(!input.name.trim() ? { name: workflow.name } : {}),
    ...(workflow.weeklyReview ? { sourceIds: [], connectionIds: [...workflow.weeklyReview.connectionIds].sort(), refreshBeforeRun: true, frequency: 'weekly' as const, weekday: input.weekday ?? 1 }
      : { sourceIds: [...(workflow.sourceIds ?? [])] }) };
}

/** Preview the same local wall-clock choice across daylight-saving changes. */
export function scheduleNextRunPreview(input: Pick<WorkflowScheduleInput, 'frequency' | 'time' | 'weekday'> & {timezone?: string}, now = new Date(), timeZone?: string): { at: string; localTime: string; timeZone: string } | null {
  try {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) || !Number.isFinite(now.getTime()) ||
      !['daily', 'weekly'].includes(input.frequency) || (input.frequency === 'weekly' && (!Number.isInteger(input.weekday) || input.weekday! < 0 || input.weekday! > 6))) return null;
    const [hour, minute] = input.time.split(':').map(Number);
    const local = Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(input.timezone ?? 'UTC');
    let date = local.toPlainDate();
    if (input.frequency === 'weekly') date = date.add({days: (input.weekday! - date.dayOfWeek % 7 + 7) % 7});
    let slot = date.toZonedDateTime({timeZone: local.timeZoneId, plainTime: {hour, minute}});
    if (slot.epochMilliseconds <= now.getTime()) slot = date.add({days: input.frequency === 'daily' ? 1 : 7}).toZonedDateTime({timeZone: local.timeZoneId, plainTime: {hour, minute}});
    const next = new Date(slot.epochMilliseconds);
    const formatter = new Intl.DateTimeFormat(undefined, { ...(timeZone ? { timeZone } : {}), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    return { at: next.toISOString(), localTime: formatter.format(next), timeZone: formatter.resolvedOptions().timeZone };
  } catch { return null; }
}
/** A saved browser draft. Drafts saved before connections existed (no connection fields) stay valid. */
export function isEditor(value: unknown): value is Editor {
  if (!value || typeof value !== 'object') return false;
  const e = value as Editor; const c = e.input;
  return typeof e.requestId === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(e.requestId) && typeof e.pending === 'boolean' &&
    (e.weeklyReview === undefined || typeof e.weeklyReview === 'boolean') && (e.id === null || typeof e.id === 'string') &&
    (e.version === null || Number.isSafeInteger(e.version) && e.version > 0) && !!c && typeof c.name === 'string' &&
    typeof c.workflowId === 'string' && Number.isSafeInteger(c.workflowVersion) && Array.isArray(c.sourceIds) && c.sourceIds.length <= 100 &&
    c.sourceIds.every(id => typeof id === 'string') && (c.connectionIds === undefined || Array.isArray(c.connectionIds) && c.connectionIds.length <= MAX_CONNECTIONS && c.connectionIds.every(id => typeof id === 'string')) &&
    (c.refreshBeforeRun === undefined || typeof c.refreshBeforeRun === 'boolean') && typeof c.enabled === 'boolean' &&
    typeof c.timezone === 'string' && c.timezone.length <= 100 && (c.signOff === undefined || typeof c.signOff === 'string' && c.signOff.length <= 80) &&
    ['daily', 'weekly'].includes(c.frequency) && typeof c.time === 'string';
}

/** Plain copy for a start that did not happen; the stored code stays in the cell's title. */
export function scheduleStartFailure(code: string): string {
  return code === 'no_synced_data' ? 'Not started: no synced data yet' : 'Not started';
}

/**
 * The schedule fields after choosing or clearing one connection (at most five). Defaults are omitted, as the
 * server omits them (and sorted, as it stores them), so an unchanged schedule still compares equal when a save is retried; clearing the last
 * connection also clears "Refresh connected data first".
 */
export function connectionSelection(current: readonly string[] | undefined, id: string, checked: boolean): Pick<WorkflowScheduleInput, 'connectionIds' | 'refreshBeforeRun'> {
  const ids = current ?? [];
  const next = checked ? (ids.includes(id) || ids.length >= MAX_CONNECTIONS ? [...ids] : [...ids, id]) : ids.filter(item => item !== id);
  // Sorted as the server stores them, so a retried save compares equal.
  return next.length ? { connectionIds: next.sort() } : { connectionIds: undefined, refreshBeforeRun: undefined };
}

export type ScheduleConnectionBlock = 'owner' | 'unloaded' | null;
/**
 * Why a schedule's connected data cannot be changed here. The server refuses any schedule save that names connections
 * from someone who cannot manage them, and such people receive no connection list, so an unseen ID means "not yours".
 */
export function scheduleConnectionBlock(connectionIds: readonly string[] | undefined, visible: readonly Pick<ConnectionListEntry, 'id'>[], failed: boolean): ScheduleConnectionBlock {
  if (!connectionIds?.length) return null;
  if (failed) return 'unloaded';
  return connectionIds.some(id => !visible.some(item => item.id === id)) ? 'owner' : null;
}

export function ScheduleConnectionsField({ connectionIds = [], refreshBeforeRun, connections, block, onToggle, onRefresh }: {
  connectionIds?: readonly string[]; refreshBeforeRun: boolean; connections: readonly ConnectionListEntry[]; block: ScheduleConnectionBlock;
  onToggle: (id: string, checked: boolean) => void; onRefresh: (checked: boolean) => void;
}) {
  const full = connectionIds.length >= MAX_CONNECTIONS;
  const hidden = connectionIds.filter(id => !connections.some(item => item.id === id)).length;
  return <fieldset className="module-connection-selection"><legend>Connected data</legend>
    {block === 'owner' && <p role="status" className="module-tiny">Only a workspace owner can change a schedule that uses connected data.</p>}
    {block === 'unloaded' && <p role="status" className="module-tiny">Connected data could not be loaded, so this schedule cannot be saved yet. Refresh and try again.</p>}
    {connections.map(connection => {
      const checked = connectionIds.includes(connection.id);
      return <label key={connection.id} className="module-check-field"><input type="checkbox" checked={checked} disabled={Boolean(block) || (!checked && (full || connection.status === 'disconnected'))} onChange={event => onToggle(connection.id, event.target.checked)}/>
        <span>{connection.displayName}<small>{connection.status === 'disconnected' ? 'Disconnected · uses its last synced data' : connection.latestVersion ? `Data as of ${localTime(connection.latestVersion.observedAt)}` : 'No data yet'}</small></span></label>;
    })}
    {hidden > 0 && <p className="module-tiny">{hidden === 1 ? '1 connection' : `${hidden} connections`} you cannot view here</p>}
    <label className="module-check-field"><input type="checkbox" checked={refreshBeforeRun} disabled={Boolean(block) || !connectionIds.length} onChange={event => onRefresh(event.target.checked)}/><span>Refresh connected data first<small>Each run first syncs these connections. If a sync fails, the report uses the last synced data and says so.</small></span></label>
    <p className="module-tiny">Each run uses the newest synced data at its start time. Connection sync schedules are set in Settings.</p>
  </fieldset>;
}

export type WeeklyScheduleSummary = { label: string; status: string; nextRunAt: string | null; timezone: string; email: string };
type EmbeddedReview = { workflow: Workflow | null; view: 'schedule' | 'email'; disabled: boolean; onReview: () => void; onSummary: (value: WeeklyScheduleSummary | null) => void };

export function WorkflowSchedulesWorkspace({ workspace, onRun, onNavigate, legacy, requestedWorkflowId, embedded }: { workspace?: WorkspaceStatus; onRun: (id: string) => void; onNavigate: (view: string) => void; legacy: ReactNode; requestedWorkflowId?: string; embedded?: EmbeddedReview }) {
  const [storage] = useState(() => workspaceProfileStorage(workspace?.profile.id ?? 'workspace-analyst').local);
  const [initial] = useState(() => {
    try { const raw = storage.getItem(KEY); if (!raw) return { editor: null, error: '' }; const value: unknown = JSON.parse(raw); if (!isEditor(value)) throw Error(); return { editor: value, error: '' }; }
    catch { return { editor: null, error: 'The unfinished schedule could not be read. Its browser copy has been kept.' }; }
  });
  const [editor, setEditor] = useState<Editor | null>(initial.editor);
  const timeValue = useRef(initial.editor?.input.time);
  const [remembered, setRemembered] = useState<Editor | null>(initial.editor);
  const [unreadDraft, setUnreadDraft] = useState(Boolean(initial.error));
  const [error, setError] = useState(initial.error);
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>([]);
  const [emailStatus, setEmailStatus] = useState<ScheduleReportEmailStatus | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runtimeEnabled, setRuntimeEnabled] = useState(false);
  // Connections this person may schedule against; others receive an empty list (C8).
  const [connections, setConnections] = useState<ConnectionListEntry[]>([]);
  const [connectionsFailed, setConnectionsFailed] = useState(false);
  const connectionsEnabled = workspace?.connectionsEnabled === true;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);
  const [notice, setNotice] = useState('');
  const handledWorkflowRequests = useRef(new Set<string>());
  const [requestedWorkflow, setRequestedWorkflow] = useState<Workflow | null>(null);
  const [requestError, setRequestError] = useState('');
  useEffect(() => {
    let disposed = false; setLoading(true); setLoadError('');
    // Nothing is requested when this runtime serves no connections. A failed connection list never blocks schedules:
    // they load without it and say so, and a schedule that already uses connections cannot be saved until it loads.
    const connected = !connectionsEnabled ? Promise.resolve({ list: [] as ConnectionListEntry[], failed: false })
      : api<ConnectionsResponse>('/api/connections').then(value => ({ list: value.runtimeEnabled ? value.connections : [], failed: false }),
        error => ({ list: [] as ConnectionListEntry[], failed: !(error instanceof ApiError && error.status === 404) }));
    Promise.all([api<{ schedules: WorkflowSchedule[]; runtimeEnabled: boolean }>('/api/schedules'), api<{ workflows: Workflow[] }>('/api/workflows'), connected]).then(([saved, available, connectionList]) => {
      if (disposed) return; setSchedules(saved.schedules); setRuntimeEnabled(saved.runtimeEnabled === true); setWorkflows(available.workflows); setConnections(connectionList.list); setConnectionsFailed(connectionList.failed);
    }).catch(error => { if (!disposed) setLoadError(message(error)); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [revision, connectionsEnabled, embedded?.workflow?.id, embedded?.workflow?.version]);
  useEffect(() => {
    const workflow = embedded?.workflow;
    if (!workflow || loading || loadError || handledWorkflowRequests.current.has(workflow.id)) return;
    handledWorkflowRequests.current.add(workflow.id);
    if (remembered || unreadDraft || saving) {
      if (remembered?.input.workflowId === workflow.id) setEditor(remembered);
      else setRequestedWorkflow(workflow);
      return;
    }
    const linked = schedules.filter(item => item.workflowId === workflow.id);
    if (linked.length === 1) open(linked[0]);
    else if (!linked.length) openWorkflow(workflow);
  }, [loading, loadError, embedded?.workflow?.id, schedules, remembered, unreadDraft, saving]);
  useEffect(() => {
    if (!embedded) return;
    if (loading || loadError) { embedded.onSummary(null); return; }
    const linked = schedules.filter(item => item.workflowId === embedded.workflow?.id);
    const saved = linked.find(item => item.id === editor?.id) ?? (linked.length === 1 ? linked[0] : undefined);
    embedded.onSummary(saved ? { label: `${days[saved.weekday!]} · ${saved.time} ${saved.timezone}`,
      status: saved.enabled ? runtimeEnabled ? 'Scheduled' : 'Runtime unavailable' : 'Paused', nextRunAt: saved.enabled && runtimeEnabled ? saved.nextRunAt : null, timezone: saved.timezone,
      email: emailStatus ? !emailStatus.configured ? 'Email unavailable' : emailStatus.enabled ? emailStatus.localOnly ? 'Local capture on' : 'Email on' : 'Email off' : 'Check delivery settings' }
      : { label: linked.length ? `${linked.length} saved schedules` : 'Not scheduled', status: linked.length ? 'Choose a schedule' : 'Not scheduled', nextRunAt: null, timezone: 'UTC', email: 'Not configured' });
  }, [schedules, editor?.id, loading, loadError, runtimeEnabled, emailStatus, embedded?.workflow?.id, embedded?.onSummary]);
  useEffect(() => {
    if (loading || loadError || requestedWorkflowId === undefined || handledWorkflowRequests.current.has(requestedWorkflowId)) return;
    handledWorkflowRequests.current.add(requestedWorkflowId);
    setRequestError('');
    setRequestedWorkflow(null);
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(requestedWorkflowId)) { setRequestError('This workflow link is invalid. Choose a saved workflow to create a schedule.'); return; }
    const workflow = workflows.find(item => item.id === requestedWorkflowId);
    if (!workflow) { setRequestError('The requested workflow is unavailable. Choose another saved workflow.'); return; }
    if (remembered || unreadDraft || saving) { setRequestedWorkflow(workflow); return; }
    openWorkflow(workflow);
  }, [loading, loadError, requestedWorkflowId, workflows, remembered, unreadDraft, saving]);
  function remember(next: Editor) {
    timeValue.current = next.input.time;
    setEditor(next); setRemembered(next);
    try { storage.setItem(KEY, JSON.stringify(next)); setError(''); return true; }
    catch { setError('The schedule draft could not be kept in this browser. Nothing was submitted.'); return false; }
  }
  function clearEditor() { try { storage.removeItem(KEY); setEditor(null); setRemembered(null); setUnreadDraft(false); return true; } catch { setError('The saved schedule is safe, but its retry record could not be cleared. Retry the same save.'); return false; } }
  function newEditor(): Editor { return { input: { name: '', workflowId: '', workflowVersion: 1, sourceIds: [], frequency: 'weekly', weekday: 1, time: '08:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', enabled: false }, id: null, version: null, requestId: crypto.randomUUID(), pending: false }; }
  function openWorkflow(workflow: Workflow) {
    const next = newEditor();
    remember({ ...next, input: workflowScheduleSelection(next.input, workflow), weeklyReview: Boolean(workflow.weeklyReview) });
    setNotice('');
  }
  function open(value?: WorkflowSchedule) {
    if (remembered) { setEditor(remembered); setNotice('Finish or discard the unfinished schedule first.'); return; }
    if (unreadDraft) { setNotice('The unfinished schedule could not be read. Keep or discard its browser copy before opening another schedule.'); return; }
    const workflow = value && workflows.find(item => item.id === value.workflowId);
    const next: Editor = value ? { input: scheduleInput(value), id: value.id, version: value.version, requestId: crypto.randomUUID(), pending: false,
      weeklyReview: Boolean(workflow?.weeklyReview && (workflow.version === value.workflowVersion || (!value.sourceIds.length && value.refreshBeforeRun))) }
      : newEditor();
    remember(next); setNotice('');
  }
  function change(patch: Partial<WorkflowScheduleInput>) { if (editor && !editor.pending && !saving) remember({ ...editor, input: { ...editor.input, ...patch } }); }
  function changeTime(value: string) { if (value !== timeValue.current) change({ time: value }); }
  function toggleConnection(id: string, checked: boolean) { if (editor) change(connectionSelection(editor.input.connectionIds, id, checked)); }
  function chooseWorkflow(id: string) { const workflow = workflows.find(item => item.id === id); if (workflow && editor && !editor.pending && !saving) remember({ ...editor, input: workflowScheduleSelection(editor.input, workflow), weeklyReview: Boolean(workflow.weeklyReview) }); }
  async function save(event?: FormEvent) {
    event?.preventDefault(); if (!editor || saving || loadError || embedded?.disabled) return;
    const intent = { ...editor, pending: true };
    if (!remember(intent)) return;
    setSaving(true); setError('');
    try {
      let saved: WorkflowSchedule;
      if (intent.id) {
        const fresh = await api<{ schedules: WorkflowSchedule[] }>('/api/schedules');
        const current = fresh.schedules.find(item => item.id === intent.id);
        saved = current && current.version > intent.version! && sameInput(scheduleInput(current), intent.input) ? current : await api<WorkflowSchedule>(`/api/schedules/${encodeURIComponent(intent.id)}`, { method: 'PUT', body: JSON.stringify({ ...intent.input, version: intent.version }) });
      } else saved = await api<WorkflowSchedule>('/api/schedules', { method: 'POST', body: JSON.stringify({ ...intent.input, requestId: intent.requestId }) });
      setSchedules(list => [saved, ...list.filter(item => item.id !== saved.id)]);
      if (clearEditor()) {
        setNotice(saved.enabled ? runtimeEnabled ? 'Schedule saved.' : 'Schedule saved. Waiting for the scheduler.' : 'Schedule saved paused.');
        if ((!intent.id || embedded) && intent.weeklyReview) setEditor({ input: scheduleInput(saved), id: saved.id, version: saved.version, requestId: crypto.randomUUID(), pending: false, weeklyReview: true });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) remember({ ...intent, pending: false });
      setError(message(error));
    } finally { setSaving(false); }
  }
  async function archive() {
    if (!editor?.id || !editor.version || saving || editor.pending) return;
    setSaving(true); setError('');
    try { await api(`/api/schedules/${encodeURIComponent(editor.id)}`, { method: 'DELETE', body: JSON.stringify({ version: editor.version }) }); setSchedules(list => list.filter(item => item.id !== editor.id)); clearEditor(); setNotice('Schedule archived. Earlier runs are kept.'); }
    catch (error) { setError(message(error)); }
    finally { setSaving(false); }
  }
  if (showLegacy) return <><div className="module-legacy-back"><button className="text-button" onClick={() => setShowLegacy(false)}>Back to saved schedules</button></div>{legacy}</>;
  const feedback = <>{error && <div className="module-alert" role="alert">{error}</div>}{loadError && <div className="module-alert" role="alert"><span>{loadError}</span><button type="button" onClick={() => setRevision(value => value + 1)}>Retry</button></div>}{requestError && <p className="module-notice" role="status">{requestError}</p>}{requestedWorkflow && <div className="module-alert" role="status"><span>Schedule {requestedWorkflow.name}? Your unfinished schedule has been kept.{remembered?.pending && ' Retry the same save before starting another schedule.'}</span><button type="button" className="module-link" onClick={() => setRequestedWorkflow(null)}>Keep current draft</button><button type="button" className="module-link" disabled={saving || remembered?.pending || loading || Boolean(loadError)} onClick={() => { const workflow = workflows.find(item => item.id === requestedWorkflow.id); if (workflow && clearEditor()) { setRequestedWorkflow(null); openWorkflow(workflow); } }}>{remembered || unreadDraft ? 'Discard draft and use workflow' : 'Use requested workflow'}</button></div>}{notice && <p className="module-notice" role="status">{notice}</p>}{connectionsFailed && <p className="module-notice" role="status">Connected data could not be loaded. Schedules without connections still work; refresh to try again.</p>}</>;
  if (editor) {
    const selected = workflows.find(item => item.id === editor.input.workflowId);
    const stale = selected && selected.version !== editor.input.workflowVersion;
    const locked = saving || editor.pending || Boolean(embedded?.disabled);
    // Keep the chosen mode with the draft when a newer workflow changes its accounts or source type.
    const weeklyReview = editor.weeklyReview ?? Boolean(selected?.weeklyReview && (!stale || (!editor.input.sourceIds.length && editor.input.refreshBeforeRun)));
    const savedSchedule = schedules.find(item => item.id === editor.id);
    const savedWorkflow = workflows.find(item => item.id === savedSchedule?.workflowId);
    const savedWeeklyReview = savedSchedule && savedWorkflow?.weeklyReview && (savedWorkflow.version === savedSchedule.workflowVersion || (!savedSchedule.sourceIds.length && savedSchedule.refreshBeforeRun));
    const nextRun = scheduleNextRunPreview(editor.input, new Date(), editor.input.timezone);
    const connectionBlock = loading ? null : scheduleConnectionBlock(editor.input.connectionIds, connections, connectionsFailed);
    if (embedded && (!embedded.workflow || editor.input.workflowId !== embedded.workflow.id)) return <section className="weekly-inline-schedule">{feedback}<p>Save the review before setting its schedule or email.</p><button type="button" className="module-link" onClick={embedded.onReview}>Review accounts and report <ArrowRight size={13}/></button></section>;
    return <section className={embedded ? 'weekly-inline-schedule' : 'module-detail module-schedules'}><form onSubmit={event => void save(event)} className="module-detail-form">
      {embedded ? <div className="weekly-inline-toolbar"><span className="module-tiny">{savedSchedule ? savedSchedule.enabled ? runtimeEnabled ? 'Scheduled' : 'Runtime unavailable' : 'Paused' : 'Not scheduled'}</span><button type="submit" className="button secondary" disabled={Boolean(embedded.disabled) || saving || loading || Boolean(loadError) || Boolean(connectionBlock) || !editor.input.workflowId || (!editor.id && !editor.input.connectionIds?.length) || (!editor.pending && Boolean(savedSchedule && sameInput(scheduleInput(savedSchedule), editor.input)))}>{saving ? 'Saving…' : editor.pending ? 'Retry same save' : embedded.view === 'email' ? 'Save sign-off' : 'Save schedule'}</button></div> :
      <header className="module-editor-heading module-compact-heading"><div className="module-editor-identity"><button type="button" className="module-back module-back-icon" aria-label="Back to schedules" disabled={saving} onClick={() => setEditor(null)}><ArrowLeft size={17}/></button><h1>{editor.id ? 'Edit schedule' : 'New schedule'}</h1></div><button className="button module-primary" disabled={saving || loading || Boolean(loadError) || Boolean(connectionBlock) || !editor.input.workflowId || (!editor.id && !editor.input.sourceIds.length && !editor.input.connectionIds?.length)}>{saving ? 'Saving…' : editor.pending ? 'Retry same save' : 'Save schedule'}</button></header>
      }{feedback}<div className={embedded ? 'weekly-inline-fields' : 'module-document workflow-configuration'}><fieldset className="workflow-fields" disabled={locked || embedded?.view === 'email'} hidden={embedded?.view === 'email'}>
        <div hidden={Boolean(embedded)}>
        <div className="module-field"><label htmlFor="schedule-name">Name</label><input id="schedule-name" autoFocus={!embedded} value={editor.input.name} maxLength={160} required onChange={event => change({ name: event.target.value })}/></div>
        <div className="module-field"><label htmlFor="schedule-workflow">Workflow</label><select id="schedule-workflow" value={editor.input.workflowId} required onChange={event => chooseWorkflow(event.target.value)}><option value="">Choose a saved workflow</option>{editor.input.workflowId && !selected && <option value={editor.input.workflowId}>Unavailable workflow</option>}{workflows.map(workflow => <option value={workflow.id} key={workflow.id}>{workflow.name} · v{workflow.version}</option>)}</select>{!workflows.length && !loading && <button type="button" className="module-link" onClick={() => onNavigate('workflows')}>Create a workflow <ArrowRight size={12}/></button>}</div>
        </div>
        {selected && !editor.input.sourceIds.length && !editor.input.connectionIds?.length && <p role="status" className="module-tiny">{weeklyReview ? 'Choose accounts in Workflows, then select its new version.' : connections.length ? 'Select files in this workflow, or choose connected data below.' : 'Select files in this workflow before scheduling it.'}</p>}
        {stale && <p role="status">This schedule uses v{editor.input.workflowVersion}. <button type="button" className="module-link" onClick={() => chooseWorkflow(selected.id)}>Use v{selected.version}</button></p>}
        {weeklyReview ? <>{connectionBlock && embedded && <p role="status" className="module-tiny">Accounts are unavailable. Refresh and review their connections before saving.</p>}<fieldset className="module-connection-selection" hidden={Boolean(embedded)}><legend>Accounts from workflow</legend><ul>{editor.input.connectionIds?.map((id, index) => { const connection = connections.find(item => item.id === id); return <li key={id}>{connection?.displayName ?? `Unavailable account ${index + 1}`}{connection?.status === 'disconnected' && ' (disconnected)'}</li>; })}</ul>{connectionBlock && <p role="status" className="module-tiny">{connectionBlock === 'unloaded' ? 'Accounts could not be loaded. Refresh and try again before saving.' : 'A chosen account is unavailable here. Review its connection in Settings before saving.'}</p>}<p className="module-tiny">Previous seven full days in {editor.input.timezone}. Each run refreshes the chosen accounts and uses their latest data.</p><p className="module-tiny">From saved workflow v{editor.input.workflowVersion}. Change accounts in Workflows, then select its new version.</p></fieldset></>
          : editor.input.workflowId && <details className="module-file-selection"><summary>Files <span>{editor.input.sourceIds.length} selected</span><ChevronRight size={13}/></summary>{editor.input.sourceIds.length ? <ul>{editor.input.sourceIds.map(id => <li key={id}>{workspace?.sources.find(source => source.id === id)?.title ?? 'Unavailable file'}</li>)}</ul> : <p className="module-tiny">No files attached.</p>}<p className="module-tiny">From saved workflow v{editor.input.workflowVersion}. Change files in Workflows, then select its new version.</p></details>}
        {!weeklyReview && (connections.length > 0 || Boolean(editor.input.connectionIds?.length)) && <ScheduleConnectionsField connectionIds={editor.input.connectionIds} refreshBeforeRun={editor.input.refreshBeforeRun === true}
          connections={connections} block={connectionBlock} onToggle={toggleConnection} onRefresh={checked => change({ refreshBeforeRun: checked ? true : undefined })}/>}
        <div className="module-field" hidden={Boolean(embedded)}><label htmlFor="schedule-frequency">Repeat</label><select id="schedule-frequency" value={editor.input.frequency} onChange={event => change({ frequency: event.target.value as 'daily' | 'weekly', weekday: event.target.value === 'weekly' ? 1 : undefined })}>{!weeklyReview && <option value="daily">Daily</option>}<option value="weekly">Weekly</option></select></div>
        <div className={embedded ? 'weekly-schedule-time' : undefined}>
        {editor.input.frequency === 'weekly' && <div className="module-field"><label htmlFor="schedule-weekday">Day</label><select id="schedule-weekday" value={editor.input.weekday} onChange={event => change({ weekday: Number(event.target.value) })}>{days.map((day, index) => <option value={index} key={day}>{day}</option>)}</select></div>}
        <div className="module-field"><label htmlFor="schedule-time">Local time</label><input id="schedule-time" type="time" required value={editor.input.time} onInput={event => changeTime(event.currentTarget.value)} onChange={event => changeTime(event.currentTarget.value)}/></div>
        <div className="module-field"><label htmlFor="schedule-timezone">Timezone</label><input id="schedule-timezone" list="schedule-timezones" required value={editor.input.timezone} onChange={event => change({timezone: event.target.value})}/><datalist id="schedule-timezones">{['UTC', ...Intl.supportedValuesOf('timeZone')].map(zone => <option value={zone} key={zone}/>)}</datalist></div>
        </div>
        <p className="module-tiny" role="status">{nextRun ? <>Next review{editor.input.enabled ? '' : ' if enabled'}: <time dateTime={nextRun.at}>{nextRun.localTime}</time>{!embedded && <> ({nextRun.timeZone}) [{new Date(nextRun.at).toUTCString()}].</>}</> : 'Choose a valid local time and timezone.'}</p>
        <label className="module-check-field"><input type="checkbox" checked={editor.input.enabled} disabled={!runtimeEnabled} onChange={event => change({ enabled: event.target.checked })}/><span>Enable scheduled runs</span></label>
        {!runtimeEnabled && !loading && <p role="status" className="module-tiny">The scheduler is unavailable. Save paused until it is connected.</p>}
      </fieldset>{weeklyReview && <div hidden={Boolean(embedded && embedded.view !== 'email')}><fieldset className="workflow-fields" disabled={locked}><div className="module-field"><label htmlFor="schedule-sign-off">Email sign-off</label><input id="schedule-sign-off" maxLength={80} value={editor.input.signOff ?? 'The Rivet team'} onChange={event => change({signOff: event.target.value})}/></div></fieldset><ScheduleReportEmail compact={Boolean(embedded)} onStatus={setEmailStatus} scheduleId={savedWeeklyReview ? savedSchedule.id : null} disabled={locked || loading || Boolean(loadError)}/></div>}
      <p className="module-tiny">Runs use the normal permissions and model allowance.{!weeklyReview && ' No notifications are sent.'}</p>{editor.pending && <p role="status" className="module-tiny">Save not confirmed. Retry keeps the same request.</p>}
      {embedded && savedSchedule?.lastAttempt?.runId && <button type="button" className="module-link" onClick={() => onRun(savedSchedule.lastAttempt!.runId!)}>Open last started review <ArrowRight size={13}/></button>}
      {embedded && <details className="weekly-schedule-options"><summary>Schedule options</summary>{editor.id && <button type="button" className="module-link" disabled={locked} onClick={() => void archive()}>Archive schedule</button>}{!editor.pending && <button type="button" className="module-link schedule-discard" disabled={saving} onClick={() => clearEditor()}>Discard edits</button>}<button type="button" className="module-link" onClick={() => onNavigate('schedules')}>All schedules <ArrowRight size={13}/></button></details>}
      {!embedded && editor.id && <button type="button" className="module-link" disabled={locked} onClick={() => void archive()}>Archive schedule</button>}
      {!embedded && !editor.pending && <button type="button" className="module-link schedule-discard" disabled={saving} onClick={() => clearEditor()}>Discard edits</button>}
      </div></form></section>;
  }
  if (embedded) return <section className="weekly-inline-schedule">{feedback}{loading ? <p role="status">Loading schedule…</p> : !embedded.workflow ? <><p>Save the review before setting its schedule or email.</p><button type="button" className="module-link" onClick={embedded.onReview}>Review accounts and report <ArrowRight size={13}/></button></> : <><h3>Choose a schedule</h3>{schedules.filter(item => item.workflowId === embedded.workflow!.id).map(item => <button type="button" className="module-template-row" key={item.id} onClick={() => open(item)}>{item.name}</button>)}<button type="button" className="module-link" disabled={embedded.disabled || Boolean(loadError) || unreadDraft} onClick={() => openWorkflow(embedded.workflow!)}>New weekly schedule <Plus size={13}/></button></>}</section>;
  return <section className="module-page module-schedules"><div className="module-page-heading"><div><h1>Schedules</h1><p>Saved workflows, at a time you choose.</p></div><button className="button module-primary" onClick={() => open()} disabled={loading || Boolean(loadError) || unreadDraft}><Plus size={15}/>{remembered ? 'Resume draft' : 'New schedule'}</button></div>
    {feedback}
    <div className="module-library-heading"><span className="module-library-count">{schedules.length} saved {schedules.length === 1 ? 'schedule' : 'schedules'}</span><button className="icon-button" aria-label="Refresh schedules" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14}/></button></div>
    {loading ? <p className="empty-note" role="status">Loading schedules…</p> : schedules.length ? <div className="module-table-wrap"><table className="module-library"><thead><tr><th>Schedule</th><th>Status</th><th>Next run</th><th>Last start</th></tr></thead><tbody>{schedules.map(schedule => <tr key={schedule.id}><td><button className="module-row-title" onClick={() => open(schedule)}><span className="module-row-icon"><CalendarDays size={18}/></span><span><strong>{schedule.name}</strong><small>{schedule.frequency === 'weekly' ? days[schedule.weekday!] : 'Daily'} · {schedule.time} {schedule.timezone}</small></span></button></td><td>{schedule.enabled ? runtimeEnabled ? 'Scheduled' : 'Runtime unavailable' : 'Paused'}</td><td>{schedule.enabled && runtimeEnabled && schedule.nextRunAt ? stamp(schedule.nextRunAt) : '—'}</td><td>{schedule.lastAttempt?.runId ? <button className="module-link" onClick={() => onRun(schedule.lastAttempt!.runId!)}>Open task <ArrowRight size={12}/></button> : schedule.lastAttempt?.status === 'pending' ? <span>Awaiting start</span> : schedule.lastAttempt?.errorCode ? <span title={schedule.lastAttempt.errorCode}>{scheduleStartFailure(schedule.lastAttempt.errorCode)}</span> : '—'}</td></tr>)}</tbody></table></div> : !loadError && <div className="module-empty"><CalendarDays size={25}/><h2>No schedules yet</h2><p>Choose a saved workflow to repeat.</p></div>}
    <details className="module-template-disclosure"><summary>Earlier schedule plans</summary><p className="module-tiny">Browser plans do not run automatically.</p><button className="module-link" onClick={() => setShowLegacy(true)}>Open browser plans <ArrowRight size={13}/></button></details>
  </section>;
}
