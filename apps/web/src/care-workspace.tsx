import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, CircleAlert, CircleHelp, Clock3, Database, FileCheck2, FileText, Inbox, Layers, Mail, Play, Plus, RefreshCw, Search, ShieldCheck, Square, Timer, UserRound, X } from 'lucide-react';
import type { CareActorId, CareAnalysis, CareCase, CareCaseSummary, CareDocument, CareField, CareOverview, CareStatus } from '../../../packages/core/src/care-types';
import type { WorkspaceStatus } from '../../../packages/core/src/types';
import { api, ApiError, message } from './api';
import { clearCareRequest, keepCareRequest, readCareRequest, type CareRequest } from './care-client';
import { careCheckLabel, careFollowUpNextStep, careNeedsAttention, viewedCurrentCareEvidence } from './care-presentation';
import type { View } from './navigation';
import './care.css';

type Mode = 'queue' | 'worklist' | 'intake' | 'benchmarks';
type Props = { mode: Mode; caseId: string | null; onCase: (id: string | null) => void; onNavigate: (view: View) => void; workspace: WorkspaceStatus | null; onRefreshWorkspace: () => Promise<void> };
const statusLabels: Record<CareStatus, string> = { received: 'Received', needs_information: 'Missing information', needs_identity_review: 'Identity review', needs_clinical_review: 'Clinical review', ready_for_review: 'Ready for review', approved: 'Approved', handed_off: 'Handed off' };
const fieldLabels: Record<CareField, string> = { signed_form: 'Signed referral form', contact_confirmed: 'Contact details', requested_service: 'Requested service', supporting_documents: 'Supporting documents', identity_consistent: 'Matching identity', clinical_question: 'Clinical question' };
const channelNames = { fax: 'Demo fax inbox', mailbox: 'Demo referral mailbox', ehr: 'Demo EHR records' };
const channelIcons = { fax: Inbox, mailbox: Mail, ehr: Database };
const intakeChannels = [{ id: 'all', label: 'All channels', icon: Layers }, { id: 'fax', label: 'Fax', icon: Inbox }, { id: 'mailbox', label: 'Mailbox', icon: Mail }, { id: 'ehr', label: 'EHR', icon: Database }] as const;
type IntakeChannel = typeof intakeChannels[number]['id'];
type IntakeStatus = 'awaiting' | 'received' | 'all';
const formatDate = (v: string) => new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const duration = (ms: number | null) => ms === null ? 'Not measured' : ms < 60000 ? `${(ms / 1000).toFixed(1)} sec` : `${(ms / 60000).toFixed(1)} min`;
const running = (a?: CareAnalysis | null) => a?.status === 'queued' || a?.status === 'running';
const latestAnalysis = (item: CareCase) => item.analyses.find(a => a.id === item.latestAnalysisId) ?? null;
function initialRequest() { try { return { request: readCareRequest(), error: '' }; } catch (e) { return { request: null, error: message(e) }; } }
function initialActor(): CareActorId { try { const id = sessionStorage.getItem('rivetfields.care.actor'); return ['intake', 'reviewer', 'clinician', 'supervisor'].includes(id ?? '') ? id as CareActorId : 'intake'; } catch { return 'intake'; } }
function Status({ item }: { item: CareCaseSummary }) { return <span className={`care-status ${item.status}`}>{item.documentCount ? statusLabels[item.status] : 'Awaiting intake'}</span>; }

export function CareWorkspace({ mode, caseId, onCase, onNavigate, workspace, onRefreshWorkspace }: Props) {
  const [overview, setOverview] = useState<CareOverview | null>(null);
  const [record, setRecord] = useState<CareCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [recordLoading, setRecordLoading] = useState(false);
  const [error, setError] = useState('');
  const [updateError, setUpdateError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [refreshingConnection, setRefreshingConnection] = useState(false);
  const [recordError, setRecordError] = useState('');
  const [notice, setNotice] = useState('');
  const [actorId, setActorId] = useState<CareActorId>(initialActor);
  const [initial] = useState(initialRequest);
  const [pending, setPending] = useState<CareRequest | null>(initial.request);
  const [pendingError, setPendingError] = useState(initial.error);
  const [busy, setBusy] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [intakeChannel, setIntakeChannel] = useState<IntakeChannel>('all');
  const [intakeStatus, setIntakeStatus] = useState<IntakeStatus>('awaiting');
  const [tab, setTab] = useState<'overview' | 'documents' | 'activity' | 'history'>('overview');
  const [document, setDocument] = useState<CareDocument | null>(null);
  const [sourceQuote, setSourceQuote] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [schedule, setSchedule] = useState<{ id?: string; name: string; everyMinutes: number; enabled: boolean } | null>(null);
  const [inputRate, setInputRate] = useState('');
  const [outputRate, setOutputRate] = useState('');
  const [replayId, setReplayId] = useState('');
  const [tick, setTick] = useState(Date.now());
  const inFlight = useRef(false);
  const currentCaseId = useRef(caseId);
  currentCaseId.current = caseId;
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const actor = overview?.actors.find(a => a.id === actorId);
  const may = (grant: string) => Boolean(actor?.grants.includes(grant));
  const actorName = (id: string) => overview?.actors.find(a => a.id === id)?.name.split(' · ')[0] ?? (id === 'model' ? 'Agent' : id === 'system' ? 'System' : id);
  const blocked = busy || !!pending || !!pendingError;

  const loadOverview = useCallback(async () => { const value = await api<CareOverview>('/api/care/overview'); setOverview(value); return value; }, []);
  const loadRecord = useCallback(async () => { if (!caseId) return; const value = await api<CareCase>(`/api/care/cases/${encodeURIComponent(caseId)}`); if (currentCaseId.current === caseId) { setRecord(value); setRecordError(''); } return value; }, [caseId]);
  useEffect(() => { let disposed = false; setLoading(true); loadOverview().catch(e => { if (!disposed) setUpdateError(message(e)); }).finally(() => { if (!disposed) setLoading(false); }); return () => { disposed = true; }; }, [loadOverview]);
  useEffect(() => {
    setRecord(null); setRecordError(''); setTab('overview'); setNote('');
    if (!caseId) { setRecordLoading(false); return; }
    let disposed = false; setRecordLoading(true);
    api<CareCase>(`/api/care/cases/${encodeURIComponent(caseId)}`).then(value => { if (!disposed) setRecord(value); }).catch(e => { if (!disposed) setRecordError(message(e)); }).finally(() => { if (!disposed) setRecordLoading(false); });
    return () => { disposed = true; };
  }, [caseId]);
  const hasActive = overview?.cases.some(c => c.analysisStatus === 'queued' || c.analysisStatus === 'running') || record?.analyses.some(running);
  const watchSchedule = mode === 'worklist' && overview?.schedules.some(s => s.enabled);
  useEffect(() => {
    if (!hasActive && !watchSchedule) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const values = await Promise.all([api<CareOverview>('/api/care/overview'), caseId ? api<CareCase>(`/api/care/cases/${encodeURIComponent(caseId)}`) : Promise.resolve(null)]); if (!disposed) { setOverview(values[0]); if (values[1]) setRecord(values[1]); setUpdateError(''); } }
      catch (e) { if (!disposed) { setUpdateError(`Updates paused. ${message(e)}`); return; } }
      if (!disposed) timer = setTimeout(poll, hasActive ? 1200 : 5000);
    }
    timer = setTimeout(poll, 1000); return () => { disposed = true; clearTimeout(timer); };
  }, [Boolean(hasActive), Boolean(watchSchedule), caseId, pollGeneration]);
  useEffect(() => { if (record?.timers.some(t => !t.stoppedAt) || hasActive) { const timer = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(timer); } }, [record?.timers, hasActive]);
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, [caseId, mode]);
  useEffect(() => { if (document) sourceDialog.current?.showModal(); else sourceDialog.current?.close(); }, [document]);
  function chooseActor(value: CareActorId) { setActorId(value); setNote(''); try { sessionStorage.setItem('rivetfields.care.actor', value); } catch { setNotice('Demo role changed for this visit. This browser could not remember it for reload.'); } }
  async function refreshAll() { setPollGeneration(n => n + 1); try { await Promise.all([loadOverview(), loadRecord()]); setUpdateError(''); } catch (e) { setUpdateError(message(e)); } }
  async function refreshConnection() {
    setRefreshingConnection(true); setConnectionError('');
    try { await Promise.all([onRefreshWorkspace(), loadOverview(), loadRecord()]); setUpdateError(''); setPollGeneration(n => n + 1); }
    catch (e) { setConnectionError(`Status could not be refreshed. ${message(e)}`); }
    finally { setRefreshingConnection(false); }
  }
  async function mutate(path: string, body: Record<string, string | number | boolean>, label: string, retry?: CareRequest): Promise<boolean> {
    if (inFlight.current || (!retry && (pending || pendingError))) return false;
    const request: CareRequest = retry ?? { version: 1, path, label, body: { ...body, actorId, requestId: crypto.randomUUID() } };
    try { keepCareRequest(request); setPending(request); } catch (e) { setError(message(e)); return false; }
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await api(request.path, { method: 'POST', body: JSON.stringify(request.body) });
      try { clearCareRequest(); setPending(null); setPendingError(''); }
      catch (e) { setError(message(e)); await refreshAll(); return false; }
      setNotice(`${request.label} confirmed.`); await refreshAll(); return true;
    } catch (e) {
      setError(message(e));
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) { try { clearCareRequest(); setPending(null); } catch (clearError) { setError(`${message(e)} ${message(clearError)}`); } await refreshAll(); }
      return false;
    } finally { inFlight.current = false; setBusy(false); }
  }
  function action(suffix: string, body: Record<string, string | number | boolean>, label: string) { if (!record) return Promise.resolve(false); return mutate(`/api/care/cases/${encodeURIComponent(record.id)}/${suffix}`, { caseVersion: record.version, ...body }, label); }
  function openCaseTab(next: typeof tab) { setTab(next); requestAnimationFrame(() => window.document.getElementById(`care-tab-${next}`)?.focus()); }
  function showDocument(id: string | null, quote: string | null = null) { const source = record?.documents.find(d => d.id === id); if (source) { setDocument(source); setSourceQuote(quote); } }
  async function review(decision: 'approve' | 'request_changes' | 'resolve_identity' | 'resolve_clinical') { if (!note.trim()) { setError('Add a short review note so the next person knows what you checked.'); return; } if (await action('review', { decision, note: note.trim() }, decision === 'approve' ? 'Approval' : decision === 'request_changes' ? 'Change request' : decision === 'resolve_identity' ? 'Identity resolution' : 'Clinical review')) setNote(''); }
  const feedback = <>{updateError && <div className="care-alert" role="alert"><span>{updateError}</span><button onClick={() => void refreshAll()}><RefreshCw size={13} />Refresh records</button></div>}{error && <div className="care-alert" role="alert"><span>{error}</span><button onClick={() => void refreshAll()}><RefreshCw size={13} /> Refresh records</button></div>}{pendingError && <div className="care-alert" role="alert"><span>{pendingError}</span><button onClick={() => { const next = initialRequest(); setPending(next.request); setPendingError(next.error); }}>Retry recovery</button></div>}{pending && <div className="care-alert care-pending" role="status"><span><strong>{pending.label}</strong> needs confirmation. Retry uses the same request, role, and version.</span><button disabled={busy} onClick={() => void mutate(pending.path, pending.body, pending.label, pending)}>{busy ? 'Checking…' : 'Resolve pending action'}</button></div>}{notice && <p className="care-notice" role="status"><Check size={13} />{notice}</p>}</>;
  const pageTitle = mode === 'queue' ? 'Referrals' : mode === 'worklist' ? 'Follow-ups' : mode === 'intake' ? 'Intake' : 'Benchmark report';
  const roleControl = <label className="care-role"><UserRound size={14} /><select aria-label="Demo role" title="Simulated actor · not a signed-in identity" value={actorId} disabled={blocked} onChange={e => chooseActor(e.target.value as CareActorId)}>{overview?.actors.map(a => <option key={a.id} value={a.id}>{a.name.split(' · ')[0]} · {a.role}</option>)}</select></label>;
  const demoBadge = <span className="care-demo-badge" title="Fictional documents, simulated roles, intake and handoffs. No external patient systems are connected.">Fictional demo</span>;
  const visibleCases = overview?.cases.filter(c => `${c.id} ${c.title} ${c.department} ${actorName(c.ownerId)}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || filter === 'attention' && careNeedsAttention(c) || filter === 'ready' && ['ready_for_review', 'approved'].includes(c.status) || filter === 'done' && c.status === 'handed_off')) ?? [];
  const arrivalsForStatus = overview?.arrivals.filter(arrival => intakeStatus === 'all' || (intakeStatus === 'received' ? arrival.delivered : !arrival.delivered)) ?? [];
  const visibleArrivals = arrivalsForStatus.filter(arrival => intakeChannel === 'all' || arrival.channel === intakeChannel);
  const documentRow = (doc: CareDocument) => <button className="care-document-row" key={doc.id} onClick={() => showDocument(doc.id)}><FileText size={17} /><span><strong>{doc.title}</strong><small>{channelNames[doc.channel]} · v{doc.caseVersion} · {formatDate(doc.receivedAt)}</small></span><ChevronRight size={14} /></button>;

  if (loading && !overview) return <div className="loading-state" role="status">Opening the referral workspace…</div>;
  return <div className={`care-workspace ${caseId ? 'care-reading-case' : `care-library care-${mode}`}`}>
    {caseId ? <>
      <header className="care-case-top"><button className="care-icon-button care-back" aria-label="Back to referrals" onClick={() => onCase(null)}><ArrowLeft size={17} /></button><div className="care-case-identity"><h1 ref={titleRef} tabIndex={-1}>{record?.title ?? 'Referral'}</h1><span>{record?.id ?? caseId}{record && ` · v${record.version}`}</span></div>{record && <Status item={record} />}<div className="care-header-tools">{demoBadge}{roleControl}</div></header>
      {feedback}
      {recordError && <div className="care-alert" role="alert"><span>{recordError}</span><button onClick={() => void loadRecord().catch(e => setRecordError(message(e)))}>Reload case</button></div>}
      {recordLoading ? <p className="care-empty" role="status">Opening the case record…</p> : record && (() => {
        const analysis = latestAnalysis(record);
        const current = analysis?.caseVersion === record.version ? analysis : null;
        const completed = current?.status === 'completed';
        const viewed = viewedCurrentCareEvidence(record, actorId);
        const isReviewer = may('approve');
        const hasApproval = record.status === 'approved' || record.status === 'handed_off';
        const approval = record.reviews.find(review => review.id === record.approvalId && !review.stale);
        const stale = record.staleAnalysis || (!hasApproval && (record.reviews.some(r => r.stale) || record.receipts.some(r => r.stale)));
        const canAnalyze = may('analyze') && record.documentCount > 0 && !running(analysis) && workspace?.provider.available;
        const readControl = <div className={`care-view-check ${viewed ? 'is-read' : ''}`}>
          {viewed ? <span><Check size={13} />Current evidence reviewed</span> : <button className="button secondary" disabled={blocked || !may('view') || !completed} onClick={() => void action('view', {}, 'Version view')}><BookOpen size={13} />Mark version as read</button>}
        </div>;
        const reviewNote = <label className="care-label">Review note<textarea value={note} maxLength={1600} rows={3} placeholder="What did you check?" onChange={e => setNote(e.target.value)} disabled={blocked} /></label>;
        return <>
          {stale && <div className="care-version-alert" role="status"><RefreshCw size={15} /><span>The packet changed. Review v{record.version}; earlier decisions remain in history.</span></div>}
          <div className="care-case-layout">
            <aside className="care-review-pane" aria-label="Review and next step">
              <button className="care-packet-shortcut" onClick={() => openCaseTab('documents')}><FileText size={18} /><span><strong>Source packet</strong><small>{record.documentCount} {record.documentCount === 1 ? 'document' : 'documents'}</small></span><ArrowRight size={14} /></button>
              <section className="care-review-card"><h2>{record.status === 'handed_off' ? 'Handoff recorded' : record.status === 'approved' ? 'Ready to hand off' : completed ? 'Next step' : running(analysis) ? 'Analysis in progress' : 'Check this packet'}</h2>
                <p>{running(analysis) ? 'The agent is reading the packet. Its saved work appears in Activity.' : careFollowUpNextStep(record)}</p>
                {!record.documentCount ? <button className="button primary" onClick={() => onNavigate('connections')}>Receive a packet<ArrowRight size={13} /></button>
                : !completed ? <>{!running(analysis) && <><button className="button primary" disabled={blocked || !canAnalyze} onClick={() => void action('analyze', {}, 'Referral analysis')}><Play size={13} />Analyze packet</button>{!workspace?.provider.available ? <button className="care-link care-section-link" onClick={() => onNavigate('connections')}>Check model connection<ArrowRight size={12} /></button> : !may('analyze') && <p className="care-caption">Choose intake, reviewer, or supervisor to analyze.</p>}</>}</>
                : record.status === 'handed_off' ? <button className="button secondary" onClick={() => openCaseTab('history')}><FileCheck2 size={13} />View receipt</button>
                : record.status === 'approved' ? <>{approval && <details className="care-approval-summary"><summary>Approved by {actorName(approval.actorId)}</summary><p>{approval.note}</p><small>{formatDate(approval.createdAt)}</small></details>}{!viewed && readControl}<button className="button primary" disabled={blocked || !may('handoff') || !viewed} onClick={() => void action('handoff', {}, 'Simulated handoff')}>Send simulated handoff<ArrowRight size={13} /></button>{!may('handoff') && <p className="care-caption">Choose reviewer or supervisor to hand off.</p>}</>
                : record.status === 'needs_information' ? <><button className="button secondary" onClick={() => onNavigate('connections')}>Check incoming documents<ArrowRight size={13} /></button><details className="care-disclosure care-review-options"><summary>Record a review</summary>{readControl}{reviewNote}<button className="button secondary" disabled={blocked || !isReviewer || !viewed || !note.trim()} onClick={() => void review('request_changes')}>Request changes</button>{!isReviewer && <p className="care-caption">Choose reviewer or supervisor to record a decision.</p>}</details></>
                : <>{readControl}{viewed && <>{reviewNote}{record.status === 'needs_identity_review' ? <button className="button primary" disabled={blocked || !may('resolve_identity') || !note.trim()} onClick={() => void review('resolve_identity')}>Record identity resolution</button> : record.status === 'needs_clinical_review' ? <button className="button primary" disabled={blocked || !may('resolve_clinical') || !note.trim()} onClick={() => void review('resolve_clinical')}>Record clinical review</button> : <button className="button primary" disabled={blocked || !isReviewer || record.status !== 'ready_for_review' || !note.trim()} onClick={() => void review('approve')}>Approve this version</button>}<button className="care-link care-section-link" disabled={blocked || !isReviewer || !note.trim()} onClick={() => void review('request_changes')}>Request changes</button></>}
                  {record.status === 'needs_identity_review' && !may('resolve_identity') && <p className="care-caption">Choose supervisor to resolve identity.</p>}{record.status === 'needs_clinical_review' && !may('resolve_clinical') && <p className="care-caption">Choose clinician to record clinical review.</p>}{record.status === 'ready_for_review' && !isReviewer && <p className="care-caption">Choose reviewer or supervisor to approve.</p>}
                </>}
              </section>
              <details className="care-disclosure care-case-meta"><summary>Case details<span>{actorName(record.ownerId)}</span></summary><p>{record.description}</p><label className="care-label">Owner<select aria-label="Case owner" value={record.ownerId} disabled={blocked || !may('assign')} onChange={e => void action('assign', { ownerId: e.target.value }, 'Owner change')}>{overview?.actors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><dl><dt>Department</dt><dd>{record.department}</dd><dt>Received</dt><dd>{record.receivedAt ? formatDate(record.receivedAt) : 'Awaiting intake'}</dd><dt>Updated</dt><dd>{formatDate(record.updatedAt)}</dd></dl></details>
              <details className="care-disclosure care-timing"><summary><Timer size={13} />Measure human work</summary><p>Stopped wall-clock timers appear in Benchmark.</p>{(['manual_baseline', 'review'] as const).map(kind => { const timer = record.timers.find(t => t.actorId === actorId && t.kind === kind && !t.stoppedAt); return <div key={kind}><span>{kind === 'manual_baseline' ? 'Manual baseline' : 'Human review'}{timer && <small>{duration(Math.max(0, tick - Date.parse(timer.startedAt)))}</small>}</span><button className="care-link" disabled={blocked || !may('timer')} onClick={() => void mutate(`/api/care/cases/${record.id}/timer`, { kind, action: timer ? 'stop' : 'start' }, timer ? 'Timer stop' : 'Timer start')}>{timer ? <Square size={11} /> : <Play size={11} />}{timer ? 'Stop' : 'Start'}</button></div>; })}<button className="care-link care-section-link" onClick={() => onNavigate('care-benchmarks')}>Open benchmark<ArrowRight size={12} /></button></details>
              <details className="care-disclosure care-rules"><summary>Review requirements</summary><ul><li>Signed form, confirmed contact, requested service and supporting documents.</li><li>Identity is consistent, or resolved by a supervisor after correction evidence.</li><li>No open clinical question, or a clinician’s recorded review.</li><li>A reviewer views the completed current analysis before approval.</li></ul><p>New evidence requires fresh approval. Roles and handoffs are simulated; no appointment or external message is created.</p></details>
              {completed && <details className="care-disclosure"><summary>Run another check</summary><p>A new analysis keeps the history and requires fresh approval.</p><button className="button secondary" disabled={blocked || !canAnalyze} onClick={() => void action('analyze', {}, 'Referral analysis')}><Play size={13} />Run check again</button></details>}
            </aside>
            <div className="care-case-main">
              <div className="care-tabs" role="tablist" aria-label="Case details">{(['overview', 'documents', 'activity', 'history'] as const).map(t => <button key={t} role="tab" id={`care-tab-${t}`} aria-controls={`care-panel-${t}`} aria-selected={tab === t} tabIndex={tab === t ? 0 : -1} onClick={() => setTab(t)} onKeyDown={e => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault(); const tabs = ['overview', 'documents', 'activity', 'history'] as const; const index = tabs.indexOf(t);
                const next = e.key === 'Home' ? 0 : e.key === 'End' ? 3 : (index + (e.key === 'ArrowRight' ? 1 : 3)) % 4;
                setTab(tabs[next]); window.document.getElementById(`care-tab-${tabs[next]}`)?.focus();
              }}>{t === 'overview' ? 'Review' : t === 'documents' ? `Documents · ${record.documents.length}` : t[0].toUpperCase() + t.slice(1)}</button>)}</div>
              <div role="tabpanel" id={`care-panel-${tab}`} aria-labelledby={`care-tab-${tab}`} className="care-tab-panel">
                {tab === 'overview' && <section className="care-artifact">
                  <header className="care-artifact-heading"><span className="care-caption">{record.department} · Version {record.version}</span><h2>Packet review</h2></header>
                  {running(analysis) ? <div className="care-analysis-progress" role="status"><div><span className="care-live-dot" /><strong>{analysis?.status === 'queued' ? 'Waiting for the agent' : 'Checking the packet'}</strong><span>{duration(Math.max(0, tick - Date.parse(analysis!.createdAt)))}</span></div><p>{record.events.filter(e => e.actorId === 'model').at(-1)?.summary || 'Waiting for recorded activity.'}</p><button className="care-link" disabled={blocked || !may('analyze')} onClick={() => void mutate(`/api/care/analyses/${analysis!.id}/cancel`, {}, 'Analysis stop')}><Square size={12} />Stop analysis</button></div>
                  : completed ? <>
                    <p className="care-findings">{current.explanation || 'Review the findings against their source documents.'}</p>
                    <div className="care-checks">{current.checks.map(check => {
                      const proposal = current.proposals.find(p => p.field === check.field);
                      const resolved = record.reviews.some(r => !r.stale && r.decision === (check.field === 'identity_consistent' ? 'resolve_identity' : 'resolve_clinical'));
                      return <div className="care-check" key={check.field}>
                        <span className={`care-check-mark ${check.result}`} aria-hidden="true">{check.result === 'pass' ? <Check size={16} /> : check.result === 'unknown' ? <CircleHelp size={16} /> : <CircleAlert size={16} />}</span>
                        <div className="care-check-content"><strong>{fieldLabels[check.field]}</strong><details className="care-evidence"><summary><ChevronRight size={12} />{proposal?.quote ? 'View evidence' : 'View details'}</summary><p>{check.explanation}</p>{proposal?.quote && <><blockquote>{proposal.quote}</blockquote><button className="care-link" onClick={() => showDocument(proposal.documentId, proposal.quote)}><FileText size={13} />Open source<ArrowRight size={12} /></button></>}</details></div>
                        <span className={`care-check-result ${check.result}`}>{careCheckLabel(check, proposal, resolved)}</span>
                      </div>;
                    })}</div>
                  </> : <div className="care-analysis-empty"><FileCheck2 size={25} strokeWidth={1.3} /><h3>{current?.status === 'failed' ? 'The check did not finish' : current?.status === 'cancelled' ? 'Analysis was stopped' : current?.status === 'interrupted' ? 'Analysis was interrupted' : 'Ready for a first pass'}</h3><p>{current?.error || (record.documentCount ? 'Analyze the received documents to prepare this review.' : 'Receive a sample packet from Intake to begin.')}</p>{current?.error && <button className="care-link" onClick={() => setTab('activity')}>Inspect saved activity<ArrowRight size={12} /></button>}</div>}
                </section>}
                {tab === 'documents' && <section className="care-artifact"><h2>Source packet</h2>{record.documents.map(documentRow)}{!record.documents.length && <p className="care-empty">No documents have arrived.</p>}<button className="care-link care-section-link" onClick={() => onNavigate('connections')}>Receive documents<ArrowRight size={12} /></button></section>}
                {tab === 'activity' && <section className="care-artifact"><h2>Recorded activity</h2><p className="care-caption">Saved actions and tool results.</p><ol className="care-timeline">{[...record.events].sort((a, b) => a.sequence - b.sequence).map(event => <li key={event.id}><span className={`care-timeline-dot ${event.actorId}`} /><div><div className="care-event-heading"><strong>{actorName(event.actorId)}</strong><span>v{event.caseVersion} · {formatDate(event.createdAt)}</span></div><p>{event.summary}</p>{event.detail !== undefined && <details><summary>Details</summary><pre>{JSON.stringify(event.detail, null, 2)}</pre></details>}</div></li>)}</ol>{!record.events.length && <p className="care-empty">No actions recorded.</p>}</section>}
                {tab === 'history' && <section className="care-artifact"><h2>Decisions and handoffs</h2>
                  {record.reviews.map(review => <article className="care-history-entry" key={review.id}><div><ShieldCheck size={15} /><strong>{review.decision.replaceAll('_', ' ')}</strong><span className="care-tag">{review.stale ? 'Earlier decision' : `v${review.caseVersion}`}</span></div><p>{review.note}</p><small>{actorName(review.actorId)} · v{review.caseVersion} · {formatDate(review.createdAt)}</small></article>)}
                  {record.receipts.map(receipt => <article className="care-history-entry" key={receipt.id}><div><FileCheck2 size={15} /><strong>Simulated handoff</strong><span className="care-tag">{receipt.stale ? 'Earlier decision' : `v${receipt.caseVersion}`}</span></div><small>{actorName(receipt.actorId)} · {formatDate(receipt.createdAt)}</small><details><summary>Open receipt</summary><pre>{receipt.payload}</pre><small>{receipt.id}</small></details></article>)}
                  {!record.reviews.length && !record.receipts.length && <p className="care-empty">No decisions recorded yet.</p>}
                  <details className="care-disclosure care-history-analyses"><summary>Analysis history · {record.analyses.length}</summary>{record.analyses.map(a => <article className="care-history-entry" key={a.id}><div><strong>Version {a.caseVersion}</strong><span>{a.status}</span></div><p>{a.explanation || a.error || 'No findings recorded.'}</p><small>{formatDate(a.createdAt)} · {duration(a.elapsedMs)} · {a.model || 'Model not reported'}</small>{a.benchmark && <small>Fixture field agreement: {a.benchmark.matched}/{a.benchmark.total}</small>}<details><summary>Saved proposals</summary><pre>{JSON.stringify(a.proposals, null, 2)}</pre></details></article>)}</details>
                </section>}
              </div>
            </div>
          </div>
        </>;
      })()}
    </> : <>
      <header className="care-page-heading"><div><div className="care-title-line"><h1 ref={titleRef} tabIndex={-1}>{pageTitle}</h1>{demoBadge}</div><p>{mode === 'queue' ? 'Review packets and move referrals forward.' : mode === 'worklist' ? 'Outstanding follow-ups and their next step.' : mode === 'intake' ? 'Receive sample documents from simulated channels.' : 'Recorded model work and observed human review.'}</p></div><div className="care-page-actions">{roleControl}{mode === 'queue' && <button className="button primary" onClick={() => onNavigate('connections')}><Plus size={13} />Receive documents</button>}</div></header>
      {feedback}
      {overview && mode === 'queue' && <>
        <div className="care-toolbar"><div className="care-filters" aria-label="Filter referrals">{[['all', 'All referrals'], ['attention', 'Needs attention'], ['ready', 'Ready'], ['done', 'Handed off']].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}{id === 'all' && <span>{overview.cases.length}</span>}</button>)}</div><label className="care-search"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search" aria-label="Search referrals" /></label><button className="care-icon-button" aria-label="Refresh queue" onClick={() => void refreshAll()}><RefreshCw size={14} /></button></div>
        <div className="care-table-scroll" role="region" aria-label="Referral queue table" tabIndex={0}><table className="care-queue-table"><thead><tr><th>Referral</th><th>Status</th><th>Owner</th><th>Latest step</th><th><span className="sr-only">Open case</span></th></tr></thead><tbody>{visibleCases.map(c => <tr key={c.id}><td><button className="care-case-link" onClick={() => onCase(c.id)}><span className="care-case-icon"><FileText size={17} /></span><span><strong>{c.title}</strong><small>{c.id}</small></span></button></td><td><Status item={c} />{c.overdue && <small className="care-overdue">Follow-up due</small>}</td><td>{actorName(c.ownerId)}</td><td><span className={`care-latest-step ${['failed', 'cancelled', 'interrupted'].includes(c.analysisStatus ?? '') ? 'care-step-attention' : ''}`}>{c.analysisStatus === 'running' || c.analysisStatus === 'queued' ? 'Checking packet' : c.staleAnalysis ? 'New documents' : c.analysisStatus === 'failed' ? 'Analysis failed · retry' : c.analysisStatus === 'cancelled' ? 'Analysis stopped · retry' : c.analysisStatus === 'interrupted' ? 'Analysis interrupted · retry' : c.receiptId ? 'Handoff recorded' : c.approvalId ? 'Review approved' : c.analysisStatus === 'completed' ? 'Analysis ready' : c.documentCount ? `${c.documentCount} documents received` : 'Awaiting intake'}</span></td><td><button className="care-icon-button" aria-label={`Open ${c.title}`} onClick={() => onCase(c.id)}><ChevronRight size={15} /></button></td></tr>)}</tbody></table>{!visibleCases.length && <p className="care-empty">No referrals match this view.</p>}</div>
        <div className="care-queue-footer"><details className="care-disclosure care-walkthrough"><summary>How this demo works</summary><p>Receive a fictional packet in Intake, analyze it, and review its source evidence. Switch roles to resolve issues and approve the current version, then create a simulated handoff. Use Follow-ups to track overdue cases.</p></details></div>
      </>}
      {overview && mode === 'intake' && <>
        {!may('ingest') && <p className="care-role-hint">Choose intake or supervisor to receive documents.</p>}
        <div className="care-intake-toolbar">
          <div className="care-channel-tabs" role="tablist" aria-label="Intake channels" onKeyDown={event => {
            const index = intakeChannels.findIndex(channel => channel.id === intakeChannel);
            const next = event.key === 'ArrowRight' ? (index + 1) % intakeChannels.length : event.key === 'ArrowLeft' ? (index + intakeChannels.length - 1) % intakeChannels.length : event.key === 'Home' ? 0 : event.key === 'End' ? intakeChannels.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault(); setIntakeChannel(intakeChannels[next].id); window.document.getElementById(`intake-channel-${intakeChannels[next].id}`)?.focus();
          }}>{intakeChannels.map(channel => <button key={channel.id} id={`intake-channel-${channel.id}`} type="button" role="tab" aria-selected={intakeChannel === channel.id} aria-controls="care-intake-packets" tabIndex={intakeChannel === channel.id ? 0 : -1} onClick={() => setIntakeChannel(channel.id)}><channel.icon size={15} />{channel.label}<span>{channel.id === 'all' ? arrivalsForStatus.length : arrivalsForStatus.filter(arrival => arrival.channel === channel.id).length}</span></button>)}</div>
          <label className="care-intake-status"><span className="sr-only">Packet status</span><select value={intakeStatus} onChange={event => setIntakeStatus(event.target.value as IntakeStatus)}><option value="awaiting">Awaiting intake</option><option value="received">Received</option><option value="all">All packets</option></select></label>
        </div>
        <div className="care-arrivals" id="care-intake-packets" role="tabpanel" aria-labelledby={`intake-channel-${intakeChannel}`} tabIndex={0}>{visibleArrivals.map(arrival => { const Icon = channelIcons[arrival.channel]; return <article key={arrival.id}><span className="care-case-icon"><Icon size={17} /></span><div><h2>{arrival.title}</h2><small>{arrival.caseId} · {arrival.channel === 'ehr' ? 'EHR' : arrival.channel} · {arrival.documentCount} {arrival.documentCount === 1 ? 'document' : 'documents'} · {arrival.initial ? 'Initial packet' : 'Additional documents'}</small></div>{arrival.delivered ? <button className="care-link" onClick={() => onCase(arrival.caseId)}><Check size={13} />Received<ArrowRight size={12} /></button> : <button className="button secondary" disabled={blocked || !may('ingest')} onClick={() => void mutate('/api/care/arrivals/ingest', { fixtureId: arrival.id }, 'Document intake').then(ok => { if (ok) onCase(arrival.caseId); })}>Receive packet</button>}</article>; })}{!visibleArrivals.length && <div className="care-empty care-intake-empty" role="status"><h2>{intakeStatus === 'awaiting' ? 'No packets awaiting intake' : intakeStatus === 'received' ? 'No received packets' : 'No packets'}{intakeChannel === 'all' ? '.' : ' in this channel.'}</h2><p>{intakeStatus === 'awaiting' ? 'Received packets are still available in the status filter.' : 'Choose another channel or view all packets.'}</p><button className="care-link" onClick={() => { setIntakeChannel('all'); setIntakeStatus('all'); }}>Show all packets<ArrowRight size={12} /></button></div>}</div>
        <details className="care-disclosure care-intake-settings"><summary>Intake settings and model connection{!workspace?.provider.available && <span className="care-step-attention">Model unavailable</span>}</summary><p>Fax, mailbox, and EHR arrivals are synthetic fixtures. Receiving a packet is an explicit action; no external accounts are connected.</p>{overview.arrivals.some(a => a.delivered) && <details className="care-disclosure"><summary>Test duplicate delivery</summary><p>Replay a received event to check that it does not add another document version.</p><label className="care-label">Received packet<select value={replayId || overview.arrivals.find(a => a.delivered)?.id || ''} onChange={e => setReplayId(e.target.value)}>{overview.arrivals.filter(a => a.delivered).map(a => <option key={a.id} value={a.id}>{a.id} · {a.title}</option>)}</select></label><button className="button secondary" disabled={blocked || !may('ingest')} onClick={() => { const fixtureId = replayId || overview.arrivals.find(a => a.delivered)?.id; if (fixtureId) void mutate('/api/care/arrivals/ingest', { fixtureId }, 'Delivery replay'); }}>Replay delivery</button></details>}<div className="care-model-connection"><h2>Workspace model · {workspace?.provider.available ? 'Available' : 'Unavailable'}</h2><p>{workspace?.provider.message ?? 'Refresh to check the model connection.'}</p>{workspace?.provider.model && <small>{workspace.provider.model}</small>}<p>The model endpoint and credentials are configured on the local workspace server.</p>{connectionError && <p role="alert">{connectionError}</p>}<button className="care-link" disabled={refreshingConnection} onClick={() => void refreshConnection()}><RefreshCw size={12} />{refreshingConnection ? 'Refreshing…' : 'Refresh intake status'}</button></div></details>
      </>}
      {overview && mode === 'worklist' && <>
        <div className="care-table-scroll" role="region" aria-label="Follow-ups table" tabIndex={0}><table className="care-queue-table care-followup-table"><thead><tr><th>Referral / next step</th><th>Owner</th><th>Due</th><th>Status</th><th><span className="sr-only">Resolve follow-up</span></th></tr></thead><tbody>{overview.followUps.map(f => { const currentCase = overview.cases.find(c => c.id === f.caseId); return <tr key={f.id}><td><button className="care-link care-followup-title" onClick={() => onCase(f.caseId)}>{currentCase?.title ?? f.caseId}<ArrowRight size={12} /></button><p>{careFollowUpNextStep(currentCase)}</p><details className="care-followup-details"><summary>{f.caseId} · {currentCase && currentCase.version !== f.caseVersion ? `recorded v${f.caseVersion}, current v${currentCase.version}` : `v${f.caseVersion}`}</summary><p>{f.summary}</p>{f.resolvedBy && <small>Resolved by {actorName(f.resolvedBy)}</small>}</details></td><td>{currentCase ? actorName(currentCase.ownerId) : 'Unknown'}</td><td>{formatDate(f.dueAt)}</td><td>{f.status === 'open' ? 'Open' : 'Resolved'}</td><td>{f.status === 'open' && <button className="button secondary" disabled={blocked || !may('followup')} onClick={() => void mutate(`/api/care/followups/${f.id}/resolve`, {}, 'Follow-up resolution')}>Resolve</button>}</td></tr>; })}</tbody></table>{!overview.followUps.length && <div className="care-empty"><h2>No follow-ups yet</h2><p>Scheduled checks add cases after they have waited 24 hours.</p></div>}</div>
        <details className="care-disclosure care-worklist-controls"><summary>Schedules and demo clock<span>{overview.schedules.filter(s => s.enabled).length} active</span></summary>
          <div className="care-section-heading"><h2>Follow-up schedules</h2><button className="care-link" disabled={blocked || !may('schedule')} onClick={() => setSchedule({ name: 'Referral follow-up', everyMinutes: 60, enabled: true })}><Plus size={13} />Add schedule</button></div>
          {overview.schedules.map(s => <div className="care-schedule-row" key={s.id}><Clock3 size={15} /><div><strong>{s.name}</strong><small>Every {s.everyMinutes} minutes · {s.enabled ? `next ${formatDate(s.nextDueAt)}` : 'Paused'}</small></div><span>{s.enabled ? 'Active' : 'Paused'}</span><button className="care-link" disabled={blocked || !may('schedule')} onClick={() => setSchedule({ id: s.id, name: s.name, everyMinutes: s.everyMinutes, enabled: s.enabled })}>Edit</button></div>)}
          {schedule && <form className="care-schedule-editor" onSubmit={e => { e.preventDefault(); const body = { name: schedule.name, enabled: schedule.enabled, everyMinutes: schedule.everyMinutes, ...(schedule.id ? { id: schedule.id } : {}) }; void mutate('/api/care/schedules', body, 'Schedule save').then(ok => { if (ok) setSchedule(null); }); }}><h3>{schedule.id ? 'Edit schedule' : 'New schedule'}</h3><label className="care-label">Name<input required maxLength={120} value={schedule.name} onChange={e => setSchedule({ ...schedule, name: e.target.value })} /></label><label className="care-label">Check every (minutes)<input required type="number" min={1} max={10080} value={schedule.everyMinutes} onChange={e => setSchedule({ ...schedule, everyMinutes: Number(e.target.value) })} /></label><label className="care-checkbox"><input type="checkbox" checked={schedule.enabled} onChange={e => setSchedule({ ...schedule, enabled: e.target.checked })} />Enabled</label><div><button type="button" className="button secondary" onClick={() => setSchedule(null)}>Cancel</button><button className="button primary" disabled={blocked || !may('schedule')}>Save schedule</button></div></form>}
          <div className="care-worklist-clock"><h2>Demo clock</h2><p>{formatDate(overview.simulatorNow)} · advanced {overview.offsetMinutes.toLocaleString()} minutes</p><div><button className="button secondary" disabled={blocked || !may('clock')} onClick={() => void mutate('/api/care/clock/advance', { minutes: 60 }, 'Demo clock advance')}>Advance 1 hour</button><button className="button secondary" disabled={blocked || !may('clock')} onClick={() => void mutate('/api/care/clock/advance', { minutes: 1440 }, 'Demo clock advance')}>Advance 1 day</button><button className="care-link" disabled={blocked || !may('sweep')} onClick={() => void mutate('/api/care/sweep', {}, 'Follow-up check')}>Check now<RefreshCw size={12} /></button></div><p className="care-caption">Supervisor controls. Cases waiting 24 hours become due for follow-up. The clock affects waiting time, not measured work time. Follow-ups stay internal; no messages are sent.</p></div>
        </details>
      </>}
      {overview && mode === 'benchmarks' && <article className="care-benchmark-report">
        <p className="care-report-lead">{overview.metrics.analyses.completed} analyses completed; {overview.metrics.analyses.failed} failed, {overview.metrics.analyses.cancelled} cancelled and {overview.metrics.analyses.interrupted} interrupted.</p>
        <section className="care-benchmark-table"><h2>Recorded results</h2><dl><dt>Average model elapsed time</dt><dd>{duration(overview.metrics.analyses.averageElapsedMs)}</dd><dt>Fixture field agreement</dt><dd>{overview.metrics.analyses.scoredFields ? `${overview.metrics.analyses.matchedFields} / ${overview.metrics.analyses.scoredFields}` : 'Not scored yet'}</dd><dt>Input tokens</dt><dd>{overview.metrics.analyses.inputTokens?.toLocaleString() ?? 'Not reported'}</dd><dt>Output tokens</dt><dd>{overview.metrics.analyses.outputTokens?.toLocaleString() ?? 'Not reported'}</dd><dt>Recorded handoffs</dt><dd>{overview.metrics.handoffs}</dd></dl></section>
        <section className="care-benchmark-table"><h2>Observed human work</h2><dl><dt>Manual baseline</dt><dd>{duration(overview.metrics.averageManualMs)}<small>{overview.metrics.manualSamples} stopped timers</small></dd><dt>Human review</dt><dd>{duration(overview.metrics.averageReviewMs)}<small>{overview.metrics.reviewSamples} stopped timers</small></dd></dl></section>
        <details className="care-disclosure"><summary>How to read these measurements</summary><p>Elapsed time includes finished attempts that failed. Field agreement compares actual proposals with synthetic fixture answers; it is not clinical accuracy or proof that an attempt passed validation. Missing provider usage stays unreported.</p><p>Human timers measure observed work and may cover different tasks. No time savings are assumed.</p></details>
        <details className="care-disclosure care-cost-assumptions"><summary>Estimate model cost</summary><p>Enter USD per million tokens. This uses your rates and reported usage; it is not a bill or a savings claim.</p><div><label className="care-label">Input rate ($ / million)<input type="number" min={0} step="any" value={inputRate} onChange={e => setInputRate(e.target.value)} /></label><label className="care-label">Output rate ($ / million)<input type="number" min={0} step="any" value={outputRate} onChange={e => setOutputRate(e.target.value)} /></label></div>{inputRate !== '' && outputRate !== '' && Number.isFinite(Number(inputRate)) && Number.isFinite(Number(outputRate)) && Number(inputRate) >= 0 && Number(outputRate) >= 0 && overview.metrics.analyses.inputTokens !== null && overview.metrics.analyses.outputTokens !== null ? <p>Estimated model cost: <strong>${((overview.metrics.analyses.inputTokens * Number(inputRate) + overview.metrics.analyses.outputTokens * Number(outputRate)) / 1000000).toFixed(4)}</strong></p> : <p className="care-caption">Both rates and reported token counts are needed.</p>}</details>
        <details className="care-disclosure care-benchmark-cases"><summary>Inspect case histories</summary>{overview.cases.map(c => <button className="care-document-row" key={c.id} onClick={() => onCase(c.id)}><FileText size={17} /><span><strong>{c.title}</strong><small>{c.id} · {c.analysisStatus ?? 'No analysis yet'}</small></span><ChevronRight size={14} /></button>)}</details>
      </article>}
    </>}
    <dialog className="care-source-dialog" ref={sourceDialog} aria-labelledby="care-source-title" onCancel={() => setDocument(null)} onClose={() => { setDocument(null); setSourceQuote(null); }}><header><span><FileText size={15} />Source document</span><button className="care-icon-button" aria-label="Close document" onClick={() => setDocument(null)}><X size={17} /></button></header>{document && <div><span className="care-tag">Fictional document · v{document.caseVersion}</span><h2 id="care-source-title">{document.title}</h2><p className="care-caption">{channelNames[document.channel]} · {formatDate(document.receivedAt)}</p>{sourceQuote && <blockquote><span>Cited evidence</span>{sourceQuote}</blockquote>}<pre>{document.content}</pre></div>}</dialog>
  </div>;
}
