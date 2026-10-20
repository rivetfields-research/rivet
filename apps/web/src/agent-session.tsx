import { TabularAnalysisView } from './tabular-analysis';
import { SourceAnalysisView, sourceNarrative, recommendedSourceChart } from './source-analysis-view';
import { PostPresentationProvider } from './post-presentation';
import { SocialAnalysisView } from './social-analysis';
import { handleComposerKeyDown } from './composer-keyboard';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, ChevronRight, CircleAlert, FileText, GitBranch, MessageSquare, PanelLeftClose, PanelLeftOpen, Presentation, Printer, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { Artifact, Run, Source } from '../../../packages/core/src/types';
import { Markdown } from './markdown';
import { QuestionSuggestions } from './home-welcome';
import { ApiError, message, readSaved, saveLocal } from './api';
import { RivetMark } from './rivet-mark';
import { usePacedReply } from './paced-reply';
import { SessionInputs, inputIds, inputDraftKey, conversationInputIds, followupParentId } from './session-inputs';
import { streamingNarrative, visibleNarrativeProse, isNearScrollEnd } from './model-stream-presentation';
import { RunProgress } from './run-progress';
import { runProgressStatus } from './run-progress-state';
import { PanelResizeHandle, usePanelResize } from './panel-resize';
import { UsageAnalysisView } from './visual-analysis';
import { FinancialAnalysisView } from './financial-analysis';
import { taskTitle } from './run-presentation';
import { ReportBody, reportBody } from './report-body';
import { DataAsOfText, useRunFreshness } from './connection-freshness';
import { WeeklyReviewContext } from './weekly-review-context';
import { WeeklyReviewEmail } from './weekly-review-email';
import { sourceReportTitle } from '../../../packages/presentation/src/source-chart';
import './agent-session.css';

export type AgentSessionProps = {
  run: Run;
  sources: Source[];
  onSource: (id: string) => void;
  onFollowup: (prompt: string, requestId?: string, sourceIds?: string[], parentRunId?: string) => void | Promise<void>;
  onRetryExplanation?: (runId: string, requestId: string) => Promise<void>;
  previousTurns?: Run[];
  availableSources?: Source[];
  onRefreshSources?: () => Promise<void>;
  onManageSources?: () => void;
  onArchiveSource?: (id: string, archived: boolean) => Promise<void>;
  onWorkflow: () => void;
  example?: boolean;
  /** `WorkspaceStatus.connectionsEnabled`: without it no freshness is requested. */
  connectionsEnabled?: boolean;
  onVerification?: () => void;
  verificationOpen?: boolean;
};

const statusLabels: Record<Run['status'], string> = { queued: 'Queued', running: 'Working', completed: 'Complete', cancelled: 'Stopped', failed: 'Failed', interrupted: 'Interrupted' };
const date = (value: string) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function hasRecoveredExplanation(run: Run): boolean {
  const saved = run.savedCalculation?.analysis;
  const explained = run.reply?.tabularAnalysis;
  return Boolean(run.explanationRetryOf && runProgressStatus(run.events, run.status, run.error) === 'completed' && saved && explained
    && saved.result.id === explained.result.id && saved.sourceId === explained.sourceId);
}
function hasDocument(run: Run): boolean {
  // Ordinary calculated replies stay compact; an explicit retry retains its saved document.
  return Boolean(run.result || (run.savedCalculation && (!run.reply || hasRecoveredExplanation(run))) || (run.savedSourceAnalysis && !run.reply));
}
function AnswerMarkdown({ answer, onSource, content }: { answer: NonNullable<Run['reply']> | Artifact; content?: string; onSource: (id: string) => void }) {
  const markdown = <Markdown content={content ?? (answer.sourceAnalysis ? sourceNarrative(answer.content) : answer.content)} citations={answer.citations ?? []} onSource={onSource} />;
  return answer.tabularAnalysis ? <PostPresentationProvider result={answer.tabularAnalysis.result} labels={answer.tabularAnalysis.postLabels}>{markdown}</PostPresentationProvider> : markdown;
}
function ArtifactBody({ artifact, runId, onSource }: { artifact: Artifact; runId: string; onSource: (id: string) => void }) {
  const body = reportBody(artifact.sourceAnalysis ? sourceNarrative(artifact.content) : artifact.content, artifact.title);
  if (artifact.tabularAnalysis) return <TabularAnalysisView key={artifact.tabularAnalysis.result.id} analysis={artifact.tabularAnalysis} runId={runId} onSource={onSource} report={{content: body, citations: artifact.citations}}/>;
  if (artifact.sourceAnalysis) return <SourceAnalysisView key={artifact.sourceAnalysis.result.id} analysis={artifact.sourceAnalysis} runId={runId} onSource={onSource} report={{content: body, citations: artifact.citations}}/>;
  if (!artifact.tabularAnalysis && !artifact.sourceAnalysis && !artifact.socialAnalysis && !artifact.analysis && !artifact.financialAnalysis) {
    return <div className="markdown agent-document-body"><Markdown content={body} citations={artifact.citations} onSource={onSource}/></div>;
  }
  return <ReportBody content={body} citations={artifact.citations} onSource={onSource}>
      {artifact.socialAnalysis && <SocialAnalysisView analysis={artifact.socialAnalysis} runId={runId} onSource={onSource}/>}
      {artifact.analysis?.kind === 'weekly-usage' && <UsageAnalysisView analysis={artifact.analysis} onSource={onSource}/>}
      {artifact.financialAnalysis?.kind === 'financial-period' && <FinancialAnalysisView analysis={artifact.financialAnalysis} onSource={onSource}/>}
  </ReportBody>;
}

function ReplySupportingData({ run, onSource, current = false }: { run: Run; onSource: (id: string) => void; current?: boolean }) {
  const [open, setOpen] = useState(() => current && Boolean(run.parentRunId) && Boolean(
    run.reply?.tabularAnalysis ? run.reply.tabularAnalysis.result.request.chart !== 'table'
      : run.reply?.sourceAnalysis && recommendedSourceChart(run.reply.sourceAnalysis.result) !== 'table'));
  const analysis = run.reply?.tabularAnalysis;
  const sourceAnalysis = run.reply?.sourceAnalysis;
  if (!analysis && !sourceAnalysis) return null;
  return <details className="agent-supporting-data" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><ChevronRight size={15} aria-hidden="true" />Supporting data</summary>
    {open && (analysis ? <TabularAnalysisView analysis={analysis} runId={run.id} onSource={onSource} /> : <SourceAnalysisView runId={run.id} analysis={sourceAnalysis!} onSource={onSource}/>)}
  </details>;
}

function ExplanationRecovery({run, onRetry}: {run: Run; onRetry: NonNullable<AgentSessionProps['onRetryExplanation']>}) {
  const key = `rivetfields.explanation-retry.${run.profileId}.${run.id}`;
  const requestId = useRef(readSaved<string>(key, ''));
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  async function retry() {
    if (inFlight.current) return;
    inFlight.current = true; setSending(true); setError('');
    requestId.current ||= crypto.randomUUID();
    saveLocal(key, requestId.current);
    try { await onRetry(run.id, requestId.current); saveLocal(key, null); }
    catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) { requestId.current = ''; saveLocal(key, null); }
      setError(message(failure));
    } finally { inFlight.current = false; setSending(false); }
  }
  return <div className="agent-explanation-recovery">
    <p>The chart, table and source evidence are saved. Retrying uses your model allowance without recalculating the data.</p>
    <button className="button secondary compact" disabled={sending} onClick={() => void retry()}><RefreshCw size={14}/>{sending ? 'Starting retry...' : 'Retry explanation'}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}


export function buildFollowupPrompt(run: Run, followup: string, example = false): string {
  const prefix = `Respond to this follow-up. Use approved workspace sources for factual document work.\n\n${followup.trim().slice(0, 1800)}\n\nPrevious task:\n${run.task.slice(0, 700)}\n\n`;
  const previous = run.result
    ? `${example ? 'Illustrative example' : 'Previous report'} excerpt (context to check against the sources):\n${run.result.content}`
    : run.reply ? `Previous reply (conversation context):\n${run.reply.content}` : 'The previous task ended without a saved response.';
  return `${prefix}${previous}`.slice(0, 4000);
}

export async function buildSavedPresentation(artifact: Artifact) {
  // Keep presentation renderers out of initial page loading. Both use saved calculations only.
  if (artifact.financialAnalysis?.kind === 'financial-period') {
    const { buildFinancialPresentation } = await import('./financial-presentation');
    return buildFinancialPresentation(artifact);
  }
  if (artifact.analysis?.kind === 'weekly-usage') {
    const { buildUsagePresentation } = await import('./presentation-export');
    return buildUsagePresentation(artifact);
  }
  throw new Error('PowerPoint export needs a saved usage or financial calculation.');
}

export function AgentSession({ run, onSource, onFollowup, onRetryExplanation, onWorkflow, example = false, onVerification, verificationOpen = false, previousTurns = [], availableSources = [], onRefreshSources, onManageSources, onArchiveSource, connectionsEnabled = false }: AgentSessionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileView, setMobileView] = useState<'conversation' | 'document'>(run.result ? 'document' : 'conversation');
  const followupKey = `rivetfields.followup.${run.profileId}.${run.sessionId ?? run.id}`;
  const sourcesKey = inputDraftKey(run.profileId, run.sessionId ?? run.id);
  const [initialFollowup] = useState(() => readSaved<{task:string;requestId:string;sourceIds?:string[];parentRunId?:string}>(followupKey, readSaved(`rivetfields.followup.${run.profileId}.${run.id}`, {task:'',requestId:''})));
  const [selectedInputs, setSelectedInputs] = useState(() => inputIds(readSaved(sourcesKey, [])));
  const requestParent = useRef(initialFollowup.parentRunId);
  const requestInputs = useRef<string[] | undefined>(initialFollowup.requestId ? inputIds(initialFollowup.sourceIds) : undefined);
  const inheritedInputs = conversationInputIds(run, availableSources);
  useEffect(() => { saveLocal(sourcesKey, selectedInputs); }, [sourcesKey, selectedInputs]);
  const [followup, setFollowup] = useState(initialFollowup.task);
  const followupRequest = useRef(initialFollowup.requestId);
  const submitting = useRef(false);
  const [sendingFollowup, setSendingFollowup] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [followupError, setFollowupError] = useState('');
  useEffect(() => { saveLocal(followupKey, {task: followup, requestId: followupRequest.current, sourceIds: requestInputs.current, parentRunId: requestParent.current}); }, [followupKey, followup]);
  const [exportState, setExportState] = useState<'idle' | 'building' | 'ready' | 'failed'>('idle');
  const exportAttempt = useRef(0);
  const exporting = useRef(false);
  const sessionRef = useRef<HTMLElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const followingConversation = useRef(Boolean(run.parentRunId) || run.status === 'queued' || run.status === 'running');
  const [showLatest, setShowLatest] = useState(false);
  const status = runProgressStatus(run.events, run.status, run.error);
  const working = status === 'queued' || status === 'running';
  const contextLimited = !example && status === 'failed' && (run.errorCode === 'context_limit'
    || run.error === 'The run reached its 48,000-character context limit.'
    || run.events.some(event => event.type === 'failed' && event.output && typeof event.output === 'object'
      && 'errorCode' in event.output && event.output.errorCode === 'context_limit'));
  const runError = contextLimited ? 'This request was too large to finish.'
    : run.error || (status === 'failed' ? 'The task could not finish. You can send a follow-up to continue.' : '');
  // Saved freshness only (a scheduled run's pin, or its inputs); the illustrative example never has any.
  const dataAsOf = useRunFreshness(example ? null : run.id, !working, connectionsEnabled);
  const savedResultRun = hasDocument(run) ? run : previousTurns.findLast(hasDocument);
  const savedResult = savedResultRun?.result;
  const savedCalculation = !savedResult ? savedResultRun?.savedCalculation : undefined;
  const savedSourceAnalysis = !savedResult ? savedResultRun?.savedSourceAnalysis : undefined;
  const earlierDocument = Boolean(savedResultRun && savedResultRun.id !== run.id);
  const documentStatus = savedResultRun && runProgressStatus(savedResultRun.events, savedResultRun.status, savedResultRun.error);
  const documentWorking = documentStatus === 'queued' || documentStatus === 'running';
  const explanationComplete = savedResultRun ? hasRecoveredExplanation(savedResultRun) : false;
  const [documentHidden, setDocumentHidden] = useState(false);
  const result = documentHidden ? undefined : savedResult;
  const partial = documentHidden ? undefined : savedCalculation;
  const partialSource = documentHidden ? undefined : savedSourceAnalysis;
  const narrative = streamingNarrative(run.events, status);
  const reply = status === 'completed' ? run.reply : undefined;
  const pacedReply = usePacedReply(reply ? visibleNarrativeProse(reply.content) : narrative?.content ?? null, {
    streamKey: run.id, revisionKey: narrative?.requestId, active: working, complete: Boolean(reply),
  });
  const liveReply = pacedReply.text;
  const canExportPresentation = !example && (result?.analysis?.kind === 'weekly-usage' || result?.financialAnalysis?.kind === 'financial-period');
  const replyOnly = !result && !partial && !partialSource;
  const conversationPanel = usePanelResize({
    storageKey: 'rivetfields.conversation-width.v1', defaultWidth: 334,
    minWidth: 260, maxWidth: 720, containerRef: sessionRef,
    minimumRemainingWidth: 360, desktopMinContainerWidth: 1000,
    enabled: !collapsed && !replyOnly,
  });
  const requestTitle = taskTitle(run).split('\n').find(line => line.trim()) ?? 'Your task';
  const requestLong = run.task.length > 420;
  const headingId = `agent-document-${run.id}`;

  useEffect(() => {
    setExportState('idle'); exporting.current = false;
    return () => { exportAttempt.current += 1; };
  }, [run.id, result?.id]);

  async function downloadPresentation() {
    if (!result || !canExportPresentation || exporting.current) return;
    exporting.current = true;
    const attempt = ++exportAttempt.current;
    setExportState('building');
    try {
      const file = await buildSavedPresentation(result);
      if (attempt !== exportAttempt.current) return;
      const url = URL.createObjectURL(new Blob([file.data], { type: file.mimeType }));
      const link = document.createElement('a');
      link.href = url; link.download = file.fileName;
      try { link.click(); } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
      setExportState('ready');
    } catch {
      if (attempt === exportAttempt.current) setExportState('failed');
    } finally {
      if (attempt === exportAttempt.current) exporting.current = false;
    }
  }

  useEffect(() => { setMobileView(run.result ? 'document' : 'conversation'); }, [run.id]);
  useLayoutEffect(() => { followingConversation.current = Boolean(run.parentRunId) || working; setShowLatest(false); }, [run.id]);
  useLayoutEffect(() => {
    if (followingConversation.current && conversationScrollRef.current) conversationScrollRef.current.scrollTop = conversationScrollRef.current.scrollHeight;
  }, [run.id, run.events.length, run.events.at(-1)?.id, run.status, liveReply, collapsed, mobileView]);

  function openDocument() {
    setDocumentHidden(false); setMobileView('document');
    requestAnimationFrame(() => articleRef.current?.focus({ preventScroll: false }));
  }
  function toggleConversation() {
    setCollapsed(value => !value);
    if (collapsed) requestAnimationFrame(() => conversationRef.current?.focus({ preventScroll: true }));
    else requestAnimationFrame(() => window.document.getElementById('agent-show-conversation')?.focus({ preventScroll: true }));
  }
  async function prepareFollowup(event?: FormEvent) {
    event?.preventDefault();
    if (uploading || !followup.trim() || working || submitting.current) return;
    if (example) { onFollowup(buildFollowupPrompt(run, followup, true)); return; }
    submitting.current = true; setSendingFollowup(true); setFollowupError('');
    followupRequest.current ||= crypto.randomUUID();
    requestInputs.current ??= [...selectedInputs];
    requestParent.current ??= followupParentId(followupRequest.current, run, previousTurns);
    saveLocal(followupKey, {task: followup, requestId: followupRequest.current, sourceIds: requestInputs.current, parentRunId: requestParent.current});
    try {
      await onFollowup(followup.trim(), followupRequest.current, requestInputs.current, requestParent.current);
      saveLocal(followupKey, null); followupRequest.current = ''; requestInputs.current = undefined; requestParent.current = undefined; setFollowup(''); setSelectedInputs([]); saveLocal(sourcesKey, []);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) { followupRequest.current = ''; requestInputs.current = undefined; requestParent.current = undefined; }
      saveLocal(followupKey, {task: followup, requestId: followupRequest.current, sourceIds: requestInputs.current, parentRunId: requestParent.current});
      setFollowupError(message(error));
    } finally { submitting.current = false; setSendingFollowup(false); }
  }
  function mobileTabKeys(event: KeyboardEvent<HTMLButtonElement>, current: 'conversation' | 'document') {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'conversation' : event.key === 'End' ? 'document' : current === 'conversation' ? 'document' : 'conversation';
    setMobileView(next);
    window.document.getElementById(`agent-mobile-${next}`)?.focus();
  }

  return <section ref={sessionRef} style={{ '--agent-conversation-width': `${conversationPanel.width}px` } as CSSProperties} className={`agent-session ${replyOnly ? 'reply-only' : ''} ${collapsed && !replyOnly ? 'conversation-collapsed' : ''} mobile-${replyOnly ? 'conversation' : mobileView}`} aria-label={example ? 'Illustrative Rivet workspace' : 'Rivet workspace'}>
    {!replyOnly && <div className="agent-mobile-tabs" role="tablist" aria-label="Session view">{(['conversation', 'document'] as const).map(view => <button key={view} id={`agent-mobile-${view}`} role="tab" aria-selected={mobileView === view} aria-controls={`agent-${view}-pane`} tabIndex={mobileView === view ? 0 : -1} onClick={() => setMobileView(view)} onKeyDown={event => mobileTabKeys(event, view)}>{view === 'conversation' ? <MessageSquare size={15} /> : <FileText size={15} />}{view === 'conversation' ? 'Conversation' : 'Document'}</button>)}</div>}
    <aside id="agent-conversation-pane" ref={conversationRef} tabIndex={-1} className="agent-conversation" aria-label="Task and progress">
      <header className="agent-conversation-top"><span><RivetMark size={21} />{example ? 'Example session' : 'Conversation'}</span>{!replyOnly && <button className="agent-icon-button agent-hide-conversation" aria-label="Hide conversation" title="Hide conversation" onClick={toggleConversation}><PanelLeftClose size={16} /></button>}</header>
      <div className="agent-conversation-scroll" ref={conversationScrollRef} tabIndex={-1} onScroll={event => { followingConversation.current = isNearScrollEnd(event.currentTarget); setShowLatest(!followingConversation.current); }}>
        {example && <p className="agent-example-note">Illustrative example · no model run</p>}
        {previousTurns.map(previous => <section key={previous.id} aria-label="Earlier conversation">
          <div className="agent-user-message"><span>You</span><p>{taskTitle(previous)}</p></div>
          {previous.reply && <div className="agent-reply"><div className="markdown"><AnswerMarkdown answer={previous.reply} onSource={onSource}/></div><ReplySupportingData key={previous.id} run={previous} onSource={onSource}/></div>}
          {previous.result && <details className="agent-event-detail"><summary><FileText size={15}/>{previous.result.title}</summary><div className="markdown"><AnswerMarkdown answer={previous.result} onSource={onSource}/></div></details>}
          {previous.error && <p role="status">{previous.error}</p>}
          <p className="agent-turn-status">Earlier task · {statusLabels[runProgressStatus(previous.events, previous.status, previous.error)]}</p>
          <RunProgress events={previous.events} status={previous.status} error={previous.error}/>
        </section>)}
        <div className="agent-user-message"><span>You</span><p>{requestLong ? run.task.slice(0, 420).trimEnd() + '…' : run.task}</p>{requestLong && <details className="agent-full-request"><summary>Full request<ChevronDown size={12} /></summary><p>{run.task}</p></details>}</div>
        <details className="agent-task-details"><summary>Task details<ChevronRight size={12} /></summary><dl>{!example && <><dt>Created</dt><dd>{date(run.createdAt)}</dd></>}{run.workflowId && <><dt>Workflow version</dt><dd>{run.workflowVersion ?? 'Not reported'}</dd></>}{dataAsOf && <><dt>Data as of</dt><dd className="agent-data-as-of"><DataAsOfText summary={dataAsOf} label={false} /></dd></>}<dt>Step limit</dt><dd>{run.limits.maxSteps}</dd><dt>Time limit</dt><dd>{Math.round(run.limits.timeoutMs / 1000)} seconds</dd><dt>Input tokens</dt><dd>{run.usage.inputTokens?.toLocaleString() ?? 'Not reported'}</dd><dt>Output tokens</dt><dd>{run.usage.outputTokens?.toLocaleString() ?? 'Not reported'}</dd></dl></details>
        {previousTurns.length > 0 && <p className="agent-turn-status">Latest task · {statusLabels[status]}</p>}
        <RunProgress events={run.events} status={run.status} error={run.error} example={example}/>
        {reply && <section className="agent-reply" aria-label="Rivet reply"><header><RivetMark size={20} /><span>Rivet</span></header><div className="markdown">{pacedReply.revealing ? <Markdown content={reply.sourceAnalysis ? sourceNarrative(liveReply ?? '') : liveReply ?? ''} onSource={onSource} /> : <AnswerMarkdown answer={reply} onSource={onSource} />}</div>{pacedReply.revealing && <button type="button" className="text-button" onClick={pacedReply.showAll}>Show full response</button>}<ReplySupportingData key={run.id} run={run} current onSource={onSource}/></section>}
        {!working && <QuestionSuggestions questions={(run.result ?? reply)?.answer?.suggestions ?? []} concealed={Boolean(followup.trim())} disabled={sendingFollowup || Boolean(followupRequest.current)} onChoose={question => { if (followup.trim()) return; setFollowup(question); inputRef.current?.focus(); }} />}
        {!reply && working && liveReply && <section className="agent-reply agent-streaming-reply" aria-label={narrative?.kind === 'report' ? 'Report draft' : 'Streaming answer'} aria-busy="true"><header><RivetMark size={20}/><span>Rivet</span><small>{narrative?.kind === 'report' ? 'Writing report…' : 'Writing…'}</small></header><p>{liveReply}</p><small className="agent-draft-note">Draft · still being checked</small></section>}
        {runError && <div className="agent-run-error" role="status"><CircleAlert size={15} /><div>
          <strong>{run.savedCalculation || run.savedSourceAnalysis ? 'Calculation saved; explanation incomplete' : statusLabels[status]}</strong>
          <p>{runError}</p>
          {status === 'failed' && !run.result && !run.savedCalculation && !run.savedSourceAnalysis && <p>No new report was saved.</p>}
          {earlierDocument && savedResult && <p>Your earlier report is still available.</p>}
          {contextLimited && <><p>Try one question or a shorter date range. If needed, start a separate task with fewer sources; your saved work stays here.</p>
            <button type="button" className="text-button" disabled={sendingFollowup || Boolean(followupRequest.current)} onClick={() => { if (!followup.trim()) setFollowup(run.task.slice(0, 1800)); inputRef.current?.focus(); }}><MessageSquare size={14}/>Revise follow-up</button></>}
          {run.errorCode && <details><summary>Failure details</summary><dl><dt>Reason</dt><dd>{run.errorCode}</dd><dt>Task ID</dt><dd>{run.id}</dd></dl></details>}
        </div></div>}
        {!working && !run.result && !run.reply && run.savedCalculation && onRetryExplanation && <ExplanationRecovery key={run.id} run={run} onRetry={onRetryExplanation}/>}
        {(savedCalculation || savedSourceAnalysis) && <button className="agent-output-link" onClick={openDocument}><FileText size={21}/><span><strong>{savedSourceAnalysis ? sourceReportTitle(savedSourceAnalysis.result) : 'Social performance'}</strong><small>{documentWorking ? 'Explanation in progress' : 'Chart, table and source evidence'}</small></span><ArrowRight size={15}/></button>}
        {savedResult && <button className="agent-output-link" onClick={openDocument}><FileText size={21} /><span><strong>{savedResult.title}</strong><small>{earlierDocument && <>Earlier report · {date(savedResult.createdAt)} · </>}{savedResult.citations.length} cited {savedResult.citations.length === 1 ? 'source' : 'sources'}</small></span><ArrowRight size={15} /></button>}
      </div>
      {showLatest && (working || pacedReply.revealing) && <button type="button" className="agent-latest-activity" onClick={() => { followingConversation.current = true; const scroll = conversationScrollRef.current; if (scroll) { scroll.scrollTop = scroll.scrollHeight; scroll.focus({ preventScroll: true }); } setShowLatest(false); }}><ArrowDown size={13} />Latest activity</button>}
      <form className="agent-followup" onSubmit={event => void prepareFollowup(event)}>{!example && onRefreshSources && <SessionInputs onManageSources={onManageSources} onUploadingChange={setUploading} sources={availableSources} inheritedSources={run.sources} onArchive={onArchiveSource} selectedIds={followupRequest.current ? requestInputs.current ?? [] : selectedInputs} inheritedIds={inheritedInputs} working={working} disabled={sendingFollowup || Boolean(followupRequest.current)} onChange={setSelectedInputs} onRefresh={onRefreshSources} onSource={onSource} onPrepareTask={setFollowup}/>}<label className="sr-only" htmlFor={`agent-followup-${run.id}`}>Follow-up instructions</label><textarea id={`agent-followup-${run.id}`} ref={inputRef} rows={3} title="Enter to send · Shift+Enter for a new line" maxLength={1800} value={followup} readOnly={sendingFollowup || Boolean(followupRequest.current)} onChange={event => setFollowup(event.target.value)} placeholder={working ? 'Add a follow-up for after this task…' : 'Ask a follow-up…'} onKeyDown={event => handleComposerKeyDown(event, () => { void prepareFollowup(); })} /><div className="agent-followup-footer"><span>{example ? 'Prepares a new task' : sendingFollowup ? 'Sending…' : followupRequest.current ? 'Retry to confirm your message' : 'Continue this conversation'}</span><button className="agent-followup-submit" type="submit" disabled={uploading || !followup.trim() || working || sendingFollowup} aria-label={example ? 'Prepare follow-up' : 'Send follow-up'} title={working ? 'Available when this task ends' : 'Enter to send · Shift+Enter for a new line'}><ArrowUp size={18} /></button></div>{followupError && <p className="agent-run-error" role="alert">{followupError}</p>}</form>
    </aside>
    {!replyOnly && <PanelResizeHandle panel={conversationPanel} side="left" controls="agent-conversation-pane" label="Resize conversation" className="agent-conversation-resizer" />}
    {!replyOnly && <section id="agent-document-pane" className="agent-document-pane" aria-label="Task document">
      <header className="agent-document-toolbar"><div className="agent-document-toolbar-title">{collapsed && <button id="agent-show-conversation" className="agent-icon-button" onClick={toggleConversation} aria-label="Show conversation" title="Show conversation"><PanelLeftOpen size={17} /></button>}<FileText size={16} /><span>{earlierDocument ? savedResult ? 'Earlier report' : 'Earlier saved results' : 'Report'}</span></div><div className="agent-document-tools">
        <button type="button" aria-label="Close document" title="Close document" onClick={() => { setDocumentHidden(true); setCollapsed(false); setMobileView('conversation'); requestAnimationFrame(() => inputRef.current?.focus()); }}><X size={16}/></button>
        {result && onVerification && <button type="button" className={verificationOpen ? 'is-active' : ''} aria-label="Open document verification" title="Verification" aria-expanded={verificationOpen} aria-controls="workspace-context-panel" onClick={onVerification}><ShieldCheck size={16}/></button>}
        {result && <button type="button" title="Print report or save as PDF" aria-label="Print report or save as PDF" onClick={() => window.print()}><Printer size={15} /></button>}
        {result && savedResultRun?.weeklyReview && <WeeklyReviewEmail run={savedResultRun}/>}
        {canExportPresentation && <button type="button" title={exportState === 'building' ? 'Preparing PowerPoint…' : 'Download PowerPoint'} aria-label={exportState === 'building' ? 'Preparing PowerPoint' : 'Download PowerPoint'} disabled={exportState === 'building'} onClick={() => void downloadPresentation()}><Presentation size={15} /></button>}
        {result && <button className="agent-workflow-link" onClick={onWorkflow} aria-label="Create workflow" title="Create workflow"><GitBranch size={15} /><span>Create workflow</span></button>}
      </div></header>
      {earlierDocument && <p className="agent-document-context">Saved from an earlier answer; kept unchanged. {['failed', 'cancelled', 'interrupted'].includes(status) ? `Latest task ${statusLabels[status].toLowerCase()}. This ${savedResult ? 'report' : 'saved data'} was not updated.` : working ? 'The latest task is still in progress.' : ''}</p>}
      {exportState === 'failed' ? <p className="agent-export-notice" role="alert">PowerPoint could not be prepared. Your saved report is unchanged. <button type="button" className="text-button" onClick={() => void downloadPresentation()}>Try again</button></p> : <span className="sr-only" role="status">{exportState === 'building' ? 'Preparing PowerPoint from saved calculations.' : exportState === 'ready' ? 'PowerPoint prepared. Check your downloads.' : ''}</span>}
      <div className="agent-document-scroll">{result ? <article className={`agent-document-paper ${result.analysis || result.financialAnalysis || result.socialAnalysis || result.tabularAnalysis || result.sourceAnalysis ? 'has-visual-analysis' : ''}`} ref={articleRef} tabIndex={-1} aria-labelledby={headingId}><span className="agent-document-kicker">{example ? 'Illustrative document' : savedResultRun?.weeklyReview ? 'Rivet · weekly review' : result.tabularAnalysis ? 'Rivet · CSV analysis' : result.sourceAnalysis ? 'Rivet · source analysis' : result.socialAnalysis ? 'Rivet · social performance' : result.financialAnalysis ? 'Rivet · financial review' : result.analysis ? 'Rivet · usage review' : 'Workspace document'}{!example && <span>{date(result.createdAt)}</span>}</span><h1 id={headingId}>{result.title}</h1>{savedResultRun?.weeklyReview && <WeeklyReviewContext review={savedResultRun.weeklyReview}/>}<ArtifactBody artifact={result} runId={savedResultRun!.id} onSource={onSource}/></article> : partial ? <article className="agent-document-paper has-visual-analysis" ref={articleRef} tabIndex={-1} aria-labelledby={headingId}>
        <span className="agent-document-kicker">Rivet · social performance<span>{date(partial.savedAt)}</span></span>
        <h1 id={headingId}>Social performance</h1>
        <p className="agent-report-status" role="status">{explanationComplete ? 'Explanation complete.' : documentWorking ? 'The explanation is being prepared.' : 'The explanation is incomplete. Your calculated results are available.'}</p>
        <TabularAnalysisView analysis={partial.analysis} runId={savedResultRun!.id} onSource={onSource} heading="Performance overview"/>
      </article> : partialSource ? <article className="agent-document-paper has-visual-analysis" ref={articleRef} tabIndex={-1} aria-labelledby={headingId}>
        <span className="agent-document-kicker">Rivet · source review</span><h1 id={headingId}>{sourceReportTitle(partialSource.result)}</h1>
        <p className="agent-report-status" role="status">{documentWorking ? 'The explanation is being prepared.' : 'The explanation is incomplete. Your calculated results are available.'}</p>
        <SourceAnalysisView runId={savedResultRun!.id} key={partialSource.result.id} analysis={partialSource} onSource={onSource}/>
      </article> : <div className="agent-output-empty"><FileText size={30} strokeWidth={1.2} /><h1>{working ? 'Your document will appear here' : 'No document was saved'}</h1><p>{working ? 'Follow the recorded work in the conversation while Rivet works with your sources.' : 'The task’s recorded activity is preserved. You can use it to prepare a follow-up.'}</p><small>{requestTitle.length > 220 ? requestTitle.slice(0, 220) + '…' : requestTitle}</small></div>}</div>
    </section>}
  </section>;
}
