export const MODULE_VIEWS = ['projects', 'workflows', 'schedules', 'applications', 'playbooks', 'skills', 'agents', 'computer', 'decks', 'dashboards', 'tables'] as const;
import { workspaceBrowserStorage } from './workspace-scope';
export type ModuleView = typeof MODULE_VIEWS[number];
export type WorkspaceDraft = { id: string; kind: ModuleView; name: string; description: string; fields: Record<string, string>; createdAt: string; updatedAt: string };
export type DraftCollection = { version: 1; drafts: WorkspaceDraft[] };
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type EditorRecovery = { version: 1; draft: WorkspaceDraft; activeStep: number; workflowVersion?: number };
export const DRAFT_STORAGE_KEY = 'rivetfields.workspace-drafts.v1';
export const RECOVERY_STORAGE_PREFIX = 'rivetfields.unfinished-editor.v1.';
// Same-document navigation can unmount an editor even when session storage is
// unavailable. Keep a snapshot for this page's lifetime; this is not a save.
const browserRecoveryScope = {};
const pageRecovery = new WeakMap<object, Map<ModuleView, string>>();
function recoveryCache(storage?: RecoveryStorage): Map<ModuleView, string> {
  const scope = storage ?? browserRecoveryScope;
  let cache = pageRecovery.get(scope);
  if (!cache) { cache = new Map(); pageRecovery.set(scope, cache); }
  return cache;
}
export const FIELD_KEYS: Record<ModuleView, readonly string[]> = {
  projects: ['brief', 'outcome'], workflows: ['trigger', 'sourceIds', 'weeklyReview', 'instructions', 'output', 'review'],
  schedules: ['workflow', 'frequency', 'day', 'time', 'timezone'],
  applications: ['instructions', 'audience', 'output'], playbooks: ['instructions', 'output'],
  skills: ['instructions', 'input', 'output'], agents: ['instructions', 'model', 'tools', 'budget'],
  computer: ['url', 'objective', 'scope'], decks: ['brief', 'audience', 'sections'],
  dashboards: ['brief', 'metrics', 'sources'], tables: ['brief', 'columns', 'sources'],
};

function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
export function validWorkflowSourceIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(id)) && new Set(value).size === value.length;
}
export function validWorkflowConnectionIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 5 && value.every(id => typeof id === 'string' && /^conn_[0-9a-f]{24}$/.test(id)) && new Set(value).size === value.length;
}
function validField(kind: ModuleView, key: string, value: unknown): boolean {
  if (!FIELD_KEYS[kind].includes(key) || typeof value !== 'string') return false;
  if (kind === 'workflows' && key === 'sourceIds') {
    // A full selection can exceed the ordinary 20,000-character text limit.
    if (value.length > 20301) return false;
    try { return validWorkflowSourceIds(JSON.parse(value)); } catch { return false; }
  }
  if (kind === 'workflows' && key === 'weeklyReview') {
    try { const config: unknown = JSON.parse(value); return record(config) && Object.keys(config).length === 1 && validWorkflowConnectionIds(config.connectionIds); } catch { return false; }
  }
  return value.length <= 20000;
}
function fail(): never { throw new Error('Saved drafts could not be read. The existing data has been kept.'); }
function validDraft(d: unknown, allowBlankName = false): d is WorkspaceDraft {
  if (!record(d) || typeof d.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(d.id)
    || typeof d.kind !== 'string' || !MODULE_VIEWS.includes(d.kind as ModuleView)
    || typeof d.name !== 'string' || (!allowBlankName && !d.name.trim()) || d.name.length > 160
    || typeof d.description !== 'string' || d.description.length > 1200 || !record(d.fields)
    || typeof d.createdAt !== 'string' || !Number.isFinite(Date.parse(d.createdAt))
    || typeof d.updatedAt !== 'string' || !Number.isFinite(Date.parse(d.updatedAt))) return false;
  return Object.entries(d.fields).every(([key, val]) => validField(d.kind as ModuleView, key, val));
}
export function validateCollection(value: unknown): DraftCollection {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.drafts) || value.drafts.length > 500) return fail();
  const ids = new Set<string>();
  for (const d of value.drafts) {
    if (!validDraft(d) || ids.has(d.id)) return fail();
    ids.add(d.id);
  }
  return value as DraftCollection;
}

function browserStorage(): DraftStorage { return workspaceBrowserStorage(); }
export function loadDrafts(storage?: DraftStorage): DraftCollection {
  try {
    const raw = (storage ?? browserStorage()).getItem(DRAFT_STORAGE_KEY);
    if (raw === null) return { version: 1, drafts: [] };
    return validateCollection(JSON.parse(raw));
  } catch { throw new Error('Saved drafts could not be read. The existing data has been kept.'); }
}
function writeDrafts(collection: DraftCollection, storage?: DraftStorage): DraftCollection {
  validateCollection(collection);
  try { (storage ?? browserStorage()).setItem(DRAFT_STORAGE_KEY, JSON.stringify(collection)); }
  catch { throw new Error('This change was not saved. Browser storage is unavailable or full. Your edits are still here.'); }
  return collection;
}
export function saveDraft(draft: WorkspaceDraft, storage?: DraftStorage): DraftCollection {
  validateCollection({ version: 1, drafts: [draft] });
  const current = loadDrafts(storage);
  return writeDrafts({ version: 1, drafts: [draft, ...current.drafts.filter((d) => d.id !== draft.id)] }, storage);
}
export function removeDraft(id: string, storage?: DraftStorage): DraftCollection {
  const current = loadDrafts(storage);
  return writeDrafts({ version: 1, drafts: current.drafts.filter((d) => d.id !== id) }, storage);
}

export function migrateWorkflowDraft(draftId: string, workflowId: string, storage?: DraftStorage, recoveryStorage?: RecoveryStorage): DraftCollection {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workflowId)) throw new Error('The saved workflow reference is invalid.');
  const current = loadDrafts(storage);
  // Keep an unfinished schedule linked too. If recovery is unavailable, retain
  // the original browser workflow so its existing schedule references still work.
  const recovery = loadEditorRecovery('schedules', recoveryStorage);
  if (recovery?.draft.fields.workflow === draftId) saveEditorRecovery({ ...recovery, draft: { ...recovery.draft, fields: { ...recovery.draft.fields, workflow: workflowId } } }, recoveryStorage);
  const drafts = current.drafts.filter(d => !(d.kind === 'workflows' && d.id === draftId)).map(d => d.kind === 'schedules' && d.fields.workflow === draftId ? { ...d, fields: { ...d.fields, workflow: workflowId } } : d);
  if (drafts.length === current.drafts.length && drafts.every((d, index) => d === current.drafts[index])) return current;
  return writeDrafts({ version: 1, drafts }, storage);
}

function validateRecovery(value: unknown, view: ModuleView): EditorRecovery {
  if (!record(value) || value.version !== 1 || !validDraft(value.draft, true) || value.draft.kind !== view
    || typeof value.activeStep !== 'number' || !Number.isInteger(value.activeStep) || value.activeStep < 0
    || value.activeStep > (view === 'workflows' ? 3 : 0)
    || (value.workflowVersion !== undefined && (view !== 'workflows' || typeof value.workflowVersion !== 'number' || !Number.isSafeInteger(value.workflowVersion) || value.workflowVersion < 1))) throw new Error('Invalid editor recovery');
  return value as EditorRecovery;
}
export function loadEditorRecovery(view: ModuleView, storage?: RecoveryStorage): EditorRecovery | null {
  const snapshot = recoveryCache(storage).get(view);
  let raw: string | null;
  try { raw = (storage ?? workspaceBrowserStorage('sessionStorage')).getItem(RECOVERY_STORAGE_PREFIX + view); }
  catch {
    if (snapshot) return validateRecovery(JSON.parse(snapshot), view);
    throw new Error('Your unfinished draft could not be restored. Its recovery data has been kept.');
  }
  try {
    // Keep detecting malformed persisted data, even if a page snapshot exists.
    const persisted = raw === null ? null : validateRecovery(JSON.parse(raw), view);
    return snapshot ? validateRecovery(JSON.parse(snapshot), view) : persisted;
  } catch { throw new Error('Your unfinished draft could not be restored. Its recovery data has been kept.'); }
}
export function saveEditorRecovery(recovery: EditorRecovery, storage?: RecoveryStorage): void {
  validateRecovery(recovery, recovery.draft.kind);
  const snapshot = JSON.stringify(recovery);
  recoveryCache(storage).set(recovery.draft.kind, snapshot);
  try {
    const target = storage ?? workspaceBrowserStorage('sessionStorage');
    // Do not replace malformed recovery data or write after a failed read.
    const raw = target.getItem(RECOVERY_STORAGE_PREFIX + recovery.draft.kind);
    if (raw !== null) validateRecovery(JSON.parse(raw), recovery.draft.kind);
    target.setItem(RECOVERY_STORAGE_PREFIX + recovery.draft.kind, snapshot);
  } catch { throw new Error('Recovery is unavailable. These edits are kept only while this page stays open. Save before reloading or closing it.'); }
}
export function clearEditorRecovery(view: ModuleView, storage?: RecoveryStorage): void {
  try { (storage ?? workspaceBrowserStorage('sessionStorage')).removeItem(RECOVERY_STORAGE_PREFIX + view); recoveryCache(storage).delete(view); }
  catch { throw new Error('The unfinished draft could not be cleared. Keep editing or save the draft before leaving.'); }
}
export function recoveryMatchesSaved(recovery: EditorRecovery, collection: DraftCollection): boolean {
  const saved = collection.drafts.find(d => d.id === recovery.draft.id && d.kind === recovery.draft.kind);
  return Boolean(saved && saved.name === recovery.draft.name.trim() && saved.description === recovery.draft.description
    && FIELD_KEYS[saved.kind].every(key => (saved.fields[key] ?? '') === (recovery.draft.fields[key] ?? '')));
}

export function validateDraftFields(draft: WorkspaceDraft): string | null {
  if (!draft.name.trim()) return 'Give this draft a name.';
  if (draft.name.length > 160) return 'Keep the name under 160 characters.';
  if (draft.kind === 'schedules') {
    const f = draft.fields;
    if (!f.workflow?.trim()) return 'Choose a workflow to plan this schedule.';
    if (!['daily', 'weekly', 'monthly'].includes(f.frequency)) return 'Choose a frequency.';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.time ?? '')) return 'Enter a valid time.';
    if (f.frequency === 'weekly' && !['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(f.day)) return 'Choose a weekday.';
    if (f.frequency === 'monthly' && (!/^\d+$/.test(f.day ?? '') || Number(f.day) < 1 || Number(f.day) > 28)) return 'Choose a day from 1 to 28.';
    try { new Intl.DateTimeFormat('en', { timeZone: f.timezone }).format(); if (!f.timezone) throw Error(); }
    catch { return 'Enter a valid timezone, such as America/New_York.'; }
  }
  if (draft.kind === 'agents' && draft.fields.budget && (!/^\d+$/.test(draft.fields.budget) || Number(draft.fields.budget) < 1 || Number(draft.fields.budget) > 100)) return 'Choose a step limit between 1 and 100.';
  if (draft.kind === 'computer' && draft.fields.url) {
    try { const url = new URL(draft.fields.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error(); }
    catch { return 'Enter an http or https starting URL without credentials.'; }
  }
  return null;
}
