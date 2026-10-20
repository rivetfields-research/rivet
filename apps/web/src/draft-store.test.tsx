import assert from 'node:assert/strict';
import test from 'node:test';
import { clearEditorRecovery, DRAFT_STORAGE_KEY, loadDrafts, loadEditorRecovery, migrateWorkflowDraft, RECOVERY_STORAGE_PREFIX, recoveryMatchesSaved, removeDraft, saveDraft, saveEditorRecovery, validateCollection, validateDraftFields, type DraftStorage, type RecoveryStorage, type WorkspaceDraft } from './draft-store';
const draft: WorkspaceDraft = { id: 'draft-1', kind: 'workflows', name: 'Weekly brief', description: '', fields: { trigger: 'Manual', instructions: 'Read notes', output: 'Brief', review: 'Review first' }, createdAt: '2026-09-16T12:00:00Z', updatedAt: '2026-09-16T12:00:00Z' };
function memory(initial: string | null = null) { let raw = initial; return { getItem: () => raw, setItem: (_: string, value: string) => { raw = value; } }; }
test('draft save and reload preserve instructions, while independent saved drafts survive edits', () => {
  const storage = memory();
  assert.deepEqual(loadDrafts(storage).drafts, []);
  saveDraft(draft, storage); saveDraft({ ...draft, id: 'draft-2', name: 'Another workflow' }, storage);
  saveDraft({ ...draft, fields: { ...draft.fields, instructions: 'Revised instructions' } }, storage);
  const reloaded = loadDrafts(storage);
  assert.equal(reloaded.drafts.length, 2); assert.equal(reloaded.drafts[0].fields.instructions, 'Revised instructions');
  removeDraft('draft-1', storage); assert.deepEqual(loadDrafts(storage).drafts.map(d => d.id), ['draft-2']);
  saveDraft(draft, storage); assert.equal(loadDrafts(storage).drafts.length, 2);
});
test('corrupt, unknown-version, malformed and foreign-field data are rejected without replacement', () => {
  for (const raw of ['{', JSON.stringify({ version: 2, drafts: [] }), JSON.stringify({ version: 1, drafts: [{ ...draft, kind: 'remote-execution' }] }), JSON.stringify({ version: 1, drafts: [{ ...draft, fields: { ...draft.fields, secret: 'value' } }] }), JSON.stringify({ version: 1, drafts: [draft, draft] })]) {
    const storage = memory(raw); assert.throws(() => loadDrafts(storage), /existing data has been kept/);
    assert.throws(() => saveDraft(draft, storage)); assert.equal(storage.getItem(), raw);
  }
});
test('storage read and write failures report an unsaved change', () => {
  const brokenRead: DraftStorage = { getItem: () => { throw Error('SecurityError'); }, setItem: () => { assert.fail('Must not write after a failed read'); } };
  assert.throws(() => saveDraft(draft, brokenRead), /could not be read/);
  const full: DraftStorage = { getItem: () => null, setItem: (key) => { assert.equal(key, DRAFT_STORAGE_KEY); throw Error('QuotaExceededError'); } };
  assert.throws(() => saveDraft(draft, full), /not saved/);
});
test('schedule and browser configuration reject unusable values', () => {
  const schedule: WorkspaceDraft = { ...draft, kind: 'schedules', fields: { workflow: 'draft-1', frequency: 'weekly', day: 'Monday', time: '08:00', timezone: 'America/New_York' } };
  assert.equal(validateDraftFields(schedule), null);
  assert.match(validateDraftFields({ ...schedule, fields: { ...schedule.fields, timezone: 'Somewhere/Invalid' } })!, /timezone/);
  assert.match(validateDraftFields({ ...schedule, fields: { ...schedule.fields, time: '25:70' } })!, /time/);
  assert.match(validateDraftFields({ ...schedule, fields: { ...schedule.fields, frequency: 'monthly', day: '31' } })!, /1 to 28/);
  assert.match(validateDraftFields({ ...draft, kind: 'computer', fields: { url: 'javascript:alert(1)' } })!, /http/);
  assert.throws(() => validateCollection({ version: 1, drafts: [{ ...draft, updatedAt: 'invalid' }] }));
});

function sessionMemory() {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}
test('unfinished editors survive remount/reload with blank names and selected steps, separately per module', () => {
  const session = sessionMemory(); const local = memory();
  saveDraft(draft, local);
  const unfinished = { version: 1 as const, draft: { ...draft, name: '', fields: { ...draft.fields, instructions: 'Still writing…' } }, activeStep: 1 };
  saveEditorRecovery(unfinished, session);
  saveEditorRecovery({ version: 1, draft: { ...draft, id: 'project-1', kind: 'projects', name: '', fields: { brief: 'A new brief' } }, activeStep: 0 }, session);
  assert.deepEqual(loadEditorRecovery('workflows', session), unfinished);
  assert.equal(loadEditorRecovery('projects', session)?.draft.fields.brief, 'A new brief');
  assert.equal(loadDrafts(local).drafts[0].fields.instructions, 'Read notes');
  clearEditorRecovery('workflows', session);
  assert.equal(loadEditorRecovery('workflows', session), null);
  assert.notEqual(loadEditorRecovery('projects', session), null);
  assert.equal(loadDrafts(local).drafts.length, 1);
});
test('malformed recovery, wrong versions, cross-module drafts, and invalid step indexes cannot replace stored recovery', () => {
  const session = sessionMemory(); const key = RECOVERY_STORAGE_PREFIX + 'workflows';
  for (const raw of ['{', JSON.stringify({ version: 2, draft, activeStep: 0 }), JSON.stringify({ version: 1, draft: { ...draft, kind: 'projects', fields: {} }, activeStep: 0 }), JSON.stringify({ version: 1, draft, activeStep: 4 }), JSON.stringify({ version: 1, draft: { ...draft, fields: { instructions: 42 } }, activeStep: 0 })]) {
    session.setItem(key, raw);
    assert.throws(() => loadEditorRecovery('workflows', session), /could not be restored/);
    assert.throws(() => saveEditorRecovery({ version: 1, draft, activeStep: 0 }, session));
    assert.equal(session.getItem(key), raw);
  }
  clearEditorRecovery('workflows', session);
  assert.equal(loadEditorRecovery('workflows', session), null);
});
test('recovery read/write/clear failures are reported and retain the prior copy', () => {
  const session = sessionMemory(); saveEditorRecovery({ version: 1, draft, activeStep: 0 }, session);
  const prior = session.getItem(RECOVERY_STORAGE_PREFIX + 'workflows');
  const full: RecoveryStorage = { ...session, setItem: () => { throw Error('QuotaExceededError'); }, removeItem: () => { throw Error('SecurityError'); } };
  assert.throws(() => saveEditorRecovery({ version: 1, draft: { ...draft, name: 'New edits' }, activeStep: 2 }, full), /Recovery is unavailable/);
  assert.throws(() => clearEditorRecovery('workflows', full), /could not be cleared/);
  assert.equal(session.getItem(RECOVERY_STORAGE_PREFIX + 'workflows'), prior);
  assert.throws(() => loadEditorRecovery('workflows', { ...session, getItem: () => { throw Error('SecurityError'); } }), /could not be restored/);
});
test('an editor remount recovers exact unsaved edits after storage fails, without claiming reload durability', () => {
  const persisted = sessionMemory();
  let unavailable = false;
  const session: RecoveryStorage = {
    getItem: key => { if (unavailable) throw Error('SecurityError'); return persisted.getItem(key); },
    setItem: (key, value) => { if (unavailable) throw Error('QuotaExceededError'); persisted.setItem(key, value); },
    removeItem: key => { if (unavailable) throw Error('SecurityError'); persisted.removeItem(key); },
  };
  saveEditorRecovery({ version: 1, draft, activeStep: 0, workflowVersion: 2 }, session);
  const prior = persisted.getItem(RECOVERY_STORAGE_PREFIX + 'workflows');
  unavailable = true;
  const edited = { version: 1 as const, draft: { ...draft, name: '', fields: { ...draft.fields, instructions: 'Unsaved referral review' } }, activeStep: 3, workflowVersion: 2 };
  const expected = structuredClone(edited);
  assert.throws(() => saveEditorRecovery(edited, session), /only while this page stays open/);
  // Mutating either the old editor or a returned record cannot change recovery.
  edited.draft.fields.instructions = 'Changed after the snapshot';
  const reopened = loadEditorRecovery('workflows', session)!;
  assert.deepEqual(reopened, expected);
  reopened.draft.fields.instructions = 'Changed by a new editor';
  assert.deepEqual(loadEditorRecovery('workflows', session), expected);
  assert.equal(persisted.getItem(RECOVERY_STORAGE_PREFIX + 'workflows'), prior);
  // A fresh page has only the older persisted record, not the memory fallback.
  assert.equal(loadEditorRecovery('workflows', persisted)?.draft.fields.instructions, 'Read notes');
  unavailable = false;
  assert.deepEqual(loadEditorRecovery('workflows', session), expected);
  saveEditorRecovery(expected, session);
  assert.deepEqual(JSON.parse(persisted.getItem(RECOVERY_STORAGE_PREFIX + 'workflows')!), expected);
  clearEditorRecovery('workflows', session);
  assert.equal(loadEditorRecovery('workflows', session), null);
});
test('page recovery isolates editors and keeps failed discard recoverable until removal succeeds', () => {
  const persisted = sessionMemory();
  let unavailable = true;
  const session: RecoveryStorage = {
    getItem: persisted.getItem,
    setItem: (key, value) => { if (unavailable) throw Error('QuotaExceededError'); persisted.setItem(key, value); },
    removeItem: key => { if (unavailable) throw Error('SecurityError'); persisted.removeItem(key); },
  };
  const workflow = { version: 1 as const, draft, activeStep: 1 };
  const project = { version: 1 as const, draft: { ...draft, id: 'project-new', kind: 'projects' as const, fields: { brief: 'Unsaved project brief' } }, activeStep: 0 };
  assert.throws(() => saveEditorRecovery(workflow, session), /Recovery is unavailable/);
  assert.throws(() => saveEditorRecovery(project, session), /Recovery is unavailable/);
  assert.deepEqual(loadEditorRecovery('workflows', session), workflow);
  assert.deepEqual(loadEditorRecovery('projects', session), project);
  assert.throws(() => clearEditorRecovery('workflows', session), /could not be cleared/);
  assert.deepEqual(loadEditorRecovery('workflows', session), workflow);
  unavailable = false;
  clearEditorRecovery('workflows', session);
  assert.equal(loadEditorRecovery('workflows', session), null);
  assert.deepEqual(loadEditorRecovery('projects', session), project);
  // A confirmed local save remains authoritative if cleanup cannot finish.
  const local = memory();
  const saved = saveDraft(project.draft, local);
  assert.equal(recoveryMatchesSaved(loadEditorRecovery('projects', session)!, saved), true);
  clearEditorRecovery('projects', session);
  assert.equal(loadEditorRecovery('projects', session), null);
});
test('a completed save wins over an identical recovery copy if clearing storage failed', () => {
  const recovery = { version: 1 as const, draft: { ...draft, name: '  Weekly brief  ' }, activeStep: 3 };
  const saved = { version: 1 as const, drafts: [{ ...draft, updatedAt: '2026-09-17T12:00:00Z' }] };
  assert.equal(recoveryMatchesSaved(recovery, saved), true);
  assert.equal(recoveryMatchesSaved({ ...recovery, draft: { ...recovery.draft, fields: { ...draft.fields, instructions: 'Unsaved new work' } } }, saved), false);
  assert.equal(recoveryMatchesSaved(recovery, { version: 1, drafts: [] }), false);
});
test('workflow recovery preserves the edited server version and rejects invalid version metadata', () => {
  const session = sessionMemory();
  saveEditorRecovery({ version: 1, draft, activeStep: 2, workflowVersion: 3 }, session);
  assert.equal(loadEditorRecovery('workflows', session)?.workflowVersion, 3);
  assert.throws(() => saveEditorRecovery({ version: 1, draft, activeStep: 2, workflowVersion: 0 }, session));
  assert.equal(loadEditorRecovery('workflows', session)?.workflowVersion, 3);
});

test('workflow input selection survives fresh recovery reads and supports the full source ID contract', () => {
  const session = sessionMemory(); const local = memory();
  for (const ids of [['source_' + 'x'.repeat(64)], Array.from({ length: 100 }, (_, index) => `source_${index}_`.padEnd(200, 'x')), []]) {
    const selected = { ...draft, fields: { ...draft.fields, sourceIds: JSON.stringify(ids) } };
    saveEditorRecovery({ version: 1, draft: selected, activeStep: 0 }, session);
    // A different adapter reads persisted bytes rather than the page cache.
    assert.deepEqual(JSON.parse(loadEditorRecovery('workflows', { ...session })!.draft.fields.sourceIds), ids);
    saveDraft(selected, local);
    assert.deepEqual(JSON.parse(loadDrafts(local).drafts[0].fields.sourceIds), ids);
  }
});

test('malformed workflow selections cannot replace recovered inputs or leak into another resource kind', () => {
  const session = sessionMemory();
  const selected = { ...draft, fields: { ...draft.fields, sourceIds: '["source_known"]' } };
  saveEditorRecovery({ version: 1, draft: selected, activeStep: 0 }, session);
  for (const sourceIds of ['{', '{}', '["bad id"]', '["duplicate","duplicate"]', JSON.stringify(['x'.repeat(201)]), JSON.stringify(Array.from({length: 101}, (_, index) => `source_${index}`))]) {
    assert.throws(() => saveEditorRecovery({ version: 1, draft: { ...selected, fields: { ...selected.fields, sourceIds } }, activeStep: 0 }, session), /Invalid editor recovery/);
    assert.deepEqual(loadEditorRecovery('workflows', session)?.draft, selected);
  }
  assert.throws(() => saveEditorRecovery({ version: 1, draft: { ...draft, kind: 'projects', fields: { sourceIds: '[]' } }, activeStep: 0 }, session), /Invalid editor recovery/);
});

test('saving a browser workflow preserves saved and unfinished schedule references under its new server identity', () => {
  const storage = memory(); const session = sessionMemory();
  const schedule: WorkspaceDraft = { ...draft, id: 'schedule-1', kind: 'schedules', fields: { workflow: draft.id, frequency: 'weekly', day: 'Monday', time: '08:00', timezone: 'America/New_York' } };
  saveDraft(draft, storage); saveDraft(schedule, storage);
  saveDraft({ ...schedule, id: 'schedule-2', fields: { ...schedule.fields, workflow: 'other-workflow' } }, storage);
  saveEditorRecovery({ version: 1, draft: { ...schedule, name: 'Unfinished schedule edits' }, activeStep: 0 }, session);
  const migrated = migrateWorkflowDraft(draft.id, 'saved-workflow-1', storage, session);
  assert.equal(migrated.drafts.some(d => d.id === draft.id), false);
  assert.equal(migrated.drafts.find(d => d.id === schedule.id)?.fields.workflow, 'saved-workflow-1');
  assert.equal(migrated.drafts.find(d => d.id === 'schedule-2')?.fields.workflow, 'other-workflow');
  assert.equal(loadEditorRecovery('schedules', session)?.draft.fields.workflow, 'saved-workflow-1');
  assert.equal(loadEditorRecovery('schedules', session)?.draft.name, 'Unfinished schedule edits');
  assert.deepEqual(loadDrafts(storage), migrated);
  assert.deepEqual(migrateWorkflowDraft(draft.id, 'saved-workflow-1', storage, session), migrated);
});

test('migration failures keep the browser workflow and saved schedule linked until the change can be retried', () => {
  const storage = memory(); const session = sessionMemory();
  const schedule: WorkspaceDraft = { ...draft, id: 'schedule-1', kind: 'schedules', fields: { workflow: draft.id } };
  saveDraft(draft, storage); saveDraft(schedule, storage);
  saveEditorRecovery({ version: 1, draft: schedule, activeStep: 0 }, session);
  const original = loadDrafts(storage);
  assert.throws(() => migrateWorkflowDraft(draft.id, 'saved-workflow-1', storage, { ...session, setItem: () => { throw Error('QuotaExceededError'); } }), /Recovery is unavailable/);
  assert.deepEqual(loadDrafts(storage), original);
  assert.equal(loadEditorRecovery('schedules', session)?.draft.fields.workflow, draft.id);
  assert.throws(() => migrateWorkflowDraft(draft.id, 'saved-workflow-1', { ...storage, setItem: () => { throw Error('QuotaExceededError'); } }, session), /not saved/);
  assert.deepEqual(loadDrafts(storage), original);
  assert.equal(loadEditorRecovery('schedules', session)?.draft.fields.workflow, 'saved-workflow-1');
  assert.equal(migrateWorkflowDraft(draft.id, 'saved-workflow-1', storage, session).drafts.find(d => d.id === schedule.id)?.fields.workflow, 'saved-workflow-1');
});
