import type { Run, Workflow, WorkflowInput } from '../../../packages/core/src/types';
import { workspaceBrowserStorage } from './workspace-scope';
import { validWorkflowSourceIds as validSources, validWorkflowConnectionIds, type WorkspaceDraft } from './draft-store';

export const SAVE_INTENT_KEY = 'rivetfields.workflow-save-intent.v1';
export const RUN_INTENT_KEY = 'rivetfields.workflow-run-intent.v1';
export type SaveIntent = { schema: 1; requestId: string; workflowId: string | null; version: number | null; input: WorkflowInput };
export type RunIntent = { schema: 1; requestId: string; workflowId: string; version: number };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const keys = ['name', 'instructions', 'output', 'review'] as const;
const limits = { name: 160, instructions: 2400, output: 800, review: 400 };
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const requestId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const version = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export function workflowSourceIds(draft: WorkspaceDraft): string[] {
  try { const ids: unknown = JSON.parse(draft.fields.sourceIds || '[]'); return validSources(ids) ? [...ids].sort() : []; } catch { return []; }
}
export function weeklyReviewConnectionIds(draft: WorkspaceDraft): string[] {
  try { const config = JSON.parse(draft.fields.weeklyReview ?? 'null'); return validWorkflowConnectionIds(config?.connectionIds) ? [...config.connectionIds].sort() : []; } catch { return []; }
}
export function weeklyReviewDraft(id: string = crypto.randomUUID(), now = new Date().toISOString()): WorkspaceDraft {
  return { id, kind: 'workflows', name: 'Weekly social & data review', description: 'A weekly look at your connected accounts.', fields: {
    trigger: 'Manual', sourceIds: '[]', weeklyReview: JSON.stringify({ connectionIds: [] }),
    instructions: 'Review each selected account for the reporting week. Summarize the available performance measures, standout content and data gaps. Keep each platform\'s metric definitions separate. Compare periods only when compatible measurements exist; never invent growth, registrations or attribution.',
    output: 'A concise weekly report: key takeaways first, then useful charts and supporting detail. Cite the saved calculations. State dates, data freshness and limitations. If no records match the week, explain the gap rather than inventing results.',
    review: 'Check the reporting dates, selected accounts, unavailable metrics and any older data before sharing.',
  }, createdAt: now, updatedAt: now };
}
export function reportWorkflowDraft(run: Pick<Run, 'task' | 'result'>, sourceIds: string[], id: string = crypto.randomUUID(), now = new Date().toISOString()): WorkspaceDraft {
  if (!run.result) throw new Error('Open a saved report before creating a workflow.');
  if (!validSources(sourceIds)) throw new Error('The report inputs could not be copied. Open the report again.');
  const title = run.result.title.trim().slice(0, 160) || 'Report workflow';
  return {
    id, kind: 'workflows', name: title, description: `Prepared from the saved report “${title}”. Review its task and selected files before saving.`,
    fields: {
      trigger: 'Manual', sourceIds: JSON.stringify(sourceIds),
      // Keep the exact task, including date ranges and dataset IDs. Oversized
      // tasks stay editable and must be shortened explicitly before saving.
      instructions: run.task,
      output: `Create a source-linked report titled “${title}”. Recalculate figures from the selected inputs and include limitations and calculation evidence.`,
      review: 'Check the selected files, date range, calculations, citations, and unsupported claims before sharing the report.',
    }, createdAt: now, updatedAt: now,
  };
}

export function workflowDraftOpening(current: WorkspaceDraft | null, dirty: boolean, pendingSave: SaveIntent | null, storageError: string): 'open' | 'confirm' | 'blocked' {
  if (current && (dirty || pendingSave)) return 'confirm';
  return storageError ? 'blocked' : 'open';
}
export function workflowInput(draft: WorkspaceDraft): WorkflowInput { return { sourceIds: workflowSourceIds(draft), ...(draft.fields.weeklyReview !== undefined ? { weeklyReview: { connectionIds: weeklyReviewConnectionIds(draft) } } : {}), name: draft.name.trim(), instructions: (draft.fields.instructions ?? '').trim(), output: (draft.fields.output ?? '').trim(), review: (draft.fields.review ?? '').trim() }; }
export function workflowInputIssue(input: WorkflowInput): string | null {
  for (const key of keys) {
    if (!input[key].trim()) return `Add ${key === 'name' ? 'a workflow name' : key === 'review' ? 'review instructions' : key === 'output' ? 'the expected output' : 'working instructions'} before saving.`;
    if (input[key].length > limits[key]) return `Keep ${key} to ${limits[key].toLocaleString()} characters or fewer. Your full draft is still here.`;
  }
  if (input.sourceIds !== undefined && !validSources(input.sourceIds)) return 'Select up to 100 distinct workspace files.';
  if (input.weeklyReview && (!validWorkflowConnectionIds(input.weeklyReview.connectionIds) || !input.weeklyReview.connectionIds.length || input.sourceIds?.length)) return 'Choose 1–5 connected accounts for the weekly review, without fixed snapshots.';
  return null;
}
export function sameWorkflow(a: WorkflowInput, b: WorkflowInput): boolean { return keys.every(key => a[key] === b[key]) && JSON.stringify([...(a.sourceIds ?? [])].sort()) === JSON.stringify([...(b.sourceIds ?? [])].sort()) && JSON.stringify(a.weeklyReview ? [...a.weeklyReview.connectionIds].sort() : null) === JSON.stringify(b.weeklyReview ? [...b.weeklyReview.connectionIds].sort() : null); }
export function workflowDraft(workflow: Workflow): WorkspaceDraft { return { id: workflow.id, kind: 'workflows', name: workflow.name, description: '', fields: { sourceIds: JSON.stringify(workflow.sourceIds ?? []), ...(workflow.weeklyReview ? { weeklyReview: JSON.stringify(workflow.weeklyReview) } : {}), trigger: 'Manual', instructions: workflow.instructions, output: workflow.output, review: workflow.review }, createdAt: workflow.createdAt, updatedAt: workflow.updatedAt }; }
export function intentDraft(intent: SaveIntent): WorkspaceDraft { const now = new Date().toISOString(); return { id: intent.workflowId ?? intent.requestId, kind: 'workflows', name: intent.input.name, description: '', fields: { sourceIds: JSON.stringify(intent.input.sourceIds ?? []), ...(intent.input.weeklyReview ? { weeklyReview: JSON.stringify(intent.input.weeklyReview) } : {}), trigger: 'Manual', instructions: intent.input.instructions, output: intent.input.output, review: intent.input.review }, createdAt: now, updatedAt: now }; }
function validInput(v: unknown): v is WorkflowInput { return record(v) && (v.sourceIds === undefined || validSources(v.sourceIds)) && (v.weeklyReview === undefined || record(v.weeklyReview) && Object.keys(v.weeklyReview).length === 1 && validWorkflowConnectionIds(v.weeklyReview.connectionIds) && v.weeklyReview.connectionIds.length > 0 && !(v.sourceIds as string[] | undefined)?.length) && keys.every(key => typeof v[key] === 'string' && (v[key] as string).length <= limits[key] && (v[key] as string).trim().length > 0); }
function validSave(v: unknown): v is SaveIntent { return record(v) && v.schema === 1 && requestId(v.requestId) && validInput(v.input) && ((v.workflowId === null && v.version === null) || (id(v.workflowId) && version(v.version))); }
function validRun(v: unknown): v is RunIntent { return record(v) && v.schema === 1 && requestId(v.requestId) && id(v.workflowId) && version(v.version); }
export function readWorkflowIntent(kind: 'save', storage?: Store): SaveIntent | null;
export function readWorkflowIntent(kind: 'run', storage?: Store): RunIntent | null;
export function readWorkflowIntent(kind: 'save' | 'run', storage?: Store): SaveIntent | RunIntent | null {
  try {
    const raw = (storage ?? workspaceBrowserStorage()).getItem(kind === 'save' ? SAVE_INTENT_KEY : RUN_INTENT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!(kind === 'save' ? validSave(parsed) : validRun(parsed))) throw Error();
    return parsed as SaveIntent | RunIntent;
  } catch { throw new Error(`The pending workflow ${kind} could not be read. Its browser record has been kept.`); }
}
export function persistWorkflowIntent(kind: 'save' | 'run', value: SaveIntent | RunIntent | null, storage?: Store): void {
  if (value && !(kind === 'save' ? validSave(value) : validRun(value))) throw new Error('The workflow request is invalid.');
  const target = storage ?? workspaceBrowserStorage(); const key = kind === 'save' ? SAVE_INTENT_KEY : RUN_INTENT_KEY;
  if (value) {
    const existing = kind === 'save' ? readWorkflowIntent('save', target) : readWorkflowIntent('run', target);
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error(`Resolve the pending workflow ${kind} before starting another request.`);
  }
  try {
    if (value) target.setItem(key, JSON.stringify(value)); else target.removeItem(key);
  } catch { throw new Error(value ? 'The request could not be saved in this browser, so nothing was started. Your edits are still here.' : 'The request finished, but its retry record could not be cleared. Retrying it will use the same request.'); }
}

export function finishWorkflowIntent<T extends SaveIntent | RunIntent>(kind: 'save' | 'run', pending: T, storage?: Store): { pending: T | null; error: string } {
  try { persistWorkflowIntent(kind, null, storage); return { pending: null, error: '' }; }
  catch (error) { return { pending, error: (error as Error).message }; }
}
