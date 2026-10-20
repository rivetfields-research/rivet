import { ModuleSourceSelection } from './module-source-selection';
import { SavedTablesLibrary } from './workspace-extras';
import { WorkflowSchedulesWorkspace } from './workflow-schedules-workspace';
import { Dashboards } from './dashboards';
import { useEffect, useRef, useState, type ComponentType, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Bot, CalendarDays, Check, ChevronRight, FileText, Folder, GitBranch, Layers3, LayoutDashboard, Monitor, Pencil, Plus, Search, ShieldCheck, Sparkles, Table2, Trash2, Undo2 } from 'lucide-react';
import { clearEditorRecovery, loadDrafts, loadEditorRecovery, recoveryMatchesSaved, removeDraft, saveDraft, saveEditorRecovery, validateDraftFields, type DraftCollection, type ModuleView, type WorkspaceDraft } from './draft-store';
import type { Workflow, WorkspaceStatus } from '../../../packages/core/src/types';
import { api, message } from './api';
import { WorkflowWorkspace, workspaceProfileStorage } from './workflow-workspace';
import { readModuleState } from './module-state';
export type { ModuleView } from './draft-store';

type Icon = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
type Field = { key: string; label: string; placeholder?: string; multiline?: boolean; options?: string[]; type?: string; hint?: string };
type Definition = { title: string; noun: string; description: string; icon: Icon; fields: Field[]; note: string };
const definitions: Record<ModuleView, Definition> = {
  projects: { title: 'Projects', noun: 'project', description: 'Briefs and next steps for your team.', icon: Folder, note: 'Project briefs are saved in this browser. Tasks and sources can be opened from the workspace.', fields: [{ key: 'brief', label: 'Project brief', multiline: true, placeholder: 'What are we trying to understand or accomplish?' }, { key: 'outcome', label: 'Desired outcome', multiline: true, placeholder: 'What should a good result look like?' }] },
  workflows: { title: 'Workflows', noun: 'workflow', description: 'Repeatable work for your team.', icon: GitBranch, note: 'This is a workflow draft. The sequence is not connected to an execution engine.', fields: [{ key: 'trigger', label: 'Start', options: ['Manual', 'Schedule (planned)'] }, { key: 'instructions', label: 'Instructions', multiline: true, placeholder: 'Describe the work, the sources to use, and what to check.' }, { key: 'output', label: 'Output', multiline: true, placeholder: 'A concise report with source links and open questions.' }, { key: 'review', label: 'Review', multiline: true, placeholder: 'What should a person review before using the result?' }] },
  schedules: { title: 'Schedules', noun: 'schedule', description: 'Plan when work should happen.', icon: CalendarDays, note: 'Saved schedules are plans only. No background run or notification is scheduled.', fields: [{ key: 'workflow', label: 'Workflow' }, { key: 'frequency', label: 'Frequency', options: ['daily', 'weekly', 'monthly'] }, { key: 'day', label: 'Day' }, { key: 'time', label: 'Time', type: 'time' }, { key: 'timezone', label: 'Timezone', placeholder: 'America/New_York', hint: 'Use an IANA timezone. Daylight saving changes follow that timezone.' }] },
  applications: { title: 'Applications', noun: 'application', description: 'Focused tools for everyday work.', icon: Layers3, note: 'Application drafts describe the experience. No application is deployed or published.', fields: [{ key: 'audience', label: 'Who is it for?', placeholder: 'The people and decisions this application supports' }, { key: 'instructions', label: 'What should it do?', multiline: true, placeholder: 'Describe the tasks and information the application brings together.' }, { key: 'output', label: 'What should users get?', multiline: true, placeholder: 'Describe the result and what users can do next.' }] },
  playbooks: { title: 'Playbooks', noun: 'playbook', description: 'Reusable instructions for your team.', icon: BookOpen, note: 'Playbooks are reusable instructions. Preparing a task copies the text into your composer.', fields: [{ key: 'instructions', label: 'Instructions', multiline: true, placeholder: '1. Gather the relevant context.\n2. Compare the evidence.\n3. Explain what changed and why.' }, { key: 'output', label: 'Expected output', multiline: true, placeholder: 'Describe the shape and quality of the final result.' }] },
  skills: { title: 'Skills', noun: 'skill', description: 'Small, reusable ways of working.', icon: Sparkles, note: 'Skill drafts are instructions only. Saving one does not install a tool or change the running agent.', fields: [{ key: 'input', label: 'Input', placeholder: 'What context or material does this skill need?' }, { key: 'instructions', label: 'Instructions', multiline: true, placeholder: 'Describe the method, boundaries, and checks.' }, { key: 'output', label: 'Output', multiline: true, placeholder: 'What should this skill produce?' }] },
  agents: { title: 'Agents', noun: 'agent', description: 'Plan an agent’s role, tools, and limits.', icon: Bot, note: 'This configuration is a draft. It does not change the model, tools, or limits of the connected runtime.', fields: [{ key: 'instructions', label: 'Working instructions', multiline: true, placeholder: 'What is this agent responsible for? What should it ask before doing?' }, { key: 'model', label: 'Preferred model', placeholder: 'Model preference for a future connection' }, { key: 'tools', label: 'Requested tools', multiline: true, placeholder: 'List the capabilities this agent would need.' }, { key: 'budget', label: 'Planned step limit', type: 'number', hint: '1–100 steps. This limit is not applied to current tasks.' }] },
  computer: { title: 'Computer', noun: 'session plan', description: 'Plan a browser task.', icon: Monitor, note: 'Computer control is not connected. This plan does not open a browser or operate a website.', fields: [{ key: 'url', label: 'Starting URL', type: 'url', placeholder: 'https://example.com' }, { key: 'objective', label: 'Objective', multiline: true, placeholder: 'What should the agent accomplish in the browser?' }, { key: 'scope', label: 'Boundaries', multiline: true, placeholder: 'Which pages and actions are allowed? What needs your review?' }] },
  decks: { title: 'Decks', noun: 'deck brief', description: 'Outline your next presentation.', icon: Layers3, note: 'Slide generation is not connected. This saves the brief and outline, not a presentation file.', fields: [{ key: 'brief', label: 'Presentation brief', multiline: true, placeholder: 'What should your audience understand or decide?' }, { key: 'audience', label: 'Audience', placeholder: 'Who will see this presentation?' }, { key: 'sections', label: 'Slide outline', multiline: true, placeholder: 'One slide idea per line' }] },
  dashboards: { title: 'Dashboards', noun: 'dashboard brief', description: 'Define the measures your team needs.', icon: LayoutDashboard, note: 'Dashboard generation and live data are not connected. No metric values are being reported.', fields: [{ key: 'brief', label: 'Purpose', multiline: true, placeholder: 'What decisions should this dashboard support?' }, { key: 'metrics', label: 'Measures', multiline: true, placeholder: 'One measure per line, with its definition' }, { key: 'sources', label: 'Required sources', multiline: true, placeholder: 'Where should each measure come from?' }] },
  tables: { title: 'Tables', noun: 'table brief', description: 'Plan the information you need.', icon: Table2, note: 'This earlier browser brief has no data rows. Saved calculations are available in Tables.', fields: [{ key: 'brief', label: 'Purpose', multiline: true, placeholder: 'What should this table help you compare or manage?' }, { key: 'columns', label: 'Columns', multiline: true, placeholder: 'One column per line, with its type or meaning' }, { key: 'sources', label: 'Required sources', multiline: true, placeholder: 'Which documents or systems contain the information?' }] },
};
type Template = { name: string; description: string; fields: Record<string, string>; tone?: string };
const templates: Partial<Record<ModuleView, Template[]>> = {
  projects: [{ name: 'Explore a question', description: 'Keep a question, its evidence, and the desired result together.', fields: { brief: 'Review the approved workspace notes to understand the question at hand. Identify the relevant facts, compare the available evidence, and keep unanswered questions visible.', outcome: 'A short, sourced brief with findings, open questions, and a suggested next step.' } }],
  workflows: [
    { name: 'Research brief', description: 'Read the evidence, pull out the signal, and prepare a sourced brief.', fields: { trigger: 'Manual', instructions: 'Read the selected source notes. Identify the main findings, conflicting evidence, and unanswered questions. Cite the sources used.', output: 'A concise brief with key findings, source links, and open questions.', review: 'Review the evidence and uncertainty before sharing the brief.' } },
    { name: 'Decision review', description: 'Compare the available options and make trade-offs visible.', fields: { trigger: 'Manual', instructions: 'Define the decision and criteria. Compare the available options using the selected sources. Explain assumptions and missing information.', output: 'An options comparison and a recommendation with its limitations.', review: 'A person reviews the recommendation before taking action.' } },
  ],
  applications: [
    { name: 'Referral desk', description: 'Prepare administrative handoffs from approved referral notes.', tone: 'blue', fields: { audience: 'Referral intake and review staff', instructions: 'Use approved synthetic referral notes to summarize administrative completeness, missing documents, case ownership, and next steps. Cite the source evidence. Leave clinical questions to clinical staff; do not diagnose, approve coverage, or schedule care.', output: 'A sourced administrative handoff for staff review, with missing items and next steps.' } },
    { name: 'Planning room', description: 'Compare options and turn a decision into an actionable plan.', tone: 'sage', fields: { audience: 'People planning a project', instructions: 'Help users set an objective, compare options, identify dependencies, and prepare a plan for review.', output: 'A plan with decisions, next steps, and unresolved questions.' } },
    { name: 'Operations brief', description: 'Make recurring reviews easier to prepare and inspect.', tone: 'sand', fields: { audience: 'Teams running recurring reviews', instructions: 'Summarize changes in the provided notes. Identify exceptions and explain the evidence behind proposed next steps.', output: 'A recurring brief with evidence and review points.' } },
    { name: 'Document review', description: 'Read closely, surface inconsistencies, and propose clear changes.', tone: 'lilac', fields: { audience: 'People reviewing written work', instructions: 'Review a document for clarity, consistency, unsupported claims, and missing context. Keep suggestions separate from source text.', output: 'A prioritized review with specific suggested changes.' } },
  ],
  playbooks: [
    { name: 'Weekly review', description: 'Understand what changed and what needs attention.', fields: { instructions: '1. Read the relevant approved workspace notes.\n2. Summarize what changed.\n3. Identify risks and unanswered questions.\n4. Suggest next steps and cite the evidence.\n5. Mark anything that needs a person’s review.', output: 'A short review with findings, evidence, and next steps.' } },
    { name: 'Compare options', description: 'Make the evidence and trade-offs easy to review.', fields: { instructions: '1. Identify the decision and the options described in the approved notes.\n2. Compare them against the recorded criteria.\n3. Cite supporting evidence and separate assumptions from facts.\n4. Explain the trade-offs and what is still unknown. Do not invent missing costs or results.', output: 'An options comparison with supporting sources and questions to resolve.' } },
    { name: 'Prepare a handoff', description: 'Give the next person context and a clear next step.', fields: { instructions: '1. Read the relevant approved workspace notes.\n2. Summarize the objective, current state, and completed work.\n3. List open questions and proposed next steps. Name an owner only when the source records one.\n4. Cite the evidence and distinguish proposed actions from completed work.', output: 'A concise handoff with context, next steps, and source links. This is a draft for review; no message is sent.' } },
  ],
  skills: [
    { name: 'Source check', description: 'Match claims to their supporting evidence.', fields: { input: 'A draft and the approved source notes it cites', instructions: 'For each material claim, find the supporting passage. Identify unsupported statements, conflicting evidence, and missing context. Do not label unverified claims as verified.', output: 'A claim-by-claim list of evidence and remaining questions.' } },
    { name: 'Find open questions', description: 'Bring missing information and conflicting notes into view.', fields: { input: 'Approved workspace notes about a question or project', instructions: 'Read the relevant notes. Identify questions that the sources leave unanswered and separate them from contradictory statements. Cite the passages that establish each gap. Do not fill gaps with guesses.', output: 'A short list of open questions, each with source context and the information needed next.' } },
    { name: 'Write a clear brief', description: 'Turn scattered notes into an easy-to-read result.', fields: { input: 'Approved notes and the question the brief should answer', instructions: 'Lead with the answer the sources support. Group related findings, cite the evidence, and keep assumptions and limitations visible. Finish with concrete next steps. Preserve uncertainty instead of smoothing it over.', output: 'A concise brief with an answer, evidence, open questions, and next steps.' } },
  ],
};
const careSourceBoundary = 'Use only approved workspace notes and cite the supporting source for each finding. Keep missing information separate from contradictory evidence. Treat an explicit “none” differently from information that was not recorded. If these sources do not contain the requested packet, say so; do not imply access to a live patient record. Label fictional source material as fictional. Do not make clinical, coverage, or scheduling decisions, send messages, or change a case.';
const healthcareTemplates: Partial<Record<ModuleView, Template[]>> = {
  playbooks: [
    { name: 'Packet completeness brief', description: 'See what is present, missing, or inconsistent before staff review.', fields: { instructions: `1. Read the approved referral notes and completeness requirements.\n2. Check the signed form, contact details, requested service, supporting documents, and identity against the evidence.\n3. Separate present items, missing information, conflicting details, and matters needing a qualified reviewer.\n4. Cite each finding and identify the next administrative step. Ready means ready for staff review only.\n\n${careSourceBoundary}`, output: 'A short packet summary followed by a table: requirement, finding, source evidence, and next step. End with unresolved questions for staff review.' } },
    { name: 'Missing-information follow-up draft', description: 'Prepare a clear request for the items a packet still needs.', fields: { instructions: `1. Read the referral notes and identify the required items that are absent.\n2. List conflicting details separately for staff to resolve; do not guess which value is correct.\n3. Draft a short follow-up for a staff member to review, using only the necessary details.\n4. Use a placeholder when the recipient or responsible owner is not recorded. Do not claim the follow-up was sent.\n\n${careSourceBoundary}`, output: 'An unsent follow-up draft with the missing items, followed by source links and staff review questions. Clearly label it Draft — not sent.' } },
    { name: 'Staff handoff', description: 'Give the next person the case context and a sourced next step.', fields: { instructions: `1. Read the approved referral notes and recorded team responsibilities.\n2. Summarize the current administrative state, completed work, open questions, and next step.\n3. Include a named owner only when supported by the sources; otherwise write Owner not recorded.\n4. Keep recommendations separate from completed actions. Do not infer that approval, contact, or an appointment occurred.\n\n${careSourceBoundary}`, output: 'A concise administrative handoff with case identifier, current state, owner, missing or conflicting details, next step, and source links. Mark it For staff review.' } },
  ],
  skills: [
    { name: 'Check packet evidence', description: 'Match each completeness finding to what the source actually says.', fields: { input: 'Approved referral notes and the administrative completeness requirements', instructions: `Compare each requirement with the recorded passages. Report Present, Missing, Conflicting, or Not recorded as supported by the evidence. Quote the relevant text and cite its source. An explicit statement that no item or question exists is not the same as silence. Surface identity conflicts and clinical questions for the appropriate person rather than resolving them.\n\n${careSourceBoundary}`, output: 'A source-linked completeness table and a short list of questions requiring human review.' } },
    { name: 'Draft a missing-item request', description: 'Turn an evidence-backed gap list into a brief, unsent follow-up.', fields: { input: 'Approved referral notes, a list of missing items, and any recorded recipient or owner', instructions: `Check the gap list against the approved sources before drafting. Ask only for required items that are missing; flag contradictions for staff separately. Keep the wording brief and include no unnecessary personal details. Use placeholders for any unrecorded recipient, deadline, or owner. Produce text for review only.\n\n${careSourceBoundary}`, output: 'A follow-up labeled Draft — not sent, with the supporting gap list and citations below it.' } },
    { name: 'Prepare a handoff summary', description: 'Condense the recorded case state into a useful staff handoff.', fields: { input: 'Approved referral notes, recorded actions, and team responsibilities', instructions: `Summarize what is known, what remains unresolved, and the next administrative step. Separate recorded actions from proposed actions and name an owner only when a source supports it. Preserve missing and contradictory information instead of filling gaps. Include citations so the next staff member can inspect the basis of each point.\n\n${careSourceBoundary}`, output: 'A short For staff review handoff: current state, recorded owner, outstanding items, next step, and source links.' } },
  ],
};
const iso = () => new Date().toISOString();
function newDraft(kind: ModuleView, template?: Template): WorkspaceDraft {
  const defaults: Record<string, string> = Object.fromEntries(definitions[kind].fields.map(f => [f.key, '']));
  if (kind === 'workflows') defaults.trigger = 'Manual';
  if (kind === 'schedules') Object.assign(defaults, { frequency: 'weekly', day: 'Monday', time: '09:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
  if (kind === 'agents') defaults.budget = '12';
  const now = iso();
  return { id: crypto.randomUUID(), kind, name: template?.name ?? '', description: template?.description ?? '', fields: { ...defaults, ...template?.fields }, createdAt: now, updatedAt: now };
}
function readableDate(value: string) { return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
export function draftPrompt(draft: WorkspaceDraft) {
  const labels = definitions[draft.kind].fields;
  return `${draft.name}\n\n${draft.description}\n\n${labels.map(f => draft.fields[f.key] ? `${f.label}:\n${draft.fields[f.key]}` : '').filter(Boolean).join('\n\n')}`.trim();
}
type Props = { view: ModuleView; onUsePrompt: (prompt: string, sourceIds?: string[]) => void; onNavigate: (view: string) => void; onRun: (id: string) => void; onSource?: (id: string) => void; workspace?: WorkspaceStatus; draftId?: string; onCloseDraft?: () => void };
export function ModulePage(props: Props) {
  const profile = props.workspace?.profile.id ?? 'workspace-analyst';
  const legacy = <ModuleScreen key={`${props.view}:${profile}`} {...props} />;
  if (props.view === 'workflows') return <WorkflowWorkspace key={profile} onRun={props.onRun} onNavigate={props.onNavigate} workspace={props.workspace} />;
  if (props.view === 'tables') return props.draftId ? legacy : <SavedTablesLibrary key={profile} onOpenRun={props.onRun} onNew={() => props.onNavigate('sources')} legacy={legacy} />;
  if (props.view === 'dashboards' && profile !== 'healthcare-operations') return <Dashboards key={profile} onRun={props.onRun} onSource={props.onSource ?? (() => props.onNavigate('sources'))} onNew={() => props.onNavigate('tables')} connectionsEnabled={props.workspace?.connectionsEnabled === true} />;
  if (props.view === 'schedules' && profile !== 'healthcare-operations') return <WorkflowSchedulesWorkspace key={profile} workspace={props.workspace} onRun={props.onRun} onNavigate={props.onNavigate} legacy={legacy} requestedWorkflowId={typeof location === 'undefined' ? undefined : new URLSearchParams(location.search).get('workflow') ?? undefined} />;
  return legacy;
}
function ModuleScreen({ view, onUsePrompt, onNavigate, workspace, draftId, onCloseDraft }: Props) {
  const isHealthcare = workspace?.profile.id === 'healthcare-operations';
  const definition = isHealthcare && view === 'playbooks' ? { ...definitions[view], description: 'Prepare packet reviews, follow-up drafts, and staff handoffs.' }
    : isHealthcare && view === 'skills' ? { ...definitions[view], description: 'Focused methods for checking evidence and preparing administrative work.' }
    : definitions[view];
  const starterTemplates = isHealthcare ? healthcareTemplates[view] ?? templates[view] : templates[view];
  const readingResource = ['projects', 'playbooks', 'skills'].includes(view) || (view === 'tables' && Boolean(draftId));
  const hasResourceStarters = readingResource && Boolean(starterTemplates?.length);
  const [storage] = useState(() => workspaceProfileStorage(workspace?.profile.id ?? 'workspace-analyst'));
  const [initial] = useState(() => readModuleState(view, storage));
  const [collection, setCollection] = useState<DraftCollection>(initial.collection);
  const [error, setError] = useState(initial.error);
  const [recoveryError, setRecoveryError] = useState(initial.recoveryError);
  const [draft, setDraft] = useState<WorkspaceDraft | null>(initial.recovery?.draft ?? initial.collection.drafts.find(item => item.kind === view && item.id === draftId) ?? null);
  const [saved, setSaved] = useState(!initial.recovery && initial.collection.drafts.some(item => item.kind === view && item.id === draftId));
  const [editing, setEditing] = useState(Boolean(initial.recovery));
  const [templatePreview, setTemplatePreview] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [activeStep, setActiveStep] = useState(initial.recovery?.activeStep ?? 0);
  const [deleted, setDeleted] = useState<WorkspaceDraft | null>(null);
  const [notice, setNotice] = useState(initial.recovery ? 'Restored your unfinished draft. Save it when you are ready.' : '');
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [savedWorkflows, setSavedWorkflows] = useState<Workflow[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(view === 'schedules');
  const [workflowsError, setWorkflowsError] = useState('');
  const [workflowsRefresh, setWorkflowsRefresh] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const leaveRef = useRef<HTMLDivElement>(null);
  const pendingNavigationRef = useRef<(() => void) | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const drafts = collection.drafts.filter(d => d.kind === view);
  const filtered = drafts.filter(d => `${d.name} ${d.description}`.toLowerCase().includes(filter.toLowerCase()));
  const workflowDrafts = collection.drafts.filter(d => d.kind === 'workflows' && !savedWorkflows.some(w => w.id === d.id));
  const availableWorkflows = [...savedWorkflows, ...workflowDrafts];
  useEffect(() => {
    if (view !== 'schedules') return;
    let disposed = false; setWorkflowsLoading(true);
    api<{ workflows: Workflow[] }>('/api/workflows').then(result => { if (!disposed) { setSavedWorkflows(result.workflows); setWorkflowsError(''); } }).catch(e => { if (!disposed) setWorkflowsError(message(e)); }).finally(() => { if (!disposed) setWorkflowsLoading(false); });
    return () => { disposed = true; };
  }, [view, workflowsRefresh]);
  useEffect(() => { if (draft) titleRef.current?.focus(); }, [draft?.id, editing]);
  useEffect(() => { if (leavePrompt) leaveRef.current?.focus(); }, [leavePrompt]);
  useEffect(() => {
    if (!draft || saved || templatePreview) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const beforeNavigate = (event: Event) => {
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed;
      if (typeof proceed !== 'function') return;
      event.preventDefault(); pendingNavigationRef.current = proceed; setLeavePrompt(true);
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('rivetfields:before-navigate', beforeNavigate);
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('rivetfields:before-navigate', beforeNavigate); };
  }, [Boolean(draft), saved, templatePreview]);
  function remember(next: WorkspaceDraft, step = activeStep) {
    try { saveEditorRecovery({ version: 1, draft: next, activeStep: step }, storage.recovery); setRecoveryError(''); }
    catch (e) { setRecoveryError((e as Error).message); }
  }
  function clearRecovery() {
    try { clearEditorRecovery(view, storage.recovery); setRecoveryError(''); return true; }
    catch (e) { setRecoveryError((e as Error).message); return false; }
  }
  function open(item?: WorkspaceDraft, template?: Template) {
    openerRef.current = document.activeElement as HTMLElement;
    const next = item ? { ...item, fields: { ...item.fields } } : newDraft(view, template);
    const preview = readingResource && Boolean(template);
    setDraft(next); if (!item && !preview) remember(next, 0);
    setEditing(!readingResource || (!item && !template)); setTemplatePreview(preview);
    setSaved(Boolean(item)); setActiveStep(0); setNotice(''); setLeavePrompt(false);
  }
  function beginEditing() { if (!draft) return; setEditing(true); if (templatePreview) { setTemplatePreview(false); remember(draft); } requestAnimationFrame(() => document.getElementById('module-name')?.focus()); }
  function closeNow() { setDraft(null); setTemplatePreview(false); setNotice(''); setLeavePrompt(false); onCloseDraft?.(); requestAnimationFrame(() => openerRef.current?.isConnected && openerRef.current.focus()); }
  function close() { pendingNavigationRef.current = null; if (draft && !saved && !templatePreview) setLeavePrompt(true); else closeNow(); }
  function finishLeave(discard = false) { if (discard && !clearRecovery()) return; const proceed = pendingNavigationRef.current; pendingNavigationRef.current = null; closeNow(); proceed?.(); }
  function keepEditing() { pendingNavigationRef.current = null; setLeavePrompt(false); titleRef.current?.focus(); }
  function update(key: keyof Pick<WorkspaceDraft, 'name' | 'description'>, value: string) {
    if (!draft) return;
    const next = { ...draft, [key]: value }; setDraft(next); remember(next); setSaved(false); setNotice('');
  }
  function updateField(key: string, value: string) {
    if (!draft) return;
    const fields = { ...draft.fields, [key]: value };
    if (key === 'frequency') fields.day = value === 'monthly' ? '1' : 'Monday';
    const next = { ...draft, fields }; setDraft(next); remember(next); setSaved(false); setNotice('');
  }
  function selectStep(index: number) {
    setActiveStep(index); if (draft && !saved) remember(draft, index);
    if (window.matchMedia('(max-width: 800px)').matches) requestAnimationFrame(() => document.getElementById(`module-field-${definition.fields[index].key}`)?.focus());
  }
  function save(event?: FormEvent) {
    event?.preventDefault(); if (!draft) return false;
    const issue = validateDraftFields(draft);
    if (issue) { setError(issue); return false; }
    if (view === 'schedules' && !availableWorkflows.some(w => w.id === draft.fields.workflow)) { setError(workflowsLoading ? 'Wait for saved workflows to load before saving.' : workflowsError ? 'Saved workflows could not be checked. Retry loading them before saving.' : 'Choose an existing workflow before saving.'); return false; }
    const next = { ...draft, name: draft.name.trim(), updatedAt: iso() };
    try { setCollection(saveDraft(next, storage.local)); setDraft(next); setSaved(true); setTemplatePreview(false); if (readingResource) setEditing(false); setError(''); setNotice('Saved in this browser.'); if (!clearRecovery()) setRecoveryError('Your draft was saved, but its recovery copy could not be cleared. You can safely leave; the saved version will be used.'); return true; }
    catch (e) { setError((e as Error).message); setSaved(false); return false; }
  }
  function erase(item: WorkspaceDraft) {
    if (!clearRecovery()) return;
    const original = collection.drafts.find(d => d.id === item.id) ?? item;
    try { setCollection(removeDraft(item.id, storage.local)); setDeleted(original); setError(''); setNotice(`Removed “${original.name}”.`); setDraft(null); }
    catch (e) { setError((e as Error).message); if (!saved) remember(item); }
  }
  function undo() {
    if (!deleted) return;
    try { setCollection(saveDraft(deleted, storage.local)); setNotice(`Restored “${deleted.name}”.`); setDeleted(null); setError(''); }
    catch (e) { setError((e as Error).message); }
  }
  function retryRead() { try { setCollection(loadDrafts(storage.local)); setError(''); } catch (e) { setError((e as Error).message); } }
  function retryRecovery() {
    if (draft) { if (saved) clearRecovery(); else remember(draft); return; }
    try {
      const recovery = loadEditorRecovery(view, storage.recovery); setRecoveryError('');
      if (recovery && !recoveryMatchesSaved(recovery, collection)) { setDraft(recovery.draft); setActiveStep(recovery.activeStep); setSaved(false); setEditing(true); setTemplatePreview(false); setNotice('Restored your unfinished draft. Save it when you are ready.'); }
    } catch (e) { setRecoveryError((e as Error).message); }
  }
  function fieldControl(field: Field) {
    if (!draft) return null;
    const id = `module-field-${field.key}`; const value = draft.fields[field.key] ?? '';
    let control;
    if (view === 'schedules' && field.key === 'workflow') control = <><select id={id} value={value} onChange={e => updateField(field.key, e.target.value)}><option value="">Choose a workflow</option>{value && !availableWorkflows.some(w => w.id === value) && <option value={value} disabled>{workflowsLoading ? 'Loading selected workflow…' : 'Selected workflow unavailable'}</option>}{savedWorkflows.length > 0 && <optgroup label="Saved workflows">{savedWorkflows.map(w => <option key={w.id} value={w.id}>{w.name} · v{w.version}</option>)}</optgroup>}{workflowDrafts.length > 0 && <optgroup label="Browser drafts">{workflowDrafts.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</optgroup>}</select>{workflowsLoading && <small role="status">Loading saved workflows…</small>}{workflowsError && <small role="alert">Saved workflows could not be loaded. {workflowsError} <button type="button" className="module-link" onClick={() => setWorkflowsRefresh(n => n + 1)}>Retry</button></small>}{!availableWorkflows.length && !workflowsLoading && !workflowsError && <button className="module-link" type="button" onClick={() => onNavigate('workflows')}>Create a workflow first <ArrowRight size={12} /></button>}</>;
    else if (view === 'schedules' && field.key === 'day') {
      if (draft.fields.frequency === 'daily') return null;
      const options = draft.fields.frequency === 'monthly' ? Array.from({ length: 28 }, (_, i) => String(i + 1)) : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      control = <select id={id} value={value} onChange={e => updateField(field.key, e.target.value)}>{options.map(o => <option key={o}>{o}</option>)}</select>;
    } else if (field.options) control = <select id={id} value={value} onChange={e => updateField(field.key, e.target.value)}>{field.options.map(o => <option key={o}>{o}</option>)}</select>;
    else if (field.multiline) control = <textarea id={id} rows={field.key === 'instructions' ? 10 : 4} maxLength={20000} value={value} placeholder={field.placeholder} onChange={e => updateField(field.key, e.target.value)} />;
    else control = <input id={id} value={value} type={field.type ?? 'text'} maxLength={20000} min={field.type === 'number' ? 1 : undefined} max={field.type === 'number' ? 100 : undefined} placeholder={field.placeholder} onChange={e => updateField(field.key, e.target.value)} />;
    return <div className="module-field" key={field.key}><label htmlFor={id}>{field.label}</label>{control}{field.hint && <small>{field.hint}</small>}</div>;
  }
  const feedback = <>{error && <div className="module-alert" role="alert"><span>{error}</span><button type="button" onClick={retryRead}>Reload drafts</button></div>}{recoveryError && <div className="module-alert" role="alert"><span>{recoveryError}</span><button type="button" onClick={retryRecovery}>Retry recovery</button></div>}{notice && <div className="module-notice" role="status"><span>{notice}</span>{deleted && !draft && <button onClick={undo}><Undo2 size={13} /> Undo</button>}</div>}</>;
  if (draft) {
    const Icon = definition.icon;
    const isWorkflow = view === 'workflows';
    const isOutput = ['decks', 'dashboards', 'tables'].includes(view);
    const hasStored = collection.drafts.some(d => d.id === draft.id);
    const canPrepare = ['projects', 'workflows', 'applications', 'playbooks', 'skills', 'decks', 'dashboards', 'tables'].includes(view);
    const prompt = draftPrompt(draft);
    const promptTooLong = prompt.length > 4000;
    const leaveDecision = leavePrompt && <div className="module-leave-prompt" role="group" aria-labelledby="module-leave-title" ref={leaveRef} tabIndex={-1}><div><strong id="module-leave-title">Keep your changes?</strong><p>This draft has changes that haven’t been saved.</p></div><div><button type="button" className="button secondary" onClick={keepEditing}>Keep editing</button><button type="button" className="button secondary" onClick={() => finishLeave(true)}>Discard changes</button><button type="button" className="button module-primary" onClick={() => { if (save()) finishLeave(); }}>Save and leave</button></div></div>;
    if (readingResource && !editing) return <section className={`module-detail module-${view} module-resource-workspace`} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); if (leavePrompt) keepEditing(); else close(); } }}>
      {feedback}{leaveDecision}
      <header className="module-editor-heading module-compact-heading"><div className="module-editor-identity"><button type="button" className="module-back module-back-icon" onClick={close} aria-label={`Back to ${definition.title.toLowerCase()}`}><ArrowLeft size={17}/></button><div><span className="module-resource-kind">{definition.noun}</span><span className="module-save-status">{templatePreview ? 'Template' : saved ? 'Saved in this browser' : 'Unsaved draft'}</span></div></div><div className="module-actions"><button className="button secondary" onClick={beginEditing}><Pencil size={14}/>Edit</button>{!saved && <button className="button secondary" onClick={() => save()}>{templatePreview ? 'Save a copy' : 'Save draft'}</button>}<button className="button module-primary" disabled={!draft.name.trim() || promptTooLong} onClick={() => onUsePrompt(prompt, selectedSourceIds)}>Prepare a task <ArrowRight size={14}/></button></div></header>
      <div className="module-resource-layout"><article className="module-resource-document">
        <span className="module-resource-symbol"><Icon size={24} strokeWidth={1.5}/></span>
        <h1 ref={titleRef} tabIndex={-1}>{draft.name || `New ${definition.noun}`}</h1>
        {draft.description && <p className="module-resource-description">{draft.description}</p>}
        {definition.fields.map(field => <section className="module-resource-section" key={field.key}><h2>{view === 'projects' && field.key === 'brief' ? 'The brief' : field.label}</h2>{draft.fields[field.key]?.trim() ? <p>{draft.fields[field.key]}</p> : <button className="module-link" onClick={beginEditing}>Add {field.label.toLowerCase()} <Plus size={13}/></button>}</section>)}
        {promptTooLong && <p className="module-resource-warning" role="status">This brief is {prompt.length.toLocaleString()} characters. Edit it to 4,000 or fewer to prepare a task; the full draft can still be saved.</p>}
      </article><aside className="module-resource-context" aria-label={`${definition.noun} context`}>
        <div className="module-resource-context-section"><h2>{view === 'projects' ? 'Work from this brief' : 'Use these instructions'}</h2><p>Prepare a task, review the request, then start the agent.</p></div>
        <ModuleSourceSelection sources={workspace?.sources ?? []} selectedIds={selectedSourceIds} onChange={setSelectedSourceIds} onBrowse={() => onNavigate('sources')} />
        {view === 'projects' && <div className="module-resource-context-section"><h2>Continue in your workspace</h2><div className="module-related-links"><button onClick={() => onNavigate(isHealthcare ? 'reports' : 'artifacts')}><FileText size={15}/>{isHealthcare ? 'Browse reports' : 'Browse artifacts'} <ChevronRight size={13}/></button><button onClick={() => onNavigate('workflows')}><GitBranch size={15}/>Browse workflows <ChevronRight size={13}/></button></div><p>Tasks and {isHealthcare ? 'reports' : 'artifacts'} are not linked to this project yet.</p></div>}
        <details className="module-resource-storage"><summary>About this {definition.noun}</summary><p>{definition.note}</p>{hasStored && <button className="module-link" onClick={() => erase(draft)}><Trash2 size={13}/>Remove draft</button>}</details>
      </aside></div>
    </section>;
    return <section className={`module-detail module-${view}`} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); if (leavePrompt) keepEditing(); else close(); } }}>
      {feedback}
      {leaveDecision}
      <form className="module-detail-form" onSubmit={save}>
        <header className="module-editor-heading module-compact-heading"><div className="module-editor-identity"><button type="button" className="module-back module-back-icon" onClick={close} aria-label={`Back to ${definition.title.toLowerCase()}`}><ArrowLeft size={17} /></button><div><h1 ref={titleRef} tabIndex={-1}>{draft.name || `New ${definition.noun}`}</h1><p className="module-save-status">{saved ? 'Saved in this browser' : 'Unsaved draft'}</p></div></div><div className="module-actions">{readingResource && <button className="button secondary" type="button" onClick={() => setEditing(false)}>View {definition.noun}</button>}<button className="button module-primary" type="submit">{saved ? <Check size={14} /> : null}{saved ? 'Saved locally' : 'Save draft'}</button></div></header>
        <div className={`module-editor-layout ${isWorkflow ? 'module-workflow-layout' : ''}`}>
          {isWorkflow ? <div className="module-flow-canvas"><div className="module-canvas-caption">WORKFLOW DRAFT <span>4 steps</span></div><div className="module-flow-nodes">{[
            { title: 'Start', subtitle: draft.fields.trigger || 'Choose a trigger', icon: CalendarDays },
            { title: 'Instructions', subtitle: draft.fields.instructions || 'Describe the work', icon: BookOpen },
            { title: 'Create output', subtitle: draft.fields.output || 'Define the result', icon: FileText },
            { title: 'Human review', subtitle: draft.fields.review || 'Define what needs review', icon: ShieldCheck },
          ].map((step, i) => <button key={step.title} className={`module-flow-node ${activeStep === i ? 'selected' : ''}`} type="button" aria-pressed={activeStep === i} onClick={() => selectStep(i)}><div className="module-node-title"><span className="module-node-icon"><step.icon size={18} /></span><span>{step.title}</span><span className="module-step-number">{String(i + 1).padStart(2, '0')}</span></div><p>{step.subtitle}</p></button>)}</div><p className="module-canvas-foot">Select a step to edit its details.</p></div> : <div className={`module-document ${['skills', 'playbooks'].includes(view) ? 'module-instructions' : ''}`}>
            <div className="module-document-kicker"><Icon size={15} /><span>{view === 'projects' ? 'PROJECT BRIEF' : view === 'computer' ? 'SESSION PLAN' : isOutput ? 'OUTPUT BRIEF' : 'CONFIGURATION DRAFT'}</span></div>
            <div className="module-field"><label htmlFor="module-name">Name</label><input id="module-name" required maxLength={160} autoComplete="off" value={draft.name} placeholder={`Name your ${definition.noun}`} onChange={e => update('name', e.target.value)} /></div>
            <div className="module-field"><label htmlFor="module-description">Short description</label><input id="module-description" maxLength={1200} value={draft.description} placeholder="A sentence that makes its purpose clear" onChange={e => update('description', e.target.value)} /></div>
            {definition.fields.map(fieldControl)}
          </div>}
          <aside className="module-inspector">
            {isWorkflow ? <><div className="module-inspector-title"><Pencil size={14} /> Step details</div><div className="module-field"><label htmlFor="module-name">Workflow name</label><input id="module-name" required maxLength={160} value={draft.name} placeholder="Name your workflow" onChange={e => update('name', e.target.value)} /></div>{fieldControl(definition.fields[activeStep])}<div className="module-separator" /></> : <><div className="module-inspector-title"><Icon size={15} /> {isOutput ? 'Structure' : view === 'computer' ? 'Connection' : 'Draft details'}</div>{view === 'schedules' ? <div className="module-schedule-preview"><CalendarDays size={28} /><strong>{draft.fields.frequency === 'daily' ? 'Every day' : draft.fields.frequency === 'weekly' ? `Every ${draft.fields.day}` : `Day ${draft.fields.day} of each month`}</strong><span>{draft.fields.time || 'Choose a time'}</span><small>{draft.fields.timezone}</small><span className="module-tag">Inactive · plan only</span></div> : view === 'computer' ? <div className="module-computer-frame"><Monitor size={34} /><strong>Not connected</strong><p>No browser session is running.</p></div> : isOutput ? <OutputOutline draft={draft} /> : <div className="module-overview-note"><span className="module-tag">Local draft</span></div>}<div className="module-separator" /></>}
            <h2>{view === 'agents' ? 'Configuration only' : view === 'schedules' ? 'Scheduling not connected' : isOutput ? 'Generation not connected' : view === 'computer' ? 'Session plan' : saved ? 'Saved in this browser' : 'Browser draft'}</h2><p className="module-inspector-copy">{definition.note}</p>
            {canPrepare && <><ModuleSourceSelection sources={workspace?.sources ?? []} selectedIds={selectedSourceIds} onChange={setSelectedSourceIds} onBrowse={() => onNavigate('sources')} /><button className="button secondary module-wide" type="button" disabled={!draft.name.trim() || promptTooLong} onClick={() => onUsePrompt(prompt, selectedSourceIds)}>Prepare a task <ArrowRight size={13} /></button><p className="module-tiny">{promptTooLong ? `This brief is ${prompt.length.toLocaleString()} characters. Shorten it to 4,000 or fewer to prepare a task. The full draft can still be saved.` : 'Review these instructions in the task composer before starting.'}</p></>}
            {view === 'agents' && <button className="module-link" type="button" onClick={() => onNavigate(workspace?.profile.id === 'healthcare-operations' ? 'connections' : 'workspace')}>View current connection <ArrowRight size={12} /></button>}
            {view === 'projects' && <div className="module-related-links"><button type="button" onClick={() => onNavigate('sources')}><BookOpen size={14} /> Browse workspace sources <ChevronRight size={13} /></button><button type="button" onClick={() => onNavigate('workflows')}><GitBranch size={14} /> Browse workflows <ChevronRight size={13} /></button></div>}
            {hasStored && <div className="module-delete"><button type="button" onClick={() => erase(draft)}><Trash2 size={13} /> Remove draft</button><small>Removal can be undone from the library.</small></div>}
          </aside>
        </div>
      </form>
    </section>;
  }
  if (onCloseDraft) return <section className="module-page"><button className="text-button" onClick={onCloseDraft}><ArrowLeft size={14}/>All tables and files</button>{feedback}{!deleted && !notice && <p role="status">This table brief is no longer saved in this browser.</p>}</section>;
  const Icon = definition.icon;
  return <section className={`module-page module-${view}`}>
    <div className="module-page-heading"><div><h1>{definition.title}</h1><p>{definition.description}</p></div><button className="button module-primary" onClick={() => open()}><Plus size={15} /> New {definition.noun}</button></div>
    {feedback}
    {view === 'applications' && <TemplateGallery items={templates.applications!} onOpen={t => open(undefined, t)} />}
    {(view !== 'applications' || drafts.length > 0) && !(hasResourceStarters && drafts.length === 0) && <div className="module-library-heading"><span className="module-library-count">{drafts.length} {drafts.length === 1 ? 'draft' : 'drafts'}</span>{drafts.length > 0 && <label className="module-search"><Search size={14} /><input value={filter} onChange={e => setFilter(e.target.value)} placeholder={`Search ${definition.title.toLowerCase()}`} aria-label={`Search ${definition.title.toLowerCase()}`} /></label>}</div>}
    {drafts.length === 0 && (view === 'applications' || hasResourceStarters) ? null : drafts.length === 0 ? <div className={`module-empty ${view === 'applications' ? 'compact' : ''}`}><span className="module-empty-icon"><Icon size={25} strokeWidth={1.25} /></span><h2>No drafts yet</h2><p>Create a {definition.noun} to get started. Drafts stay in this browser.</p></div> : view === 'projects' ? <div className="module-project-grid">{filtered.map(item => <button className="module-project-card" key={item.id} onClick={() => open(item)}><Folder size={23} strokeWidth={1.3} /><h3>{item.name}</h3><p>{item.description || item.fields.brief || 'Open the project brief.'}</p><div><span>Local draft</span><time>{readableDate(item.updatedAt)}</time></div></button>)}</div> : <div className="module-table-wrap"><table className="module-library"><thead><tr><th>{view === 'workflows' ? 'Workflow' : view === 'schedules' ? 'Schedule' : 'Name'}</th><th>{view === 'workflows' ? 'Start' : view === 'schedules' ? 'Frequency' : 'Updated'}</th><th>{view === 'workflows' ? 'Output' : view === 'schedules' ? 'Time' : 'Status'}</th><th><span className="sr-only">Open draft</span></th></tr></thead><tbody>{filtered.map(item => <tr key={item.id}><td><button className="module-row-title" onClick={() => open(item)}><span className="module-row-icon"><Icon size={18} strokeWidth={1.5} /></span><span><strong>{item.name}</strong><small>{item.description || (view === 'schedules' ? workflowDrafts.find(w => w.id === item.fields.workflow)?.name || 'Workflow no longer available' : 'Local draft')}</small></span></button></td><td>{view === 'workflows' ? item.fields.trigger || 'Manual' : view === 'schedules' ? item.fields.frequency : readableDate(item.updatedAt)}</td><td>{view === 'workflows' ? <span className="module-cell-truncate">{item.fields.output || 'Not specified'}</span> : view === 'schedules' ? <><span>{item.fields.time}</span><small>{item.fields.timezone}</small></> : <span className="module-tag">Draft</span>}</td><td><button className="module-open-row" aria-label={`Open ${item.name}`} onClick={() => open(item)}><ChevronRight size={16} /></button></td></tr>)}</tbody></table></div>}
    {drafts.length > 0 && filtered.length === 0 && <p className="module-no-results">No drafts match “{filter}”.</p>}
    {starterTemplates && view !== 'applications' && (hasResourceStarters && drafts.length === 0 ? <section className="module-starter-library" aria-label={`${definition.title} templates`}><div className="module-section-label"><h2>Start with a template</h2><span>Make it your own</span></div>{starterTemplates.map(t => <button className="module-template-row" key={t.name} onClick={() => open(undefined, t)}><span className="module-row-icon"><Icon size={18}/></span><span><strong>{t.name}</strong><small>{t.description}</small></span><span className="module-template-kind">Template</span><ChevronRight size={16}/></button>)}</section> : <details className="module-template-disclosure"><summary><BookOpen size={14}/><span>Templates</span><ChevronRight size={14}/></summary><div>{starterTemplates.map(t => <button className="module-template-row" key={t.name} onClick={() => open(undefined, t)}><span className="module-row-icon"><Icon size={18}/></span><span><strong>{t.name}</strong><small>{t.description}</small></span><Plus size={16}/></button>)}</div></details>)}
    <footer className="module-library-footnote"><span className="module-tag">Local drafts</span><p>{definition.note}</p></footer>
  </section>;
}

function TemplateGallery({ items, onOpen }: { items: Template[]; onOpen: (template: Template) => void }) {
  const icons = [Search, GitBranch, LayoutDashboard, FileText];
  return <div className="module-template-gallery"><div className="module-section-label"><h2>Templates</h2><span>Choose a starting point</span></div><div className="module-app-grid">{items.map((item, i) => { const Icon = icons[i]; return <button className="module-app-card" key={item.name} onClick={() => onOpen(item)}><span className={`module-app-icon ${item.tone}`}><Icon size={24} strokeWidth={1.4} /></span><h3>{item.name}</h3><p>{item.description}</p><span className="module-card-action">Use template <ArrowRight size={13} /></span></button>; })}</div></div>;
}
function OutputOutline({ draft }: { draft: WorkspaceDraft }) {
  const key = draft.kind === 'decks' ? 'sections' : draft.kind === 'dashboards' ? 'metrics' : 'columns';
  const lines = (draft.fields[key] ?? '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 12);
  return <div className={`module-output-outline module-outline-${draft.kind}`}><span className="module-tag">Structure only</span>{lines.length ? <ol>{lines.map((line, i) => <li key={`${line}-${i}`}><span>{String(i + 1).padStart(2, '0')}</span>{line}</li>)}</ol> : <p>{draft.kind === 'decks' ? 'Your slide outline will appear here.' : draft.kind === 'dashboards' ? 'The measures you define will appear here.' : 'Your column definitions will appear here.'}</p>}<small>{draft.kind === 'decks' ? 'No slides generated' : draft.kind === 'dashboards' ? 'No live data' : 'No data rows'}</small></div>;
}
