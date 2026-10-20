import { handleComposerKeyDown } from './composer-keyboard';
import { allowsManualImports, workspaceApiPath, workspaceBrowserStorage } from './workspace-scope';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import { Markdown } from './markdown';
import { sourceCalculationId, sourceTableKind } from '../../../packages/core/src/source-table';
import { CalculatedSourceTable } from './calculated-source';
import { SourceCsvTable } from './source-table';
import { Activity, ArrowLeft, ArrowRight, ArrowUp, BookOpen, Check, ChevronRight, Circle, FileText, FolderOpen, Layers3, Plus, RefreshCw, Search, Settings2, Square, X, PanelLeftClose, PanelLeftOpen, ShieldCheck, Download, Copy } from 'lucide-react';
import type { Run, RunUpdate, RunSummary, SourceDocument, WorkspaceStatus } from '../../../packages/core/src/types';
import { ApiError, api, accessErrorEvent, message, readSaved, saveLocal } from './api';
import { currentSignInUrl, canManageSources, SessionNotice, type WorkspaceSession } from './session-access';
import { HomeWelcome, homeModelLabel, sourceStarters } from './home-welcome';
import { HomeWork } from './home-work';
import { DesktopModelNotice } from './desktop-model-notice';
import { rememberTableSource } from './table-source-navigation';
import { TeamSources as TablesLibrary } from './team-sources';
import { UsageCsvImport } from './usage-import';
import { FinancialCsvImport } from './financial-import';
import { answerDocument, latestOutputRun } from './answer-export';
import { postPresentations } from '../../../packages/data-layer/src/tabular/post-presentation';
import type { NormalizedDataset } from '../../../packages/data-layer/src/tabular/types';
import type { UsageDatasetSummary, FinancialDatasetSummary } from '../../../packages/core/src/index';
import { FileUpload } from './file-upload';
import { SessionInputs, conversationInputIds, inputDraftKey, inputIds } from './session-inputs';
import { PanelResizeHandle, usePanelResize } from './panel-resize';

import { ModulePage, type ModuleView } from './modules';
import { WorkflowWorkspace, workspaceProfileStorage } from './workflow-workspace';
import { readWorkflowIntent, reportWorkflowDraft } from './workflow-state';
import { FIELD_KEYS, loadEditorRecovery, type WorkspaceDraft } from './draft-store';
import { ProjectsPage } from './projects';
import { WorkspaceDetails } from './workspace-details';
import { RunAllowance, remainingRuns } from './run-allowance';
import { VerificationPanel } from './verification-panel';
import { CalculationVerificationContext, DismissCalculationVerificationContext, type CalculationInspection } from './calculation-verification';
import { canonicalView, viewInfo, routeView, isView, type View } from './navigation';
import { mergeRunUpdate } from './run-updates';
import { refreshRunPage, appendRunPage, type RunPage } from './run-library';
import { taskTitle } from './run-presentation';
import { WorkspaceNavigation } from './workspace-navigation';
import { conversationId, parseSidebarPins, sidebarConversations, sidebarPinKey, sidebarSummary } from './sidebar-pins';
import { closeWorkspaceTabs, homeTab, rememberWorkspaceTab, workspaceTabIdentity, WorkspaceTabs, type WorkspaceTab, type WorkspaceTabClose, type WorkspaceTabPolicy } from './workspace-tabs';
import { CareWorkspace } from './care-workspace';
import { AgentSession } from './agent-session';
import { exampleRun, exampleSources } from './example-work';
import { TaskLibrary, ReviewPage, WorkspaceSearch } from './workspace-extras';
import './modules.css';
import './connectors.css';
import './shell.css';
import './navigation.css';
import './workspace.css';
import './home-workspace.css';
import './panel-resize.css';
import './visual-analysis.css';
import './financial-analysis.css';
import './tabular-analysis.css';
import './report-body.css';
import './tabular-presentation.css';
type DetailTab = 'verification' | 'context' | 'artifacts';
type PendingRequest = { requestId: string; task: string; sourceIds?: string[] };
function guardNavigation(proceed: () => void) {
  const event = new CustomEvent('rivetfields:before-navigate', { cancelable: true, detail: { proceed } });
  const allowed = window.dispatchEvent(event);
  if (allowed) proceed();
  return allowed;
}
const active = (run: { status: string } | null) => run?.status === 'queued' || run?.status === 'running';
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const date = (value: string) => new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
const statusLabel: Record<Run['status'], string> = { queued: 'Queued', running: 'Working', completed: 'Complete', cancelled: 'Stopped', failed: 'Failed', interrupted: 'Interrupted' };
function documentBody(content: string, title: string): string {
  const heading = content.match(/^\s*#{1,2}[ \t]+(.+?)[ \t]*\r?\n/);
  const normalize = (value: string) => value.replace(/[ \t]+#+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return heading && normalize(heading[1]) === normalize(title) ? content.slice(heading[0].length).replace(/^\s*\n/, '') : content;
}



export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceStatus | null>(null);
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [accessFailure, setAccessFailure] = useState<401|403|null>(null);
  const [runPage, setRunPage] = useState<RunPage>({runs:[],nextCursor:null});
  const {runs,nextCursor:nextRunCursor} = runPage;
  const sessionRoutes = useRef(new Map<string, string>());
  for (const item of runs) sessionRoutes.current.set(item.id, item.sessionId ?? item.id);
  const [loadingOlderRuns, setLoadingOlderRuns] = useState(false);
  const [olderRunsError, setOlderRunsError] = useState('');
  const olderRunsPending = useRef(false);
  const [requestedView, setView] = useState<View>(routeView);
  const view = workspace ? canonicalView(requestedView, workspace.profile.id === 'healthcare-operations') : requestedView;
  useEffect(() => {
    if (view === requestedView) return;
    const url = new URL(location.href);
    url.searchParams.set('view', view);
    history.replaceState(history.state, '', url);
    setView(view);
  }, [view, requestedView]);
  const [projectId,setProjectId] = useState<string|null>(()=>new URLSearchParams(location.search).get('project'));
  const [careCaseId, setCareCaseId] = useState<string | null>(() => new URLSearchParams(location.search).get('case'));
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(location.search).get('run'));
  const committedRoute = useRef({ href: location.href, state: history.state as unknown });
  useEffect(() => { committedRoute.current = { href: location.href, state: history.state }; }, [view, selectedId, careCaseId, projectId]);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const liveRunRef = useRef<Run | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [previousTurns, setPreviousTurns] = useState<Run[]>([]);
  const [workflowSeed, setWorkflowSeed] = useState<{profileId: string; draft: WorkspaceDraft} | null>(null);
  const [loading, setLoading] = useState(true);
  const [runLoading, setRunLoading] = useState(false);
  const [runRefresh, setRunRefresh] = useState(0);
  const [error, setError] = useState('');
  const [runError, setRunError] = useState('');
  const [task, setTask] = useState('');
  const [starterSeed, setStarterSeed] = useState(0);
  const [selectedInputs, setSelectedInputs] = useState<string[]>([]);
  const [draftProfile, setDraftProfile] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [resolvingRequest, setResolvingRequest] = useState<'check' | 'cancel' | null>(null);
  const [requestNotice, setRequestNotice] = useState('');
  const [stopping, setStopping] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>('verification');
  const [calculationInspection, setCalculationInspection] = useState<CalculationInspection>();
  const [sourceBehindInspection, setSourceBehindInspection] = useState(false);
  const inspectionRef = useRef(calculationInspection);
  // A retained source can outlive the nested inspection that opened it.
  const sourceOwnerRef = useRef<string | undefined>(undefined);
  inspectionRef.current = calculationInspection;
  const dismissCalculation = useCallback((ownerId: string) => {
    const ownsInspection = inspectionRef.current?.ownerId === ownerId;
    const ownsSource = sourceOwnerRef.current === ownerId;
    if (!ownsInspection && !ownsSource) return;
    if (ownsInspection) { inspectionRef.current = undefined; setCalculationInspection(undefined); }
    if (ownsSource) {
      sourceOwnerRef.current = undefined;
      sourceVersion.current++; setSourceId(null); setSource(null); setSourceError(''); setSourceLoading(false);
    }
    setShowEvidence(Boolean(inspectionRef.current)); setSourceBehindInspection(false);
  }, []);
  useEffect(() => { setCalculationInspection(undefined); setSourceBehindInspection(false); }, [selectedId, view, run?.id]);
  const [source, setSource] = useState<SourceDocument | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const [filter, setFilter] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);
  const readingResource = Boolean(selectedId || careCaseId || view === 'example');
  // Keep the analyst's navigation choice stable when opening or leaving work.
  // The opt-in care workspace retains its existing reading-focused behavior.
  useEffect(() => { if (workspace?.profile.id === 'healthcare-operations') setCollapsed(readingResource); }, [readingResource, workspace?.profile.id]);
  const [openTabs, setOpenTabs] = useState<WorkspaceTab[]>([homeTab]);
  const pendingTabFocus = useRef<{ key: string; profileId: string | undefined } | null>(null);
  const [tabNotice, setTabNotice] = useState('');
  const [showEvidence, setShowEvidence] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sourceHeadingRef = useRef<HTMLHeadingElement>(null);
  const sourceOpenerRef = useRef<HTMLElement | null>(null);
  const sourceOpenerIdentity = useRef<{ id: string; index: number } | null>(null);
  const sourceVersion = useRef(0);
  const evidenceOpenerRef = useRef<HTMLElement | null>(null);

  useEffect(()=>{
    const denied=(event:Event)=>{
      const status=(event as CustomEvent<{status:number}>).detail?.status;
      if(session?.mode!=='local'&&(status===401||status===403)) setAccessFailure(status);
    };
    window.addEventListener(accessErrorEvent,denied);
    return ()=>window.removeEventListener(accessErrorEvent,denied);
  },[session?.mode]);

  const refresh = useCallback(async () => {
    const nextSession=await api<WorkspaceSession>('/api/session');setSession(nextSession);
    const [nextWorkspace, nextRuns] = await Promise.all([api<WorkspaceStatus>('/api/workspace'), api<{ runs: RunSummary[]; nextCursor: string | null }>('/api/runs')]);
    setWorkspace(nextWorkspace);
    setRunPage(previous => refreshRunPage(previous,nextRuns));
    setError('');setAccessFailure(null);
  }, []);

  const refreshAllowance = useCallback(async () => {
    const budget = await api<WorkspaceStatus['runBudget'] | null>('/api/run-budget');
    setWorkspace(current => current ? {...current, runBudget: budget ?? undefined} : current);
  }, []);

  async function archiveSource(id: string, archived: boolean) {
    await api(`/api/sources/${encodeURIComponent(id)}/archive`, {method:'PATCH',body:JSON.stringify({archived})});
    await refresh();
  }
  const canArchiveSources = canManageSources(session);

  async function loadOlderRuns() {
    if (!nextRunCursor || olderRunsPending.current) return;
    olderRunsPending.current = true; setLoadingOlderRuns(true); setOlderRunsError('');
    try {
      const page = await api<{runs:RunSummary[];nextCursor:string|null}>(`/api/runs?before=${encodeURIComponent(nextRunCursor)}`);
      setRunPage(previous => appendRunPage(previous,page,nextRunCursor));
    } catch (error) { setOlderRunsError(message(error)); }
    finally { olderRunsPending.current = false; setLoadingOlderRuns(false); }
  }

  useEffect(() => { let mounted = true; refresh().catch((e) => { if (mounted) setError(message(e)); }).finally(() => { if (mounted) setLoading(false); }); return () => { mounted = false; }; }, [refresh]);
  // Restore only after the server identifies the workspace; old care drafts stay separate.
  const draftSuffix = workspace ? (workspace.profile.id === 'healthcare-operations' ? '' : '.neutral.v1') : null;
  useEffect(() => {
    if (draftSuffix === null || draftProfile === draftSuffix) return;
    setTask(readSaved(`rivetfields.task-draft${draftSuffix}`, ''));
    setSelectedInputs(inputIds(readSaved(`rivetfields.home-inputs${draftSuffix}`, [])));
    setPending(readSaved<PendingRequest | null>(`rivetfields.pending-request${draftSuffix}`, null));
    setDraftProfile(draftSuffix);
  }, [draftSuffix, draftProfile]);
  useEffect(() => {
    if (draftSuffix === null || draftProfile !== draftSuffix) return;
    saveLocal(`rivetfields.task-draft${draftSuffix}`, task);
    saveLocal(`rivetfields.home-inputs${draftSuffix}`, selectedInputs);
    saveLocal(`rivetfields.pending-request${draftSuffix}`, pending);
  }, [draftSuffix, draftProfile, task, pending, selectedInputs]);

  const selectRun = useCallback((id: string | null, nextTask?: string, after?: () => void, preserveTurn = false) => {
    if (id && !preserveTurn) id = sessionRoutes.current.get(id) ?? id;
    guardNavigation(() => {
    if (nextTask !== undefined) setTask(nextTask);
    sourceOwnerRef.current = undefined; sourceVersion.current++;
    setSelectedId(id); setCareCaseId(null); setView(id ? 'tasks' : 'assistant'); setRunError(''); setSourceId(null); setSource(null); setDetailTab('verification');
    const url = new URL(location.href); url.searchParams.delete('case'); url.searchParams.delete('project'); id ? url.searchParams.delete('view') : url.searchParams.set('view', 'assistant'); id ? url.searchParams.set('run', id) : url.searchParams.delete('run');
    history.pushState({}, '', url);
    if (!id) requestAnimationFrame(() => inputRef.current?.focus());
    after?.();
    });
  }, []);
  useEffect(() => {
    const onHistory = () => {
      const destination = { href: location.href, state: history.state as unknown };
      const previous = committedRoute.current;
      const allowed = guardNavigation(() => {
        // A resource editor can defer its proceed callback until the user
        // confirms. Keep the attempted destination, not the restored URL.
        if (location.href !== destination.href) history.pushState(destination.state, '', destination.href);
        committedRoute.current = destination;
        const parameters = new URL(destination.href).searchParams;
        setSelectedId(parameters.get('run')); setCareCaseId(parameters.get('case'));
        setProjectId(parameters.get('project'));
        setView(routeView()); closeSource(); setShowEvidence(false); setDetailTab('verification');
      });
      if (!allowed) {
        // History moved before popstate fired. Keep the mounted workspace and
        // restore its URL without adding an entry or discarding forward history.
        // The traversed entry now points to the guarded route; an explicit
        // deferred proceed still uses the captured destination above.
        history.replaceState(previous.state, '', previous.href);
      }
    };
    window.addEventListener('popstate', onHistory);
    return () => window.removeEventListener('popstate', onHistory);
  }, []);

  useEffect(() => {
    let disposed = false;
    let checkingSession = false;
    let stream: EventSource | undefined;
    const controller = new AbortController();
    const sameConversation = liveRunRef.current && (liveRunRef.current.id === selectedId || liveRunRef.current.sessionId === selectedId);
    if (!sameConversation) { liveRunRef.current = null; setRun(null); setPreviousTurns([]); }
    setRunError('');
    if (!selectedId) { setRunLoading(false); return; }
    setRunLoading(true);
    async function loadRun() {
      try {
        const conversation = await api<{turns: Run[]}>(`/api/runs/${encodeURIComponent(selectedId!)}/session`, { signal: controller.signal });
        let current = conversation.turns.at(-1)!;
        if (disposed) return;
        setPreviousTurns(conversation.turns.slice(0, -1));
        liveRunRef.current = current; setRun(current); setRunError(''); setRunLoading(false);
        if (!active(current)) { void refresh().catch(e => !disposed && setError(message(e))); return; }
        const cursor = current.events.at(-1)?.sequence ?? 0;
        stream = new EventSource(workspaceApiPath(`/api/runs/${encodeURIComponent(current.id)}/events?after=${cursor}`));
        stream.onopen = () => { if (!disposed) setRunError(''); };
        stream.onmessage = event => {
          if (disposed) return;
          try {
            const update = JSON.parse(event.data) as RunUpdate;
            current = mergeRunUpdate(liveRunRef.current?.id === current.id ? liveRunRef.current : current, update);
            liveRunRef.current = current;
            setRun(current); setRunError('');
            if (!active(current) && !update.hasMore) {
              stream?.close();
              void refresh().catch(e => !disposed && setError(message(e)));
            }
          } catch (error) { stream?.close(); setRunError(message(error)); }
        };
        stream.onerror = () => {
          if(disposed) return;
          setRunError('Live connection interrupted. Reconnecting to the saved task…');
          if(checkingSession) return;
          checkingSession=true;
          void api<WorkspaceSession>('/api/session').catch(cause=>{
            if(!disposed&&cause instanceof ApiError&&(cause.status===401||cause.status===403)) {stream?.close();setRunError(message(cause));}
          }).finally(()=>{checkingSession=false;});
        };
      } catch (e) { if (!disposed) { setRunError(message(e)); setRunLoading(false); } }
    }
    void loadRun();
    return () => { disposed = true; controller.abort(); stream?.close(); };
  }, [selectedId, refresh, runRefresh]);

  useEffect(() => {
    if (!workspace?.activeRunId || selectedId === workspace.activeRunId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function updateBackgroundTask() {
      try { await refresh(); }
      catch (e) { if (!disposed) setError(message(e)); }
      if (!disposed) timer = setTimeout(updateBackgroundTask, 2500);
    }
    timer = setTimeout(updateBackgroundTask, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [workspace?.activeRunId, selectedId, refresh]);

  async function reloadRun() {
    if (!selectedId) return;
    setRunRefresh((value) => value + 1);
  }

  async function startRun(event?: FormEvent) {
    event?.preventDefault();
    if (uploading || sending || resolvingRequest || (!pending && (!task.trim() || !workspace?.provider.available || workspace.activeRunId || remainingRuns(workspace.runBudget) === 0))) return;
    const request = pending ? { ...pending, ...(workspace?.profile.id === 'healthcare-operations' ? {} : {sourceIds: pending.sourceIds ?? []}) } : { task: task.trim(), requestId: crypto.randomUUID(), ...(workspace?.profile.id === 'healthcare-operations' ? {} : {sourceIds: [...selectedInputs]}) };
    setPending(request); setSending(true); setError(''); setRequestNotice('');
    try {
      const next = await api<Run>('/api/runs', { method: 'POST', body: JSON.stringify(request) });
      setPending(null); setTask(''); setSelectedInputs([]); setRun(next); selectRun(next.id);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) setPending(null);
      if (e instanceof ApiError && e.code === 'daily_run_limit') { try { await refresh(); } catch { /* Preserve the admission error and draft if refresh also fails. */ } }
      setError(message(e));
    } finally { setSending(false); }
  }

  async function resolvePendingRequest(action: 'check' | 'cancel') {
    if (!pending || sending || resolvingRequest) return;
    const request = pending;
    setResolvingRequest(action); setError(''); setRequestNotice('');
    try {
      const found = action === 'cancel'
        ? await api<Run>('/api/run-requests/cancel', {method:'POST',body:JSON.stringify(request)})
        : (await api<{run:Run|null}>(`/api/run-requests/${encodeURIComponent(request.requestId)}`)).run;
      if (!found) { setRequestNotice('No task is recorded yet. You can retry the same request or cancel it to edit your draft.'); return; }
      setTask(request.task); setSelectedInputs(request.sourceIds ?? []); setPending(null);
      if (action === 'check' || found.status === 'completed') { setRun(found); selectRun(found.id); }
      else setRequestNotice(`${found.status === 'cancelled' ? 'Request cancelled.' : 'Request resolved.'} Your draft and attached files are ready to edit. Any saved results remain in Tasks.`);
      await refresh();
    } catch (error) { setError(message(error)); }
    finally { setResolvingRequest(null); }
  }

  async function continueRun(prompt: string, requestId?: string, sourceIds: string[] = [], parentRunId?: string) {
    if (!run || !requestId) throw new Error('Reload this task before continuing.');
    const routeId = selectedId;
    const next = await api<Run>('/api/runs', { method: 'POST', body: JSON.stringify({ task: prompt, requestId, parentRunId: parentRunId ?? run.id, ...(run.profileId === 'healthcare-operations' ? {} : {sourceIds}) }) });
    if (selectedIdRef.current === routeId) {
      // Keep the existing route and tab. The session endpoint restores all turns on reload.
      // An uncertain retry may return an earlier accepted turn. Reload the
      // conversation without briefly replacing a newer answer with that turn.
      if (next.id !== run.id && !previousTurns.some(turn => turn.id === next.id)) {
        setPreviousTurns(turns => [...turns, run]);
        liveRunRef.current = next; setRun(next);
      }
      setRunRefresh(value => value + 1);
    }
    void refresh().catch(e => setError(message(e)));
  }

  async function retryExplanation(id: string, requestId: string) {
    if (!run) throw new Error('Reload this task before retrying.');
    const routeId = selectedId;
    const next = await api<Run>(`/api/runs/${encodeURIComponent(id)}/retry-explanation`, {method:'POST',body:JSON.stringify({requestId})});
    if (selectedIdRef.current === routeId) {
      if (next.id !== run.id && !previousTurns.some(turn => turn.id === next.id)) {
        setPreviousTurns(turns => [...turns, run]);
        liveRunRef.current = next; setRun(next);
      }
      setRunRefresh(value => value + 1);
    }
    void refresh().catch(e => setError(message(e)));
  }

  async function stopRun() {
    if (!run || stopping) return;
    const id = run.id;
    const routeId = selectedId;
    setStopping(true); setRunError('');
    try {
      const next = await api<Run>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
      if (selectedIdRef.current === routeId) { liveRunRef.current = next; setRun(next); }
      await refresh();
    }
    catch (e) { if (selectedIdRef.current === routeId) setRunError(`Could not confirm the stop. ${message(e)}`); }
    finally { setStopping(false); }
  }

  async function openSource(id: string, ownerId?: string) {
    sourceOwnerRef.current = ownerId;
    setSourceBehindInspection(false);
    setShowEvidence(true);
    if (!sourceId) {
      const active = document.activeElement;
      sourceOpenerRef.current = active instanceof HTMLElement && active !== document.body && active !== document.documentElement && active.tabIndex >= 0 && active.dataset.sourceId === id ? active : null;
      const matches = [...document.querySelectorAll<HTMLElement>('button[data-source-id]')].filter(button => button.dataset.sourceId === id);
      sourceOpenerIdentity.current = { id, index: Math.max(0, matches.indexOf(sourceOpenerRef.current!)) };
    }
    const version = ++sourceVersion.current;
    setSourceId(id); setSource(null); setSourceError(''); setSourceLoading(true);
    try { const document = (view === 'example' ? exampleSources.find(item => item.id === id) : undefined) ?? await api<SourceDocument>(`/api/sources/${encodeURIComponent(id)}`); if (version === sourceVersion.current) setSource(document); }
    catch (e) { if (version === sourceVersion.current) setSourceError(message(e)); }
    finally { if (version === sourceVersion.current) { setSourceLoading(false); requestAnimationFrame(() => sourceHeadingRef.current?.focus()); } }
  }

  function closeSource() {
    sourceOwnerRef.current = undefined;
    setSourceBehindInspection(false);
    sourceVersion.current++; setSourceId(null); setSource(null); setSourceError('');
    const opener = sourceOpenerRef.current, identity = sourceOpenerIdentity.current;
    requestAnimationFrame(() => {
      const focus = (element: HTMLElement | null | undefined) => {
        if (!element?.isConnected || element === document.body || element === document.documentElement) return false;
        element.focus(); return document.activeElement === element;
      };
      if (focus(opener)) return;
      const matches = identity ? [...document.querySelectorAll<HTMLElement>('button[data-source-id]')].filter(button => button.dataset.sourceId === identity.id) : [];
      if (focus(matches[identity?.index ?? 0]) || matches.some(focus)) return;
      if (!focus(document.getElementById('evidence-toggle'))) focus(document.getElementById('main-content'));
    });
  }
  function closeEvidence() {
    setShowEvidence(sourceBehindInspection); setCalculationInspection(undefined);
    setSourceBehindInspection(false);
    if (sourceId && !sourceBehindInspection) { closeSource(); return; }
    requestAnimationFrame(() => {
      const opener = evidenceOpenerRef.current;
      (opener?.isConnected ? opener : document.getElementById('evidence-toggle') ?? document.getElementById('main-content'))?.focus({ preventScroll: true });
    });
  }
  function openVerification() {
    sourceOwnerRef.current = undefined;
    setSourceBehindInspection(false);
    setCalculationInspection(undefined);
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('#workspace-context-panel')) evidenceOpenerRef.current = document.activeElement;
    if (sourceId) { sourceVersion.current++; setSourceId(null); setSource(null); setSourceError(''); }
    setDetailTab('verification'); setShowEvidence(true);
    requestAnimationFrame(() => document.getElementById('verification-heading')?.focus({ preventScroll: true }));
  }
  function inspectCalculation(inspection: CalculationInspection, opener?: HTMLElement) {
    const ownerId = inspection.ownerId ?? (sourceId ? sourceOwnerRef.current : undefined);
    if (sourceId && (!opener || opener.closest('.source-document'))) {
      setSourceBehindInspection(true); setDetailTab('verification'); setShowEvidence(true);
    } else openVerification();
    if (opener) evidenceOpenerRef.current = opener;
    setCalculationInspection({ ...inspection, ownerId });
  }
  async function refreshEvidence() {
    const evidenceRun = latestOutputRun(run, previousTurns) ?? run;
    if (!evidenceRun || active(evidenceRun)) return;
    const routeId = selectedId;
    const updated = await api<Run>(`/api/runs/${encodeURIComponent(evidenceRun.id)}`);
    if (selectedIdRef.current !== routeId) return;
    if (updated.id === run?.id) { liveRunRef.current = updated; setRun(updated); }
    else setPreviousTurns(turns => turns.map(turn => turn.id === updated.id ? updated : turn));
  }
  function navigate(next: View, after?: () => void) { guardNavigation(() => { setView(next); setProjectId(null); closeSource(); setShowEvidence(false); setDetailTab('verification'); setSelectedId(null); setCareCaseId(null); const url = new URL(location.href); url.searchParams.delete('run'); url.searchParams.delete('project'); url.searchParams.delete('case'); url.searchParams.delete('file'); url.searchParams.delete('sourceConnection'); next === 'home' ? url.searchParams.delete('view') : url.searchParams.set('view', next); history.pushState({}, '', url); requestAnimationFrame(() => { window.scrollTo({top:0}); document.getElementById('main-content')?.focus({preventScroll:true}); }); after?.(); }); }
  function openCareCase(id: string | null, after?: () => void) { guardNavigation(() => { setView('home'); setSelectedId(null); setCareCaseId(id); closeSource(); const url = new URL(location.href); url.searchParams.delete('run'); url.searchParams.delete('view'); id ? url.searchParams.set('case', id) : url.searchParams.delete('case'); history.pushState({}, '', url); requestAnimationFrame(() => { window.scrollTo({ top: 0 }); document.getElementById('main-content')?.focus({ preventScroll: true }); }); after?.(); }); }
  function usePrompt(prompt: string, sourceIds: string[] = []) { if (pending) { setError('Resolve the pending task request before replacing its draft.'); return; } selectRun(null, prompt, () => setSelectedInputs(inputIds(sourceIds))); }
  function askWithSource(sourceId: string) {
    if (pending) throw new Error('Resolve the pending task request before adding a file. Your draft is still saved.');
    if (!selectedInputs.includes(sourceId) && selectedInputs.length >= 100) throw new Error('Remove a file from your draft before attaching another.');
    selectRun(null, undefined, () => setSelectedInputs(current => inputIds([...current, sourceId])));
  }
  function openProject(id: string|null, after?: () => void) { navigate('projects',()=>{setProjectId(id);const url=new URL(location.href);id?url.searchParams.set('project',id):url.searchParams.delete('project');history.replaceState({},'',url);after?.();}); }
  function prepareUsageReport(summary: UsageDatasetSummary) {
    usePrompt(`Review “${summary.source.title}” from ${summary.sourceName} for ${summary.period.from} through ${summary.period.through} UTC.${summary.period.from >= '0001-01-08' ? ' Compare with the previous week.' : ''} Include a chart, the key changes and their evidence. Flag missing data or duplicate records, and separate observations from explanations.`, [summary.source.id]);
  }
  function prepareFinancialReport(summary: FinancialDatasetSummary) {
    usePrompt(`Review “${summary.source.title}” from ${summary.sourceName} for ${summary.period.from} through ${summary.period.through} UTC. Use its saved financial dataset to calculate revenue, cost, gross profit and gross margin. Compare with the preceding period of the same length when available. Cite the calculation, flag missing coverage and separate observed changes from unsupported explanations.`, [summary.source.id]);
  }
  useEffect(() => { const shortcut = (event: globalThis.KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(value => !value); } }; window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut); }, []);
  const artifactRun = run?.result ? run : previousTurns.findLast(turn => turn.result) ?? run;
  const answerRun = latestOutputRun(run, previousTurns);
  function createReportWorkflow() {
    if (!artifactRun?.result) return;
    try {
      const draft = reportWorkflowDraft(artifactRun, conversationInputIds(artifactRun, artifactRun.sources ?? workspace?.sources ?? []));
      navigate('workflows', () => setWorkflowSeed({profileId: artifactRun.profileId, draft}));
    } catch (error) { setRunError(message(error)); }
  }
  async function exportedBrief() {
    const selected = view === 'example' ? exampleRun : answerRun;
    if (!selected) return null;
    const output = selected.result ?? selected.reply;
    const analysis = output?.tabularAnalysis;
    if (analysis && !analysis.postLabels && analysis.result.request.groupBy === 'post' && view !== 'example') {
      const saved = await api<{dataset: NormalizedDataset}>(`/api/datasets/tabular/${encodeURIComponent(analysis.result.datasetId)}`);
      const enriched = {...output!,tabularAnalysis:{...analysis,postLabels:Object.fromEntries(postPresentations(saved.dataset,analysis.result))}};
      return answerDocument({...selected,...(selected.result ? {result:enriched as NonNullable<Run['result']>} : {reply:enriched})},workspace?.sources);
    }
    return answerDocument(selected, workspace?.sources, view === 'example');
  }
  async function downloadBrief() {
    try {
      if (view !== 'example' && answerRun) {
        const link = document.createElement('a');
        link.href = workspaceApiPath(`/api/runs/${encodeURIComponent(answerRun.id)}/answer.md`);
        link.download = ''; document.body.append(link); link.click(); link.remove();
        return;
      }
      const brief = await exportedBrief(); if (!brief) return;
      const url = URL.createObjectURL(new Blob([brief.content], { type: 'text/markdown' }));
      const link = document.createElement('a'); link.href = url;
      link.download = `${brief.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 70)}.md`;
      link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('The saved evidence could not be loaded. Try the download again.'); }
  }
  async function copyBrief() {
    try { const brief = await exportedBrief(); if (!brief) return; await navigator.clipboard.writeText(brief.content); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setError('Copy was unavailable. You can download the brief instead.'); }
  }
  function newTask() { if (pending) { setError('Resolve the pending task request before starting a new draft.'); return; } selectRun(null, '', () => { setSelectedInputs([]); setStarterSeed(seed => seed + 1); }); requestAnimationFrame(() => inputRef.current?.focus()); }
  function tabKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs: DetailTab[] = ['context', 'artifacts'];
    const index = tabs.indexOf(detailTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setDetailTab(tabs[next]); document.getElementById(`tab-${tabs[next]}`)?.focus();
  }

  const visibleSources = workspace?.sources.filter((s) => `${s.title} ${s.path}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const taskSources = run?.sources ?? workspace?.sources ?? [];
  const runWorking = active(run);
  const blocked = !workspace?.provider.available || Boolean(workspace.activeRunId) || remainingRuns(workspace?.runBudget) === 0;
  const context = <div className="context-body">
    <section><span className="eyebrow">Workspace agent</span><h3>Rivet</h3><p>{workspace?.profile.description ?? 'Connect to the local server to see Rivet’s purpose.'}</p></section>
    <section><span className="eyebrow">Rivet service</span><div className="model-name"><span className={`status-dot ${workspace?.provider.available ? 'ready' : ''}`} /><strong>{homeModelLabel(workspace?.provider)}</strong></div>{!workspace?.provider.available && workspace && <button className="text-button" onClick={() => navigate(workspace.profile.id === 'healthcare-operations' ? 'connections' : 'workspace')}>Check service <ArrowRight size={13} /></button>}</section>
    <section><span className="eyebrow">Available tools</span><div className="tool-list">{workspace?.profile.tools.map((tool) => <div key={tool}><Settings2 size={13} /><span>{tool.replaceAll('_', ' ')}</span></div>)}</div></section>
    <section><div className="section-label"><span className="eyebrow">{run ? 'Sources for this task' : 'Local sources'}</span><span>{taskSources.length}</span></div><span className="sample-label">{run ? 'Saved source snapshots' : 'Approved local notes'}</span><div className="source-links">{taskSources.map((item) => <button key={item.id} data-source-id={item.id} onClick={() => void openSource(item.id)}><FileText size={14} /><span>{item.title}</span><ChevronRight size={12} /></button>)}</div></section>
    {run && <section><span className="eyebrow">This run</span><dl><dt>Started</dt><dd>{date(run.createdAt)} · {time(run.createdAt)}</dd><dt>Step limit</dt><dd>{run.limits.maxSteps}</dd><dt>Time limit</dt><dd>{Math.round(run.limits.timeoutMs / 1000)} seconds</dd><dt>Input tokens</dt><dd>{run.usage.inputTokens?.toLocaleString() ?? 'Not reported'}</dd><dt>Output tokens</dt><dd>{run.usage.outputTokens?.toLocaleString() ?? 'Not reported'}</dd></dl></section>}
  </div>;

  const healthcare = workspace?.profile.id === 'healthcare-operations';
  const outputLabel = run ? (run.profileId === 'healthcare-operations' ? 'Administrative handoff brief' : 'Research brief') : workspace?.profile.outputLabel ?? 'Research brief';
  const suggestions = workspace?.profile.suggestions ?? ['Summarize the priorities and open questions in our quarterly planning notes. Cite the sources for each point.', 'Review the finance handoff notes and prepare a short brief on the next steps and who owns them. Follow the team writing guide and cite your sources.'];
  const currentView = viewInfo(view);
  const moduleView = !['home','assistant','tasks','artifacts','reports','sources','connections','workspace','review','care-worklist','care-benchmarks','example'].includes(view);
  const careView = healthcare && ['home','care-worklist','care-benchmarks','connections'].includes(view);
  const selectedTask = view === 'tasks' && Boolean(selectedId);
  const displayedRun = selectedTask && run && (run.id === selectedId || run.sessionId === selectedId) ? run : null;
  const projectWorkspace = !healthcare && ((view === 'projects' && Boolean(projectId)) || (selectedTask && Boolean(run?.projectId)));
  const exampleView = view === 'example';
  const hasContext = Boolean(calculationInspection) || (['home','assistant','sources','projects','tables','dashboards'].includes(view) && Boolean(sourceId)) || (selectedTask && showEvidence) || (exampleView && showEvidence);
  const contextContainer = useRef<HTMLDivElement>(null);
  const contextResize = usePanelResize({ storageKey: 'rivetfields.panel-width.evidence.v2', defaultWidth: 340, minWidth: 260, maxWidth: 680, containerRef: contextContainer, minimumRemainingWidth: 300, enabled: hasContext });
  const sidebarResize = usePanelResize({ storageKey: 'rivetfields.sidebar-width.v1', defaultWidth: 244, minWidth: 196, maxWidth: 320, containerRef: appRef, minimumRemainingWidth: 720, enabled: !collapsed, desktopMinContainerWidth: 1000 });
  const requestSummary = run ? taskTitle(run).replace(/\s+/g, ' ').trim() : '';
  const shortRequest = requestSummary.length > 200 ? `${requestSummary.slice(0, 197).replace(/\s+\S*$/, '')}…` : requestSummary;
  if (run) sessionRoutes.current.set(run.id, run.sessionId ?? run.id);
  const currentTab = workspaceTabIdentity(careCaseId ? { key: `case:${careCaseId}`, view: 'home', caseId: careCaseId, title: careCaseId }
    : selectedTask ? { key: `run:${selectedId}`, view: 'tasks', runId: selectedId!, title: (displayedRun ? previousTurns[0]?.result?.title || (previousTurns[0] ? taskTitle(previousTurns[0]).split('\n')[0] : '') || displayedRun.result?.title || taskTitle(displayedRun).split('\n')[0] : 'Task').slice(0, 100) }
    : { key: view, view, title: exampleView ? 'October planning brief' : currentView.label, ...(view === 'projects' && projectId ? { projectId } : {}) }, { healthcare, runSessions: sessionRoutes.current });
  function tabPolicy(tabs: WorkspaceTab[]): WorkspaceTabPolicy {
    const protectedKeys = new Set<string>(['home']), completedKeys = new Set<string>();
    const policy = { healthcare, protectedKeys, completedKeys, runSessions: sessionRoutes.current };
    if (!workspace) { tabs.forEach(tab => protectedKeys.add(tab.key)); return policy; }
    const profile = workspace.profile.id, stores = workspaceProfileStorage(profile);
    const conversations = new Map(sidebarConversations([...runs, ...(run ? [sidebarSummary(run)] : [])]).map(item => [conversationId(item), item]));
    let pins: string[] | null = null;
    try { const raw = workspaceBrowserStorage().getItem(sidebarPinKey(profile)); const value: unknown = raw ? JSON.parse(raw) : []; if (!Array.isArray(value)) throw Error(); pins = parseSidebarPins(value); }
    catch { /* Unknown pin state keeps run views open. */ }
    const hasRecord = (key: string) => { const raw = workspaceBrowserStorage().getItem(key); const value: unknown = raw ? JSON.parse(raw) : null; return value !== null && (typeof value !== 'string' || Boolean(value.trim())); };
    for (const opened of tabs) {
      const tab = workspaceTabIdentity(opened, policy);
      if (tab.runId) {
        const sessionId = sessionRoutes.current.get(tab.runId) ?? tab.runId;
        const saved = conversations.get(sessionId);
        const activeId = workspace.activeRunId && (sessionRoutes.current.get(workspace.activeRunId) ?? workspace.activeRunId);
        if (!saved || active(saved) || activeId === sessionId || pins === null || pins.includes(sessionId)) protectedKeys.add(tab.key);
        if (saved?.status === 'completed' && !saved.error) completedKeys.add(tab.key);
      } else if (tab.caseId) protectedKeys.add(tab.key);
      if (['home', 'assistant'].includes(tab.view) && (pending || sending || uploading || task.trim() || selectedInputs.length)) protectedKeys.add(tab.key);
      try {
        if (tab.runId) {
          const sessionId = sessionRoutes.current.get(tab.runId) ?? tab.runId;
          const saved = conversations.get(sessionId);
          for (const id of new Set([sessionId, tab.runId, saved?.id].filter((id): id is string => Boolean(id)))) {
            const raw = workspaceBrowserStorage().getItem(`rivetfields.followup.${profile}.${id}`);
            const followup = raw ? JSON.parse(raw) as { task?: string; requestId?: string } | null : null;
            if (followup && (typeof followup.task !== 'string' || typeof followup.requestId !== 'string' || followup.task.trim() || followup.requestId)) protectedKeys.add(tab.key);
          }
          const raw = workspaceBrowserStorage().getItem(inputDraftKey(profile, sessionId));
          if (raw && inputIds(JSON.parse(raw)).length) protectedKeys.add(tab.key);
        }
        if (Object.hasOwn(FIELD_KEYS, tab.view) && loadEditorRecovery(tab.view as ModuleView, stores.recovery)) protectedKeys.add(tab.key);
        if (tab.view === 'workflows' && (readWorkflowIntent('save', stores.local) || readWorkflowIntent('run', stores.local) || workflowSeed)) protectedKeys.add(tab.key);
        if (tab.view === 'schedules' && stores.local.getItem('rivetfields.schedule-editor.v1') !== null) protectedKeys.add(tab.key);
        if (tab.view === 'projects' && (hasRecord(`rivetfields.project-editor.${profile}`) || hasRecord(`rivetfields.project-task.${profile}.${tab.projectId ?? 'none'}.pending`) || hasRecord(`rivetfields.project-task.${profile}.${tab.projectId ?? 'none'}`))) protectedKeys.add(tab.key);
      } catch { protectedKeys.add(tab.key); }
    }
    return policy;
  }
  useEffect(() => { if (workspace) setOpenTabs(tabs => rememberWorkspaceTab(tabs, currentTab, tabPolicy([...tabs, currentTab]))); }, [currentTab.key, currentTab.title, currentTab.view, currentTab.runId, currentTab.projectId, workspace?.profile.id]);
  useLayoutEffect(() => {
    const target = pendingTabFocus.current;
    if (!target) return;
    if (target.key !== currentTab.key || target.profileId !== workspace?.profile.id) { pendingTabFocus.current = null; return; }
    // Restore only after the surviving tab is rendered, after navigation's focus callbacks.
    const frame = requestAnimationFrame(() => {
      if (pendingTabFocus.current !== target) return;
      pendingTabFocus.current = null;
      document.querySelector<HTMLButtonElement>('.workspace-resource-tabs [aria-current="page"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [currentTab.key, openTabs, workspace?.profile.id]);
  function openTab(tab: WorkspaceTab, after?: () => void) {
    if (tab.key === currentTab.key) { after?.(); return; }
    if (tab.caseId) openCareCase(tab.caseId, after);
    else if (tab.runId) selectRun(tab.runId, undefined, after, true);
    else if (tab.projectId) openProject(tab.projectId, after);
    else navigate(tab.view, after);
  }
  function closeViews(action: WorkspaceTabClose) {
    const change = closeWorkspaceTabs(openTabs, currentTab.key, action, tabPolicy(openTabs));
    if (!change.closed) { setTabNotice('Running, pinned or unfinished views were kept open.'); return; }
    const closing = new Set(openTabs.filter(tab => !change.tabs.includes(tab)).map(tab => tab.key));
    const remove = () => {
      pendingTabFocus.current = { key: change.current, profileId: workspace?.profile.id };
      setOpenTabs(tabs => { const policy = tabPolicy(tabs); return tabs.filter(tab => !closing.has(tab.key) || policy.protectedKeys?.has(tab.key)); });
      setTabNotice('Views closed. Running, pinned and unfinished work was kept open.');
    };
    if (change.current !== currentTab.key) openTab(change.tabs.find(tab => tab.key === change.current) ?? homeTab, remove);
    else remove();
  }
  const navigationView = projectWorkspace ? 'projects' : selectedTask ? 'tasks' : view === 'assistant' && !healthcare ? 'home' : view;
  const verificationRun = calculationInspection
    ? [run, ...previousTurns].find(item => item?.id === calculationInspection.runId) ?? undefined
    : exampleView ? exampleRun : run?.reply || !artifactRun?.result ? run ?? undefined : artifactRun ?? undefined;
  return <CalculationVerificationContext.Provider value={inspectCalculation}><DismissCalculationVerificationContext.Provider value={dismissCalculation}><div ref={appRef} style={{ '--workspace-sidebar-width': `${sidebarResize.width}px` } as CSSProperties} className={`rivet-app expanded-workspace ${collapsed ? 'sidebar-collapsed' : ''} ${selectedTask || exampleView ? 'reading-run' : ''}`}>
    <WorkspaceSearch healthcare={healthcare} open={searchOpen} onClose={() => setSearchOpen(false)} runs={runs} sources={workspace?.sources ?? []} onNavigate={navigate} onRun={selectRun} onSource={(id) => navigate('sources', () => { void openSource(id); })} />
    <a className="skip-link" href="#main-content">Skip to workspace</a>
    <WorkspaceNavigation key={workspace?.profile.id} profileId={workspace?.profile.id} ready={Boolean(workspace) || !loading} view={navigationView} selectedId={selectedTask ? currentTab.runId ?? selectedId : null} runs={runs} liveRun={displayedRun ? sidebarSummary(displayedRun) : null} healthcare={healthcare} hosted={session ? session.mode === 'authenticated' : undefined} session={session} onSwitchWorkspace={() => guardNavigation(() => location.assign('/workspaces'))} onSignOut={session?.mode==='authenticated'?()=>{guardNavigation(()=>location.assign(session.signOutUrl));}:undefined} collapsed={collapsed} onCollapse={() => setCollapsed(!collapsed)} onNavigate={navigate} onRun={selectRun} onNew={newTask} onSearch={() => setSearchOpen(true)}/>
    <PanelResizeHandle panel={sidebarResize} side="left" controls="workspace-sidebar" label="Resize navigation sidebar" className="workspace-sidebar-resizer"/>


    <div className="workspace-shell">
      <header className="workspace-top">
        {projectWorkspace ? <span className="workspace-heading">Project workspace</span> : <WorkspaceTabs tabs={openTabs} current={currentTab.key} healthcare={healthcare} onOpen={openTab} onClose={tab => closeViews({ key: tab.key })} onCloseOthers={() => closeViews('others')} onCloseCompleted={() => closeViews('completed')} policy={tabPolicy(openTabs)}/>}
        <span className="sr-only" aria-live="polite" aria-atomic="true">{tabNotice}</span>
        <div className="top-actions">{exampleView && <><span className="example-label">Example workspace</span><button className="icon-button" onClick={() => void copyBrief()} aria-label={copied ? 'Brief copied' : 'Copy brief'} title="Copy brief">{copied ? <Check size={15}/> : <Copy size={15}/>}</button><button className="icon-button" onClick={downloadBrief} aria-label="Download brief" title="Download brief"><Download size={15}/></button></>}{selectedTask ? <>{run && <span className={`run-header-status ${run.status}`} role="status"><span className={`status-dot ${run.status}`}/>{run.reply ? 'Replied' : run.savedCalculation && !run.result && !runWorking ? 'Calculation saved' : statusLabel[run.status]}</span>}{runWorking && <button className="button secondary compact" disabled={stopping} onClick={() => void stopRun()}><Square size={12}/>{stopping ? 'Stopping…' : 'Stop'}</button>}{answerRun && !runWorking && <><button className="icon-button" onClick={() => void copyBrief()} aria-label={copied ? 'Brief copied' : 'Copy brief'} title="Copy brief">{copied ? <Check size={15}/> : <Copy size={15}/>}</button><button className="icon-button" onClick={downloadBrief} aria-label="Download brief" title="Download brief"><Download size={15}/></button></>}<button className={`icon-button ${showEvidence ? 'active-evidence' : ''}`} id="evidence-toggle" aria-label={showEvidence ? 'Close verification panel' : 'Open verification panel'} aria-expanded={showEvidence} aria-controls="workspace-context-panel" title="Verification and task details" onClick={() => showEvidence ? closeEvidence() : openVerification()}><ShieldCheck size={16}/></button></> : null}</div>
      </header>
      {accessFailure?<SessionNotice status={accessFailure} onSignIn={()=>guardNavigation(()=>location.assign(currentSignInUrl(session)))}/>:error && <div className="error-banner" role="alert"><span>{error}</span><button className="text-button" onClick={() => void refresh().catch((e) => setError(message(e)))}><RefreshCw size={13} />Refresh workspace</button></div>}
      <div ref={contextContainer} className={`workspace-content ${!hasContext ? 'single-pane' : ''}`} style={{ '--context-panel-width': `${contextResize.width}px` } as CSSProperties}>
        <main id="main-content" tabIndex={-1}>
          {loading ? <div className="loading-state" role="status">Opening your workspace…</div> : careView ? <CareWorkspace mode={view === 'care-worklist' ? 'worklist' : view === 'care-benchmarks' ? 'benchmarks' : view === 'connections' ? 'intake' : 'queue'} caseId={careCaseId} onCase={openCareCase} onNavigate={navigate} workspace={workspace} onRefreshWorkspace={refresh}/>
          : exampleView ? <AgentSession key="design-example" run={exampleRun} sources={exampleSources} onSource={(id) => void openSource(id)} onFollowup={prompt => usePrompt(prompt)} onWorkflow={() => navigate('workflows')} onVerification={openVerification} verificationOpen={showEvidence && detailTab === 'verification'} example/>
          : view === 'projects' && workspace && !healthcare ? <ProjectsPage key={workspace.profile.id} workspace={workspace} id={projectId} onOpen={openProject} onRun={selectRun} onUsePrompt={usePrompt} onNavigate={next=>{if(isView(next))navigate(next);}} onSource={id=>void openSource(id)} onRefresh={refresh} onRestoreSource={canArchiveSources ? id => archiveSource(id, false) : undefined}/>
          : view === 'workflows' ? <WorkflowWorkspace key={workspace?.profile.id} session={session} workspace={workspace ?? undefined} requestedDraft={workflowSeed && workflowSeed.profileId === workspace?.profile.id ? workflowSeed.draft : null} onRequestedDraftHandled={() => setWorkflowSeed(null)} onRun={selectRun} onSchedule={workflowId => navigate('schedules', () => { const url = new URL(location.href); url.searchParams.set('workflow', workflowId); history.replaceState({}, '', url); })} onNavigate={next => { if (isView(next)) navigate(next); }}/>
          : view === 'tables' && !healthcare ? <TablesLibrary workspace={workspace} session={session} onRefresh={refresh} onRestoreSource={canArchiveSources ? id => archiveSource(id, false) : undefined} onSource={id => void openSource(id)} onUsePrompt={usePrompt} onAskSource={askWithSource} readOnly={session?.mode === 'authenticated' && session.role === 'reviewer'}/>
          : moduleView ? <ModulePage key={view} view={view as ModuleView} onRun={selectRun} onSource={id => void openSource(id)} workspace={workspace ?? undefined} onUsePrompt={usePrompt} onNavigate={(next: string) => { if (isView(next)) navigate(next); }}/>
          : view === 'review' ? <ReviewPage runs={runs} onOpen={selectRun}/>
          : view === 'workspace' ? <WorkspaceDetails workspace={workspace} session={session} runs={runs} onRefresh={refresh}/>
          : view === 'artifacts' || view === 'reports' || (view === 'tasks' && !selectedId) ? <TaskLibrary healthcare={healthcare} key={view} runs={runs} kind={view === 'artifacts' || view === 'reports' ? 'reports' : 'tasks'} onOpen={selectRun} onNew={newTask} onExample={() => navigate('example')} hasMore={Boolean(nextRunCursor)} loadingMore={loadingOlderRuns} loadError={olderRunsError} onLoadMore={() => void loadOlderRuns()}/>
          : view === 'sources' ? <div className="standard-page sources-page"><div className="page-heading"><div><h1>{healthcare ? 'Knowledge' : 'Files'}</h1><p>Files and context shared with your workspace.</p></div><label className="search-field"><Search size={15}/><input aria-label="Search file titles" placeholder="Find a file" value={filter} onChange={(e) => setFilter(e.target.value)}/></label></div><div className="source-toolbar"><span>{workspace?.sources.length ?? 0} {healthcare ? 'approved sources' : 'files'}</span><div className="source-toolbar-actions">{!healthcare && <FileUpload disabled={!workspace} onSaved={() => refresh()} onOpen={id => void openSource(id)} onUse={source => usePrompt(`Read ${source.title} (source ${source.id}). Summarize the important points and open questions, citing the source.`, [source.id])} onPrepareTask={(prompt, source) => usePrompt(prompt, [source.id])}/>}<button className="text-button" onClick={() => navigate(healthcare ? 'connections' : 'workspace')}>{healthcare ? 'Connections' : 'Settings'} <ArrowRight size={13}/></button></div></div>{!healthcare && allowsManualImports() && <div className="source-recipes"><UsageCsvImport disabled={!workspace} onImported={() => refresh()} onOpenSource={id => void openSource(id)} onPrepareTask={prepareUsageReport}/><FinancialCsvImport disabled={!workspace} onImported={() => refresh()} onOpenSource={id => void openSource(id)} onPrepareTask={prepareFinancialReport}/><span>Calculate a report from a saved CSV.</span></div>}<div className="source-table">{visibleSources.map((item) => <button className="source-row" key={item.id} data-source-id={item.id} onClick={() => void openSource(item.id)}><FileText size={19} /><span><strong>{item.title}</strong></span><span className="source-size">{(item.bytes / 1024).toFixed(1)} KB</span><ChevronRight size={14} /></button>)}{!visibleSources.length && <p className="empty-note">{filter ? 'No files match your search.' : 'No notes are available yet.'}</p>}</div></div>
          : selectedTask ? <div className="run-page">
              {runError && <div className="run-error" role="alert"><p>{runError}</p><button className="text-button" onClick={() => void reloadRun()}>Reload task <RefreshCw size={13}/></button></div>}
              {runLoading && !run ? <p className="loading-state" role="status">Loading task…</p> : run && (run.projectId && workspace && !healthcare ? <ProjectsPage key={run.projectId} workspace={workspace} id={run.projectId} activeRunId={run.id} activeRunState={{status:run.status,artifactTitle:run.result?.title??null}} onOpen={openProject} onRun={selectRun} onUsePrompt={usePrompt} onNavigate={next=>{if(isView(next))navigate(next);}} onSource={id=>void openSource(id)} onRefresh={refresh} onRestoreSource={canArchiveSources ? id => archiveSource(id, false) : undefined}><AgentSession key={`${run.profileId}:${run.sessionId ?? run.id}`} run={run} previousTurns={previousTurns} sources={taskSources} availableSources={workspace?.sources ?? []} onRefreshSources={healthcare ? undefined : refresh} onManageSources={() => navigate('tables')} onArchiveSource={canArchiveSources ? archiveSource : undefined} onSource={(id) => void openSource(id)} onFollowup={continueRun} onRetryExplanation={retryExplanation} onWorkflow={createReportWorkflow} onVerification={openVerification} verificationOpen={showEvidence && detailTab === 'verification'} connectionsEnabled={workspace?.connectionsEnabled === true}/></ProjectsPage> : <AgentSession key={`${run.profileId}:${run.sessionId ?? run.id}`} run={run} previousTurns={previousTurns} sources={taskSources} availableSources={workspace?.sources ?? []} onRefreshSources={healthcare ? undefined : refresh} onManageSources={() => navigate('tables')} onArchiveSource={canArchiveSources ? archiveSource : undefined} onSource={(id) => void openSource(id)} onFollowup={continueRun} onRetryExplanation={retryExplanation} onWorkflow={createReportWorkflow} onVerification={openVerification} verificationOpen={showEvidence && detailTab === 'verification'} connectionsEnabled={workspace?.connectionsEnabled === true}/>)}

            </div> : <div className={`agent-home${healthcare ? '' : ' analyst-home'}`}><div className="agent-home-content">
              {!healthcare && <div className="home-data-actions"><span>{session?.mode === 'local' ? 'Local workspace' : session?.workspaceName?.trim() || 'Your workspace'}</span></div>}
              <HomeWelcome session={session} healthcare={healthcare}/>
              <form className="composer" onSubmit={(event) => void startRun(event)}><label htmlFor="task-input" className="sr-only">Task for Rivet</label><textarea ref={inputRef} id="task-input" title="Enter to send · Shift+Enter for a new line" placeholder={healthcare ? 'Ask a question, explore your notes, or prepare a brief…' : selectedInputs.length ? 'What would you like to know about these sources?' : 'Ask a question about your data…'} value={pending?.task ?? task} readOnly={Boolean(pending)} maxLength={4000} onChange={(event) => setTask(event.target.value)} onKeyDown={event => handleComposerKeyDown(event, () => { void startRun(); })} /><div className="composer-footer"><div className="composer-attachments">{!healthcare && <SessionInputs allowUpload={false} onManageSources={() => navigate('tables')} onUploadingChange={setUploading} onArchive={canArchiveSources ? archiveSource : undefined} sources={workspace?.sources ?? []} selectedIds={pending ? pending.sourceIds ?? [] : selectedInputs} disabled={!workspace || Boolean(pending)} working={Boolean(workspace?.activeRunId)} onChange={setSelectedInputs} onRefresh={refresh} onSource={id => void openSource(id)} onPrepareTask={setTask}/>}</div><button className="submit-task" type="submit" title={pending ? 'Retry the same request' : 'Enter to send · Shift+Enter for a new line'} aria-label={sending ? 'Starting task' : pending ? 'Retry the same request' : 'Run task'} disabled={uploading || sending || Boolean(resolvingRequest) || (!pending && (!task.trim() || blocked))}>{sending ? <span className="small">…</span> : <ArrowUp size={19} />}</button></div></form>
              <RunAllowance budget={workspace?.runBudget} onRefresh={refreshAllowance} onlyWhenBlocked/>
              {pending && !sending && <div className="pending-note" role="status"><p>We couldn't confirm whether your task started. Your draft and files are saved. Check its status, retry, or cancel the request to edit your draft.</p><div className="pending-request-actions"><button className="button secondary" disabled={Boolean(resolvingRequest)} onClick={() => void resolvePendingRequest('check')}><RefreshCw size={14}/>{resolvingRequest === 'check' ? 'Checking...' : 'Check status'}</button><button className="button secondary" disabled={Boolean(resolvingRequest)} onClick={() => void startRun()}>Retry same request</button><button className="button secondary" disabled={Boolean(resolvingRequest)} onClick={() => void resolvePendingRequest('cancel')}><X size={14}/>{resolvingRequest === 'cancel' ? 'Cancelling...' : 'Cancel request'}</button></div></div>}
              {requestNotice && <p role="status" className="pending-note">{requestNotice}</p>}
              {!pending && workspace?.activeRunId && <div className="availability-note"><span>A task is already in progress.</span><button className="text-button" onClick={() => selectRun(workspace.activeRunId)}>Open active task <ArrowRight size={13} /></button></div>}
              {!pending && !workspace?.provider.available && (workspace?.desktop ? <DesktopModelNotice configured={workspace.provider.configured}/> : <div className="availability-note"><span>{workspace ? 'Rivet is unavailable. Check service status before starting a task.' : 'Start the local server to open your workspace.'}</span><button className="text-button" onClick={() => navigate(healthcare ? 'connections' : 'workspace')}>{healthcare ? 'Open connections' : 'Open settings'} <ArrowRight size={13} /></button></div>)}
              <div className="home-prompt-chips" aria-label="Task starters" aria-hidden={!healthcare && Boolean(task.trim()) || undefined} style={{ visibility: !healthcare && task.trim() ? 'hidden' : undefined }}>{(healthcare ? [{label:'Summarize my notes',prompt:suggestions[0]},{label:'Prepare a brief',prompt:suggestions[1]},{label:'Find open questions',prompt:'Read the approved workspace notes. Identify unanswered questions, named owners and the next actions. Cite each source; distinguish facts from suggestions.'}] : sourceStarters(selectedInputs, workspace?.sources ?? [], starterSeed)).map(({label,prompt}) => <button key={label} disabled={Boolean(pending) || !healthcare && Boolean(task.trim())} onClick={() => { if (!healthcare && task.trim()) return; setTask(prompt); inputRef.current?.focus(); }}><FileText size={14}/><span>{label}</span></button>)}</div>
              {!healthcare ? <HomeWork runs={runs} hasSources={Boolean(workspace?.sources.length)} onRun={selectRun} onNavigate={navigate}/> : <><div className="home-start-heading"><h2>Start here</h2></div>
              <div className="home-start-cards">
                <button className="home-start-card" onClick={() => navigate(healthcare ? 'example' : 'tables')}>{healthcare ? <div className="start-card-art paper-art" aria-hidden="true"><span/><span/><span/><span/></div> : <div className="start-card-art data-art" aria-hidden="true"><BookOpen size={38} strokeWidth={1.25}/></div>}<div><strong>{healthcare ? 'Try an example' : 'Your files'}</strong><p>{healthcare ? 'A conversation, a brief, and the sources behind it.' : 'Social posts, program data, and documents.'}</p><span>{healthcare ? 'Open workspace' : 'Open Tables'} <ArrowRight size={13}/></span></div></button>
                <button className="home-start-card" onClick={() => navigate('workflows')}><div className="start-card-art flow-art" aria-hidden="true"><span/><i/><span/><i/><span/></div><div><strong>{healthcare ? 'Create a workflow' : 'Create a workflow'}</strong><p>{healthcare ? 'Keep useful instructions ready for the next task.' : 'Save recurring work as reusable steps.'}</p><span>Open workflows <ArrowRight size={13}/></span></div></button>
              </div>
              <p className="home-local-note"><span className={`status-dot ${workspace?.provider.available ? 'ready' : ''}`}/>{homeModelLabel(workspace?.provider)}<span>·</span>Source-linked answers</p></>}
            </div></div>}
        </main>

        {hasContext && <PanelResizeHandle panel={contextResize} side="right" controls="workspace-context-panel" label="Resize evidence panel" className="context-resize-handle"/>}
        {hasContext && <aside id="workspace-context-panel" className={`context-panel ${selectedTask || exampleView || calculationInspection ? 'task-evidence' : ''} ${sourceId && !sourceBehindInspection ? 'reading-source' : ''}`} aria-label={sourceId && !sourceBehindInspection ? 'Source document' : 'Task evidence'} onKeyDown={event => { if (event.key !== 'Escape') return; event.preventDefault(); event.stopPropagation(); if (sourceId && !sourceBehindInspection && (selectedTask || exampleView || calculationInspection)) closeSource(); else closeEvidence(); }}>
          {detailTab === 'verification' && (verificationRun || calculationInspection) && <div className="verification-host" hidden={Boolean(sourceId) && !sourceBehindInspection}><VerificationPanel key={exampleView ? 'example' : verificationRun?.id ?? calculationInspection?.analysis.result.id} run={verificationRun} sources={exampleView ? exampleSources : verificationRun?.sources ?? taskSources} inspection={calculationInspection} onInspect={inspection => inspection ? inspectCalculation(inspection) : sourceBehindInspection ? closeEvidence() : setCalculationInspection(undefined)} example={exampleView} onSource={id => void openSource(id, calculationInspection?.ownerId)} onClose={closeEvidence} onDetails={exampleView || !verificationRun ? undefined : () => { setDetailTab('context'); requestAnimationFrame(() => document.getElementById('evidence-details-heading')?.focus()); }} onRefresh={!exampleView && verificationRun && !runWorking ? refreshEvidence : undefined}/></div>}
          {sourceId ? <><header className="source-header" hidden={sourceBehindInspection}>{(selectedTask || exampleView || calculationInspection) && <button className="icon-button" onClick={closeSource} aria-label={detailTab === 'verification' ? 'Back to verification' : 'Back to task details'}><ArrowLeft size={15}/></button>}<span>Source document</span><button className="icon-button" onClick={closeEvidence} aria-label="Close source"><X size={15}/></button></header><div className="source-document" hidden={sourceBehindInspection}><span className="sample-label">{exampleView ? 'Fictional example note' : source && sourceTableKind(source) ? 'CSV file' : source?.provenance ? 'Saved Google Drive source' : source?.path.startsWith('social/') || source?.path.startsWith('datasets/') || source?.path.startsWith('calculations/') ? 'Calculated source' : source?.path.startsWith('uploads/') ? 'Uploaded workspace file' : 'Approved workspace note'}</span><h2 ref={sourceHeadingRef} tabIndex={-1}>{source && sourceTableKind(source) ? source.title.replace(/^Social CSV · /, '') : source?.title ?? 'Source'}</h2>{sourceLoading && <p role="status">Opening source…</p>}{sourceError && <div role="alert"><p>{sourceError}</p><button className="text-button" onClick={() => void openSource(sourceId, sourceOwnerRef.current)}>Try again</button></div>}{source && (sourceCalculationId(source) ? <CalculatedSourceTable inSidebar key={source.id} source={source} onSource={id => void openSource(id, sourceOwnerRef.current)} /> : sourceTableKind(source) ? <SourceCsvTable key={source.id} source={source} onSource={id => void openSource(id, sourceOwnerRef.current)} /> : <><p className="source-path">{source.path}</p>{source.provenance && <p className="small muted">Saved {new Date(source.provenance.retrievedAt).toLocaleString()} · {source.provenance.accountLabel}{source.provenance.truncated ? ' · Excerpt' : ''}<br />Historical evidence remains available after disconnecting.</p>}<div className="markdown"><Markdown content={documentBody(source.content, source.title)} onSource={(id) => void openSource(id, sourceOwnerRef.current)} /></div></>)}</div></> : detailTab !== 'verification' ? <><header className="evidence-details-header"><button className="icon-button" onClick={openVerification} aria-label="Back to verification"><ArrowLeft size={15}/></button><h2 id="evidence-details-heading" tabIndex={-1}>Task details</h2><button className="icon-button" onClick={closeEvidence} aria-label="Close task details"><X size={15}/></button></header><div className="context-tabs" role="tablist" aria-label="Task details" onKeyDown={tabKeys}>{(['context', 'artifacts'] as DetailTab[]).map((tab) => <button key={tab} id={`tab-${tab}`} role="tab" aria-selected={detailTab === tab} aria-controls={`panel-${tab}`} tabIndex={detailTab === tab ? 0 : -1} onClick={() => setDetailTab(tab)}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}</div><div role="tabpanel" id={`panel-${detailTab}`} aria-labelledby={`tab-${detailTab}`} tabIndex={0} className="context-tab-content">{detailTab === 'context' ? context : <div className="context-body"><h3>Artifacts</h3>{run?.result ? <><div className="artifact-row"><FileText size={20} /><div><strong>{run.result.title}</strong><small>{outputLabel} · {date(run.result.createdAt)}</small></div></div><span className="eyebrow">Sources read</span><div className="source-links">{run.result.citations.map((id) => <button key={id} data-source-id={id} onClick={() => void openSource(id)}><FileText size={14} /><span>{taskSources.find((item) => item.id === id)?.title ?? 'Open cited source'}</span><ChevronRight size={12} /></button>)}</div></> : <p className="empty-note">A saved brief will appear here when Rivet finishes one.</p>}</div>}</div></> : null}
        </aside>}
      </div>
    </div>
  </div></DismissCalculationVerificationContext.Provider></CalculationVerificationContext.Provider>;
}
import './older-drafts.css';
