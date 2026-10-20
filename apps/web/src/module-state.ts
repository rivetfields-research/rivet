import { loadDrafts, loadEditorRecovery, recoveryMatchesSaved, type DraftCollection, type EditorRecovery, type ModuleView, type RecoveryStorage } from './draft-store';

export function readModuleState(view: ModuleView, storage: { local: RecoveryStorage; recovery: RecoveryStorage }) {
  let collection: DraftCollection = { version: 1, drafts: [] };
  let error = ''; let recoveryError = ''; let recovery: EditorRecovery | null = null;
  try { collection = loadDrafts(storage.local); } catch (e) { error = (e as Error).message; }
  try { recovery = loadEditorRecovery(view, storage.recovery); } catch (e) { recoveryError = (e as Error).message; }
  // A saved record wins when clearing its identical recovery copy failed.
  if (recovery && recoveryMatchesSaved(recovery, collection)) recovery = null;
  return { collection, error, recovery, recoveryError };
}
