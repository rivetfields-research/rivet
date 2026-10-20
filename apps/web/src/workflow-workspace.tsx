import { ModuleSourceSelection } from './module-source-selection';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, BookOpen, Bot, CalendarDays, Check, ChevronRight, CircleDashed, FileText, GitBranch, History, Link2, Mail, Play, Plus, Minus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Undo2, UserRound } from 'lucide-react';
import type { Run, RunSummary, Workflow, WorkspaceStatus } from '../../../packages/core/src/types';
import { ApiError, api, message } from './api';
import { clearEditorRecovery, loadDrafts, loadEditorRecovery, migrateWorkflowDraft, removeDraft, saveDraft, saveEditorRecovery, type DraftCollection, type EditorRecovery, type WorkspaceDraft } from './draft-store';
import { finishWorkflowIntent, intentDraft, persistWorkflowIntent, readWorkflowIntent, sameWorkflow, weeklyReviewConnectionIds, weeklyReviewDraft, workflowDraft, workflowDraftOpening, workflowInput, workflowInputIssue, workflowSourceIds, type RunIntent, type SaveIntent } from './workflow-state';
import { canManageSources, type WorkspaceSession } from './session-access';
import type { ConnectionsResponse } from './connection-model';
import type { ConnectionListEntry } from '../../../packages/core/src/sync-jobs';
import { WeeklyReviewAccounts } from './weekly-review-accounts';
import { workspaceProfileStorage } from './workflow-storage';
import { WorkflowSchedulesWorkspace, type WeeklyScheduleSummary } from './workflow-schedules-workspace';
export { workspaceProfileStorage } from './workflow-storage';

type Props = { onRun: (id: string) => void; onNavigate: (view: string) => void; onSchedule?: (workflowId: string) => void; session?: WorkspaceSession | null; workspace?: WorkspaceStatus; requestedDraft?: WorkspaceDraft | null; onRequestedDraftHandled?: () => void };
type Starter = { name: string; description: string; instructions: string; output: string; review: string };
type ProfileStorage = ReturnType<typeof workspaceProfileStorage>;
const starters: Starter[] = [
  { name: 'Referral handoff', description: 'Prepare a clear administrative handoff from synthetic referral notes.', instructions: 'Read the approved synthetic referral notes, queue rules, and team responsibilities. Check administrative completeness for each case. Identify missing documents, the responsible owner, and the next administrative step. Use only the provided evidence. Do not assign clinical urgency, diagnose, recommend treatment, approve coverage, or claim an appointment was scheduled. Ready means ready for staff review only.', output: 'A concise handoff table with case ID, administrative status, missing items, owner, next step, and source citations. Follow with unresolved administrative questions. Label the source cases synthetic.', review: 'A staff member checks source links, missing documents, ownership, and next steps. This is an administrative handoff, not a clinical, coverage, or scheduling decision.' },
  { name: 'Research brief', description: 'Turn approved source notes into findings and open questions.', instructions: 'Read the approved source notes. Identify the main findings, conflicting evidence, and unanswered questions. Cite the notes used and keep unsupported assumptions explicit.', output: 'A concise brief with key findings, source citations, and open questions.', review: 'Review the evidence and uncertainty before relying on or sharing the brief.' },
  { name: 'Decision review', description: 'Compare options and make their trade-offs visible.', instructions: 'Define the decision and criteria from the approved source notes. Compare available options. Explain the supporting evidence, assumptions, and missing information.', output: 'An options comparison and recommendation, with source citations and limitations.', review: 'A person reviews the recommendation and its evidence before taking action.' },
];
const stamp = (v: string) => new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const statusText: Record<RunSummary['status'], string> = { queued: 'Queued', running: 'Working', completed: 'Complete', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Stopped' };
function blank(starter?: Starter): WorkspaceDraft {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), kind: 'workflows', name: starter?.name ?? '', description: starter?.description ?? '', fields: { trigger: 'Manual', instructions: starter?.instructions ?? '', output: starter?.output ?? '', review: starter?.review ?? '' }, createdAt: now, updatedAt: now };
}
function initialState(storage: ProfileStorage) {
  let local: DraftCollection = { version: 1, drafts: [] }; let recovery: EditorRecovery | null = null; let save: SaveIntent | null = null; let run: RunIntent | null = null; const errors: string[] = [];
  try { local = loadDrafts(storage.local); } catch (e) { errors.push(message(e)); }
  try { recovery = loadEditorRecovery('workflows', storage.recovery); } catch (e) { errors.push(message(e)); }
  try { save = readWorkflowIntent('save', storage.local); } catch (e) { errors.push(message(e)); }
  try { run = readWorkflowIntent('run', storage.local); } catch (e) { errors.push(message(e)); }
  return { local, recovery, save, run, error: errors.join(' ') };
}

export function WorkflowWorkspace({ onRun, onNavigate, onSchedule, session, workspace, requestedDraft, onRequestedDraftHandled }: Props) {
  const [storage] = useState(() => workspaceProfileStorage(workspace?.profile.id ?? 'workspace-analyst'));
  const [initial] = useState(() => initialState(storage));
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [local, setLocal] = useState(initial.local);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState(initial.error);
  const [recoveryError, setRecoveryError] = useState('');
  const [notice, setNotice] = useState(initial.save ? 'A workflow save needs confirmation. Retry the same save to resolve it.' : initial.recovery ? 'Restored your unfinished workflow.' : '');
  const [draft, setDraft] = useState<WorkspaceDraft | null>(initial.save ? intentDraft(initial.save) : initial.recovery?.draft ?? null);
  const [savedVersion, setSavedVersion] = useState<number | null>(initial.save?.version ?? initial.recovery?.workflowVersion ?? null);
  const [dirty, setDirty] = useState(Boolean(initial.recovery || initial.save));
  const [step, setStep] = useState(initial.recovery?.draft.fields.weeklyReview !== undefined ? Math.min(initial.recovery.activeStep, 2) : initial.recovery?.activeStep ?? 0);
  const [filter, setFilter] = useState('');
  const [editorTab, setEditorTab] = useState<'canvas' | 'configuration' | 'history'>('canvas');
  const [zoom, setZoom] = useState(100);
  const [pendingSave, setPendingSave] = useState(initial.save);
  const [pendingRun, setPendingRun] = useState(initial.run);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [connections, setConnections] = useState<ConnectionListEntry[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [connectionsError, setConnectionsError] = useState('');
  const [connectionsRevision, setConnectionsRevision] = useState(0);
  const [weeklySchedule, setWeeklySchedule] = useState<WeeklyScheduleSummary | null>(null);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [deleted, setDeleted] = useState<WorkspaceDraft | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const leaveRef = useRef<HTMLDivElement>(null);
  const nextNavigation = useRef<(() => void) | null>(null);
  const requestInFlight = useRef(false);
  const handledDraft = useRef<string | null>(null);
  const visible = workflows.filter(w => `${w.name} ${w.instructions}`.toLowerCase().includes(filter.toLowerCase()));
  const browserDrafts = local.drafts.filter(d => d.kind === 'workflows' && !workflows.some(w => w.id === d.id));
  const selectedSaved = workflows.find(w => w.id === draft?.id) ?? null;
  const isHealthcare = workspace?.profile.id.includes('healthcare');
  const weekly = draft?.fields.weeklyReview !== undefined;
  const selectedConnectionIds = draft ? weeklyReviewConnectionIds(draft) : [];
  const managesConnections = canManageSources(session);
  const orderedStarters = isHealthcare ? starters : [starters[1], starters[2]];

  async function refresh() {
    setLoading(true);
    try { const response = await api<{ workflows: Workflow[] }>('/api/workflows'); setWorkflows(response.workflows); setLoadError(''); }
    catch (e) { setLoadError(message(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!weekly || !managesConnections || !workspace?.connectionsEnabled) return;
    let disposed = false; setConnectionsLoading(true); setConnectionsError('');
    void api<ConnectionsResponse>('/api/connections').then(value => {
      if (!disposed) { setConnections(value.connections); if (!value.runtimeEnabled) setConnectionsError('Connections are not available in this workspace yet.'); }
    }).catch(error => { if (!disposed) setConnectionsError(message(error)); }).finally(() => { if (!disposed) setConnectionsLoading(false); });
    return () => { disposed = true; };
  }, [weekly, managesConnections, workspace?.connectionsEnabled, connectionsRevision]);
  useEffect(() => {
    if (!requestedDraft || handledDraft.current === requestedDraft.id) return;
    handledDraft.current = requestedDraft.id;
    const openRequested = () => {
      openDraft(requestedDraft);
      setNotice(`Prepared from your report. Review the task and selected files, then save when ready.${requestedDraft.fields.instructions.length > 2400 ? ' Shorten the working instructions to 2,400 characters before saving; the full original task is still here.' : ''}`);
    };
    const opening = workflowDraftOpening(draft, dirty, pendingSave, initial.error);
    if (opening === 'confirm') { nextNavigation.current = openRequested; setLeavePrompt(true); }
    else if (opening === 'blocked') setNotice('The report draft could not be opened while an existing browser record needs recovery. Your stored work has been kept.');
    else openRequested();
    onRequestedDraftHandled?.();
  }, [requestedDraft, onRequestedDraftHandled]);
  useEffect(() => { if (draft) headingRef.current?.focus(); }, [draft?.id]);
  useEffect(() => { if (leavePrompt) leaveRef.current?.focus(); }, [leavePrompt]);
  useEffect(() => {
    if (!draft || !savedVersion) { setRuns([]); return; }
    let disposed = false; setHistoryLoading(true); setHistoryError('');
    api<{ runs: RunSummary[] }>(`/api/workflows/${encodeURIComponent(draft.id)}/runs`).then(response => { if (!disposed) setRuns(response.runs); }).catch(e => { if (!disposed) setHistoryError(message(e)); }).finally(() => { if (!disposed) setHistoryLoading(false); });
    return () => { disposed = true; };
  }, [draft?.id, savedVersion, historyRefresh]);
  useEffect(() => {
    if (!draft || (!dirty && !pendingSave)) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const navigate = (event: Event) => { const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed; if (typeof proceed === 'function') { event.preventDefault(); nextNavigation.current = proceed; setLeavePrompt(true); } };
    window.addEventListener('beforeunload', unload); window.addEventListener('rivetfields:before-navigate', navigate);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('rivetfields:before-navigate', navigate); };
  }, [Boolean(draft), dirty, Boolean(pendingSave)]);
  function remember(next: WorkspaceDraft, activeStep = step, version = savedVersion) {
    try { saveEditorRecovery({ version: 1, draft: next, activeStep, ...(version ? { workflowVersion: version } : {}) }, storage.recovery); setRecoveryError(''); }
    catch (e) { setRecoveryError(message(e)); }
  }
  function clearRecovery() { try { clearEditorRecovery('workflows', storage.recovery); setRecoveryError(''); return true; } catch (e) { setRecoveryError(message(e)); return false; } }
  function openSaved(workflow: Workflow) { setDraft(workflowDraft(workflow)); setSavedVersion(workflow.version); setDirty(false); setStep(0); setWeeklySchedule(null); setEditorTab('canvas'); setError(''); setNotice(''); }
  function openDraft(value?: WorkspaceDraft, starter?: Starter) { const next = value ?? blank(starter), firstStep = next.fields.weeklyReview !== undefined ? 1 : 0; setDraft(next); setSavedVersion(null); setDirty(true); setStep(firstStep); setWeeklySchedule(null); setEditorTab('canvas'); remember(next, firstStep, null); setError(''); setNotice(value ? 'This browser draft is ready to save as a runnable workflow.' : ''); }
  function closeNow() { setDraft(null); setDirty(false); setSavedVersion(null); setLeavePrompt(false); nextNavigation.current = null; setNotice(''); }
  function close() { nextNavigation.current = null; if (dirty || pendingSave) setLeavePrompt(true); else closeNow(); }
  function keepEditing() { nextNavigation.current = null; setLeavePrompt(false); headingRef.current?.focus(); }
  function leave(discard = false) {
    if (discard && pendingSave) { setError('Resolve the pending save first. It may already have reached the server.'); return; }
    if (discard && !clearRecovery()) return;
    const proceed = nextNavigation.current; closeNow(); proceed?.();
  }
  function update(key: string, value: string) {
    if (!draft || pendingSave || saving) return;
    const next = key === 'name' ? { ...draft, name: value } : { ...draft, fields: { ...draft.fields, [key]: value } };
    setDraft(next); setDirty(true); setNotice(''); remember(next);
  }
  function selectStep(value: number) { setStep(value); if (draft && dirty) remember(draft, value); if (window.matchMedia('(max-width: 800px)').matches) requestAnimationFrame(() => document.getElementById(weekly ? 'workflow-step-details' : `workflow-field-${value}`)?.focus()); }
  function clearIntent(kind: 'save', intent: SaveIntent): boolean;
  function clearIntent(kind: 'run', intent: RunIntent): boolean;
  function clearIntent(kind: 'save' | 'run', intent: SaveIntent | RunIntent) {
    const result = finishWorkflowIntent(kind, intent, storage.local);
    if (kind === 'save') setPendingSave(result.pending as SaveIntent | null); else setPendingRun(result.pending as RunIntent | null);
    if (result.error) setError(result.error);
    return result.pending === null;
  }
  async function acceptSaved(workflow: Workflow, intent: SaveIntent) {
    setWorkflows(list => [workflow, ...list.filter(w => w.id !== workflow.id)]);
    const next = workflowDraft(workflow); setDraft(next); setSavedVersion(workflow.version); setDirty(false); setNotice(`Workflow saved. Version ${workflow.version} is ready to run.`); setError('');
    remember(next, step, workflow.version); clearRecovery();
    try { setLocal(migrateWorkflowDraft(intent.workflowId ?? intent.requestId, workflow.id, storage.local, storage.recovery)); }
    catch { setError('The workflow is saved. Its older browser copy and schedule links were kept because browser storage could not be updated.'); }
    return clearIntent('save', intent);
  }
  async function saveWorkflow(event?: FormEvent): Promise<boolean> {
    event?.preventDefault(); if (!draft || requestInFlight.current) return false;
    const input = workflowInput(draft); const issue = workflowInputIssue(input);
    if (issue && !pendingSave) { setError(issue); return false; }
    const intent: SaveIntent = pendingSave ?? { schema: 1, requestId: draft.id, workflowId: savedVersion ? draft.id : null, version: savedVersion, input };
    if (!pendingSave) { try { persistWorkflowIntent('save', intent, storage.local); } catch (e) { setError(message(e)); return false; } setPendingSave(intent); }
    requestInFlight.current = true; setSaving(true); setError('');
    try {
      let workflow: Workflow;
      if (intent.workflowId && intent.version) {
        const current = await api<Workflow>(`/api/workflows/${encodeURIComponent(intent.workflowId)}`);
        workflow = current.version > intent.version && sameWorkflow(current, intent.input) ? current : await api<Workflow>(`/api/workflows/${encodeURIComponent(intent.workflowId)}`, { method: 'PUT', body: JSON.stringify({ ...intent.input, version: intent.version }) });
      } else workflow = await api<Workflow>('/api/workflows', { method: 'POST', body: JSON.stringify({ ...intent.input, requestId: intent.requestId }) });
      return await acceptSaved(workflow, intent);
    } catch (e) {
      setError(message(e));
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) clearIntent('save', intent);
      else setNotice('Save not confirmed. Retry the same save; your submitted instructions are kept.');
      return false;
    } finally { requestInFlight.current = false; setSaving(false); }
  }
  async function startRun(intentOverride?: RunIntent) {
    if (requestInFlight.current) return;
    const intent: RunIntent | null = intentOverride ?? pendingRun ?? (draft && savedVersion && !dirty ? { schema: 1, requestId: crypto.randomUUID(), workflowId: draft.id, version: savedVersion } : null);
    if (!intent) return;
    if (!pendingRun) { try { persistWorkflowIntent('run', intent, storage.local); } catch (e) { setError(message(e)); return; } setPendingRun(intent); }
    requestInFlight.current = true; setStarting(true); setError('');
    try {
      const run = await api<Run>(`/api/workflows/${encodeURIComponent(intent.workflowId)}/runs`, { method: 'POST', body: JSON.stringify({ requestId: intent.requestId, version: intent.version }) });
      if (clearIntent('run', intent)) onRun(run.id);
      else setNotice('The run started. Resolve its browser record to open the recorded run.');
    } catch (e) { setError(message(e)); if (e instanceof ApiError && e.status >= 400 && e.status < 500) clearIntent('run', intent); }
    finally { requestInFlight.current = false; setStarting(false); }
  }
  function saveAsNew() { if (!draft || pendingSave) return; const next = { ...draft, id: crypto.randomUUID(), name: `${draft.name.slice(0, 150)} (copy)`, createdAt: new Date().toISOString() }; setDraft(next); setSavedVersion(null); setDirty(true); remember(next, step, null); setError(''); setNotice('This copy will be saved as a new workflow.'); }
  function removeBrowserDraft() {
    if (!draft || !clearRecovery()) return;
    const stored = local.drafts.find(d => d.id === draft.id); if (!stored) return;
    try { setLocal(removeDraft(stored.id, storage.local)); setDeleted(stored); closeNow(); setNotice('Browser draft removed.'); } catch (e) { setError(message(e)); remember(draft); }
  }
  function undoRemove() { if (!deleted) return; try { setLocal(saveDraft(deleted, storage.local)); setDeleted(null); setNotice('Browser draft restored.'); } catch (e) { setError(message(e)); } }
  const feedback = <>{(error || recoveryError) && <div className="module-alert" role="alert"><span>{[error, recoveryError].filter(Boolean).join(' ')}</span>{recoveryError && draft && <button onClick={() => remember(draft)}>Retry recovery</button>}</div>}{notice && <div className="module-notice" role="status"><span>{notice}</span>{deleted && !draft && <button onClick={undoRemove}><Undo2 size={13} /> Undo</button>}</div>}{pendingRun && <div className="module-notice" role="status"><span>A workflow start needs confirmation. Retry uses the same request and will open its recorded run.</span><button disabled={starting || saving} onClick={() => void startRun(pendingRun)}>{starting ? 'Checking…' : 'Resolve pending run'}</button></div>}</>;

  if (!draft) return <section className="module-page module-workflows">
    <div className="module-page-heading"><div><h1>Workflows</h1><p>{isHealthcare ? 'Repeatable referral work for your team.' : 'Saved instructions, ready to run.'}</p></div><div className="module-actions">{!isHealthcare && <button className="button secondary" onClick={() => onNavigate('schedules')}><CalendarDays size={15}/> Schedules</button>}<button className="button module-primary" onClick={() => openDraft()}><Plus size={15} /> New workflow</button></div></div>
    {feedback}
    {loadError && <div className="module-alert" role="alert"><span>Saved workflows could not be loaded. {loadError}</span><button onClick={() => void refresh()}>Retry</button></div>}
    <div className="module-library-heading"><span className="module-library-count">{workflows.length} saved {workflows.length === 1 ? 'workflow' : 'workflows'}</span><label className="module-search"><Search size={14} /><input aria-label="Search saved workflows" placeholder="Search workflows" value={filter} onChange={e => setFilter(e.target.value)} /></label></div>
    {loading ? <p className="empty-note" role="status">Loading saved workflows…</p> : workflows.length ? <div className="module-table-wrap"><table className="module-library"><thead><tr><th>Workflow</th><th>Start</th><th>Updated</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{visible.map(w => <tr key={w.id}><td><button className="module-row-title" onClick={() => openSaved(w)}><span className="module-row-icon"><GitBranch size={18} strokeWidth={1.5} /></span><span><strong>{w.name}</strong><small>Version {w.version}</small></span></button></td><td>Manual</td><td>{stamp(w.updatedAt)}</td><td><button className="module-open-row" aria-label={`Open ${w.name}`} onClick={() => openSaved(w)}><ChevronRight size={16} /></button></td></tr>)}</tbody></table>{visible.length === 0 && <p className="module-no-results">No workflows match your search.</p>}</div> : null}
    {browserDrafts.length > 0 && <div className="module-starters"><div className="module-section-label"><h2>Browser drafts</h2><span>Not saved to the workspace</span></div>{browserDrafts.map(d => <button className="module-template-row" key={d.id} onClick={() => openDraft(d)}><span className="module-row-icon"><FileText size={17} /></span><span><strong>{d.name}</strong><small>{d.description || 'Preserved in this browser'}</small></span><ChevronRight size={15} /></button>)}</div>}
    <details className="module-template-disclosure" open={!loading && workflows.length === 0 ? true : undefined}><summary><BookOpen size={14} /><span>{workflows.length ? 'Workflow templates' : 'Start with a template'}</span><ChevronRight size={14} /></summary><div>{!isHealthcare && <button className="module-template-row" onClick={() => openDraft(weeklyReviewDraft())}><span className="module-row-icon"><CalendarDays size={17}/></span><span><strong>Weekly review</strong><small>A weekly look at your connected accounts.</small></span><Plus size={15}/></button>}{orderedStarters.map(starter => <button className="module-template-row" key={starter.name} onClick={() => openDraft(undefined, starter)}><span className="module-row-icon"><BookOpen size={17} /></span><span><strong>{starter.name}</strong><small>{starter.description}</small></span><Plus size={15} /></button>)}</div></details>
  </section>;

  const locked = saving || Boolean(pendingSave);
  const canRun = Boolean((weekly ? selectedConnectionIds.length > 0 && managesConnections && workspace?.connectionsEnabled : workflowSourceIds(draft).length > 0) && savedVersion && !dirty && !locked && !starting && workspace?.provider.available && !workspace.activeRunId);
  const steps = weekly ? [
    { title: 'Schedule', subtitle: weeklySchedule?.status ?? 'Weekly', text: weeklySchedule?.label ?? 'Day, time and timezone', hint: 'Weekly timing', icon: CalendarDays },
    { title: 'Review', subtitle: `${selectedConnectionIds.length} selected ${selectedConnectionIds.length === 1 ? 'account' : 'accounts'}`, text: 'Key takeaways, performance and top content', hint: 'Accounts and report', icon: FileText },
    { title: 'Email', subtitle: weeklySchedule?.email ?? 'Your verified inbox', text: 'A short update from Rivet, linked to the full report', hint: 'Delivery and email activity', icon: Mail },
  ] : [
    { title: 'Start manually', subtitle: 'Manual trigger', text: 'On demand', hint: 'Start a run when you’re ready.', icon: Play },
    { title: 'Instructions', subtitle: 'Task', text: draft.fields.instructions || 'Describe the work for Rivet.', hint: 'Give Rivet a clear task and boundaries.', icon: BookOpen },
    { title: 'Create report', subtitle: 'Sourced output', text: draft.fields.output || 'Describe the report you want.', hint: 'Define what a useful result looks like.', icon: FileText },
    { title: 'Review checklist', subtitle: 'For your team', text: draft.fields.review || 'Add the checks for your team.', hint: 'Set out what a person should check.', icon: ShieldCheck },
  ];
  const fields = [
    { key: 'instructions', label: 'Working instructions', limit: 2400, rows: 10 },
    { key: 'output', label: 'Expected report', limit: 800, rows: 7 },
    { key: 'review', label: 'Review instructions', limit: 400, rows: 6 },
  ];
  const tabs = [{ id: 'canvas', label: weekly ? 'Workflow' : 'Canvas', icon: GitBranch }, ...(!weekly ? [{ id: 'configuration', label: 'Configuration', icon: SlidersHorizontal }] as const : []), { id: 'history', label: 'Run history', icon: History }] as const;
  const EditorShell = weekly ? 'div' : 'form';
  const StepIcon = steps[step].icon;
  const selectedSourceIds = workflowSourceIds(draft);
  const sourceCount = selectedSourceIds.length;
  const fileSelection = <ModuleSourceSelection sources={workspace?.sources ?? []} selectedIds={selectedSourceIds} onChange={ids => update('sourceIds', JSON.stringify(ids))} disabled={locked} onBrowse={() => onNavigate('sources')} />;
  const toolNames: Record<string, string> = { 'workspace.search': 'Find sources', 'workspace.read': 'Read sources', 'workspace.calculate_usage': 'Usage totals', 'workspace.calculate_financial': 'Financial totals', 'workspace.analyze_table': 'Analyze CSV' };
  const tools = workspace?.profile.tools ?? [];
  const saveStatus = pendingSave ? 'Save not confirmed' : dirty ? savedVersion ? 'Unsaved changes' : 'Unsaved workflow' : `Saved · v${savedVersion}`;
  const fieldControl = (field: typeof fields[number], index: number) => <div className="module-field" key={field.key}><label htmlFor={`workflow-field-${index + 1}`}>{field.label}</label><textarea id={`workflow-field-${index + 1}`} aria-describedby={`workflow-count-${index + 1}`} rows={field.rows} maxLength={field.limit} value={draft.fields[field.key] ?? ''} onChange={e => update(field.key, e.target.value)} /><small id={`workflow-count-${index + 1}`}>{(draft.fields[field.key] ?? '').length.toLocaleString()} / {field.limit.toLocaleString()} characters</small></div>;
  const nameControl = <div className="module-field"><label htmlFor="workflow-name">Workflow name</label><input id="workflow-name" value={draft.name} maxLength={160} onChange={e => update('name', e.target.value)} placeholder="Name your workflow" /></div>;
  const accountControl = managesConnections ? <><WeeklyReviewAccounts connections={connections} selectedIds={selectedConnectionIds} loading={connectionsLoading} error={connectionsError} onRetry={() => setConnectionsRevision(value => value + 1)} disabled={locked} onChange={connectionIds => update('weeklyReview', JSON.stringify({ connectionIds }))}/><button className="module-link" type="button" onClick={() => onNavigate('tables')}>Manage accounts <ArrowRight size={12}/></button></> : <p className="module-tiny">A workspace owner can set up connected accounts for this review.</p>;
  const periodControl = <div className="weekly-review-period"><strong>Reporting period</strong><span>Scheduled: previous seven full days in the schedule timezone.<br/>Run now: previous Monday–Sunday in UTC.</span><p className="module-tiny">Social counters describe content published in the period, not engagement earned in it. Website data keeps its provider reporting dates.</p></div>;
  return <section className={`module-detail module-workflows connected-workflow${weekly ? ' weekly-review-workflow' : ''}`} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); if (leavePrompt) keepEditing(); else close(); } }}>
    {feedback}
    {leavePrompt && <div className="module-leave-prompt" role="group" aria-labelledby="workflow-leave-title" ref={leaveRef} tabIndex={-1}><div><strong id="workflow-leave-title">Keep your changes?</strong><p>{pendingSave ? 'The pending save needs confirmation before leaving.' : 'Save this workflow or discard these edits.'}</p></div><div><button className="button secondary" onClick={keepEditing}>Keep editing</button><button className="button secondary" disabled={Boolean(pendingSave) || saving} onClick={() => leave(true)}>Discard changes</button><button className="button module-primary" disabled={saving} onClick={() => void saveWorkflow().then(ok => { if (ok) leave(); })}>{saving ? 'Saving…' : pendingSave ? 'Retry save and leave' : 'Save and leave'}</button></div></div>}
    <EditorShell className={weekly ? 'weekly-review-editor' : undefined} onSubmit={weekly ? undefined : e => void saveWorkflow(e)}>
      <header className="module-editor-heading module-compact-heading"><div className="module-editor-identity"><button className="module-back module-back-icon" type="button" onClick={close} aria-label="Back to workflows"><ArrowLeft size={17} /></button><div className="workflow-heading-copy"><h1 ref={headingRef} tabIndex={-1} title={draft.name || 'New workflow'}>{draft.name || 'New workflow'}</h1><span className="module-save-status workflow-identity-status" role="status"><GitBranch size={12} aria-hidden="true" />{weekly ? 'Weekly review' : 'Workflow'} <span aria-hidden="true">·</span> {saveStatus}</span></div></div><div className="module-actions"><button className={`button ${dirty || pendingSave ? 'module-primary' : 'secondary'}`} type={weekly ? 'button' : 'submit'} onClick={weekly ? () => void saveWorkflow() : undefined} disabled={saving || starting || (!dirty && !pendingSave)}>{saving ? 'Saving…' : pendingSave ? 'Retry same save' : dirty ? weekly ? 'Save review' : 'Save workflow' : <><Check size={13} /> Saved</>}</button><button className={`button ${dirty || pendingSave ? 'secondary' : 'module-primary'}`} type="button" disabled={!canRun || Boolean(pendingRun)} onClick={() => void startRun()}><Play size={13} />{starting ? weekly ? 'Getting latest data…' : 'Starting…' : weekly ? 'Run review' : 'Run workflow'}</button></div></header>
      <div className="workflow-toolbar"><div className="workflow-tabs" role="tablist" aria-label="Workflow views" onKeyDown={event => {
        const index = tabs.findIndex(tab => tab.id === editorTab);
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); setEditorTab(tabs[next].id); document.getElementById(`workflow-tab-${tabs[next].id}`)?.focus();
      }}>{tabs.map(tab => <button key={tab.id} id={`workflow-tab-${tab.id}`} type="button" role="tab" aria-selected={editorTab === tab.id} aria-controls={`workflow-panel-${tab.id}`} tabIndex={editorTab === tab.id ? 0 : -1} onClick={() => setEditorTab(tab.id)}><tab.icon size={14} aria-hidden="true" />{tab.label}{tab.id === 'history' && runs.length > 0 && <span>{runs.length}</span>}</button>)}</div></div>
      <div id="workflow-panel-canvas" role="tabpanel" aria-labelledby="workflow-tab-canvas" hidden={editorTab !== 'canvas'}>
        {editorTab === 'canvas' && <div className="module-editor-layout module-workflow-layout">
          <div className="module-flow-canvas">
            <div className="workflow-canvas-hint"><CircleDashed size={14} aria-hidden="true" /><span>Select a step to configure it</span></div>
            <div className="workflow-canvas-scroll" role="region" tabIndex={0} aria-label="Workflow canvas">
              <ol className="module-flow-nodes" style={{ zoom: zoom / 100 }}>
                {steps.map((item, index) => <li className="workflow-node-wrap" key={item.title}>
                  <button className={`module-flow-node ${step === index ? 'selected' : ''}`} type="button" aria-pressed={step === index} aria-controls="workflow-step-details" aria-label={`${item.title}, step ${index + 1} of ${steps.length}`} onClick={() => selectStep(index)}>
                    <span className="module-node-title">
                      <span className="module-node-icon"><item.icon size={18} aria-hidden="true" /></span>
                      <span className="module-node-label"><strong>{item.title}</strong><small>{item.subtitle}</small></span>
                      <span className="module-step-number">{String(index + 1).padStart(2, '0')}</span>
                    </span>
                    <span className="workflow-node-body">
                      {!weekly && index === 0 ? <span className="workflow-node-properties"><span><span>Start</span><strong>On demand</strong></span><span><span>Knowledge</span><strong>{sourceCount} selected {sourceCount === 1 ? 'file' : 'files'}</strong></span></span> : <span className="workflow-node-excerpt">{item.text}</span>}
                      {!weekly && index === 1 && tools.length > 0 && <span className="workflow-tool-chips" aria-label="Available tools">{tools.map(tool => <code key={tool} title={tool}>{toolNames[tool] ?? tool}</code>)}</span>}
                      {index === (weekly ? 1 : 2) && <span className="workflow-node-detail"><Link2 size={13} aria-hidden="true" />{weekly ? 'Latest connected data' : 'Links to the notes used'}</span>}
                      {index === 3 && <span className="workflow-node-detail"><UserRound size={13} aria-hidden="true" />For your team to review</span>}
                    </span>
                  </button>
                  {index < steps.length - 1 && <div className="workflow-node-connector" aria-hidden="true"><span /><ArrowDown size={13} /></div>}
                </li>)}
              </ol>
            </div>
            <div className="workflow-canvas-footer">
              <span><GitBranch size={13} aria-hidden="true" />{steps.length} steps</span>
              <div className="workflow-zoom" role="group" aria-label="Canvas zoom">
                <button type="button" disabled={zoom <= 70} onClick={() => setZoom(value => Math.max(70, value - 10))} aria-label="Zoom out"><Minus size={13} /></button>
                <button type="button" onClick={() => setZoom(100)} aria-label={`Canvas zoom ${zoom}%; reset to 100%`}>{zoom}%</button>
                <button type="button" disabled={zoom >= 130} onClick={() => setZoom(value => Math.min(130, value + 10))} aria-label="Zoom in"><Plus size={13} /></button>
              </div>
            </div>
          </div>
          <aside className="module-inspector workflow-step-inspector" id="workflow-step-details" aria-labelledby="workflow-step-title" tabIndex={-1}>
            <header className="workflow-inspector-heading">
              <span className="module-node-icon"><StepIcon size={18} aria-hidden="true" /></span>
              <div><span className="workflow-inspector-kicker">Step {String(step + 1).padStart(2, '0')} of {String(steps.length).padStart(2, '0')}</span><h2 id="workflow-step-title">{steps[step].title}</h2></div>
            </header>
            <p className="workflow-inspector-hint">{steps[step].hint}</p>
            {weekly ? <>
              <form onSubmit={e => void saveWorkflow(e)} hidden={step !== 1}><fieldset className="workflow-fields" disabled={locked}>{nameControl}{accountControl}{periodControl}<details className="weekly-review-customize"><summary>Review instructions</summary>{fieldControl(fields[0], 0)}{fieldControl(fields[1], 1)}{fieldControl(fields[2], 2)}</details></fieldset></form>
              <div hidden={step === 1}>{managesConnections ? <WorkflowSchedulesWorkspace key={draft.id} workspace={workspace} onRun={onRun} onNavigate={onNavigate} legacy={null} embedded={{workflow: savedVersion ? selectedSaved : null, view: step === 2 ? 'email' : 'schedule', disabled: dirty || locked || starting, onReview: () => selectStep(1), onSummary: setWeeklySchedule}}/> : <p className="module-tiny">A workspace owner can manage this review's schedule and email.</p>}</div>
              {step !== 0 && weeklySchedule?.nextRunAt && <p className="weekly-review-next module-tiny">Next scheduled run: <time dateTime={weeklySchedule.nextRunAt}>{new Date(weeklySchedule.nextRunAt).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: weeklySchedule.timezone, timeZoneName: 'short'})}</time></p>}
              {runs[0] && <button type="button" className="module-link weekly-review-last" onClick={() => onRun(runs[0].id)}>Last review: {statusText[runs[0].status]} · {stamp(runs[0].createdAt)} <ArrowRight size={13}/></button>}
            </> : <fieldset className="workflow-fields" disabled={locked}>
              {step === 0 ? <>
                {nameControl}
                <div className="workflow-start-details" id="workflow-field-0" tabIndex={-1}>
                  <h3>Trigger</h3><div className="workflow-read-field"><Play size={14} aria-hidden="true" /><span>Manual</span><span>On demand</span></div>
                  {fileSelection}
                </div>
              </> : fieldControl(fields[step - 1], step - 1)}
            </fieldset>}
            {!weekly && step === 1 && tools.length > 0 && <details className="workflow-tools-context"><summary>Available tools</summary><div className="workflow-tool-chips">{tools.map(tool => <code key={tool} title={tool}>{toolNames[tool] ?? tool}</code>)}</div><p>Rivet uses these with your selected files.</p></details>}
            {!weekly && step === 3 && <div className="workflow-review-note"><ShieldCheck size={15} aria-hidden="true" /><p>The checklist guides the report. Your team approves and shares it.</p></div>}
            <div className="workflow-inspector-bottom">
              {!workspace?.provider.available ? <div className="workflow-availability"><span className="module-tag">Rivet unavailable</span><button type="button" className="module-link" onClick={() => onNavigate(workspace?.profile.id === 'healthcare-operations' ? 'connections' : 'workspace')}>{workspace?.profile.id === 'healthcare-operations' ? 'Open connectors' : 'Open settings'} <ArrowRight size={12} /></button></div> : workspace.activeRunId ? <button type="button" className="module-link" onClick={() => onRun(workspace.activeRunId!)}>View the active task <ArrowRight size={12} /></button> : <button type="button" className="workflow-agent-summary" onClick={() => onNavigate(workspace?.profile.id === 'healthcare-operations' ? 'connections' : 'workspace')} aria-label="View Rivet service"><Bot size={17} aria-hidden="true" /><span><strong>{workspace.profile.name}</strong><small>Rivet available</small></span><ChevronRight size={13} aria-hidden="true" /></button>}
              {(weekly ? selectedConnectionIds.length === 0 : sourceCount === 0) && <p className="module-tiny">Choose {weekly ? 'accounts' : 'files'} before running.</p>}{dirty && <p className="module-tiny">Save changes before running.</p>}
              <details className="module-context-details"><summary>Workflow options <ChevronRight size={12} /></summary><p>Each run keeps its saved instructions, activity, and source-linked report.</p>{(savedVersion || error) && <button className="module-link" type="button" disabled={locked} onClick={saveAsNew}>Save a separate copy <Plus size={12} /></button>}{!savedVersion && local.drafts.some(d => d.id === draft.id) && <button className="module-link" type="button" disabled={locked} onClick={removeBrowserDraft}>Remove browser draft</button>}</details>
              {selectedSaved && selectedSaved.version !== savedVersion && <p className="module-inspector-copy">A newer saved version is available. Save a separate copy to preserve these edits.</p>}
            </div>
          </aside>
        </div>}
      </div>
      <div id="workflow-panel-configuration" role="tabpanel" aria-labelledby="workflow-tab-configuration" hidden={editorTab !== 'configuration'}>
        {editorTab === 'configuration' && !weekly && <div className="module-document workflow-configuration"><div className="module-document-heading"><h2>Workflow configuration</h2><p>Saved instructions and selected files.</p></div><fieldset className="workflow-fields" disabled={locked}>{nameControl}{fileSelection}{fields.map(fieldControl)}</fieldset><p className="module-tiny">Your team reviews the report before approving or sending anything.</p></div>}
      </div>
      <div id="workflow-panel-history" role="tabpanel" aria-labelledby="workflow-tab-history" hidden={editorTab !== 'history'}>
        {editorTab === 'history' && <section className="workflow-run-history" aria-label="Workflow run history"><div className="module-section-label"><h2>Run history</h2>{savedVersion && <button className="module-link" type="button" onClick={() => setHistoryRefresh(n => n + 1)}><RefreshCw size={12} /> Refresh</button>}</div>{historyError ? <p role="alert">{historyError}</p> : historyLoading ? <p role="status">Loading recorded runs…</p> : runs.length ? <div>{runs.map(run => <button className="workflow-history-row" type="button" key={run.id} onClick={() => onRun(run.id)}><FileText size={15} /><span><strong>{run.artifactTitle || draft.name}</strong><small>{stamp(run.createdAt)} · v{run.workflowVersion ?? '—'}</small></span><span className={`pill ${run.status}`}>{statusText[run.status]}</span><ChevronRight size={14} /></button>)}</div> : <div className="module-empty"><span className="module-empty-icon"><FileText size={23} strokeWidth={1.25} /></span><h2>No runs yet</h2><p>{savedVersion ? 'Run this saved workflow to create its first report.' : 'Save the workflow to run it.'}</p></div>}</section>}
      </div>
    </EditorShell>
  </section>;
}
