import type { ImportedWorkspaceFile } from '../../../packages/core/src/file-import';
import type { SourceDocument } from '../../../packages/core/src/types';
import { api } from './api';
import { FIELD_KEYS, type RecoveryStorage, type WorkspaceDraft } from './draft-store';
import { readModuleState } from './module-state';

export const olderDraftKinds = ['projects', 'tables', 'dashboards'] as const;
export type OlderDraftKind = typeof olderDraftKinds[number];
export const olderDraftLabels: Record<OlderDraftKind, string> = { projects: 'Project brief', tables: 'Table brief', dashboards: 'Dashboard brief' };
export type OlderDraft = { key: string; draft: WorkspaceDraft & { kind: OlderDraftKind }; unfinished: boolean };

/** Read only the supplied workspace/profile stores. Recovery never clears or rewrites them. */
export function readOlderDrafts(storage: { local: RecoveryStorage; recovery: RecoveryStorage }) {
  const items: OlderDraft[] = [];
  const errors = new Set<string>();
  for (const kind of olderDraftKinds) {
    const state = readModuleState(kind, storage);
    for (const error of [state.error, state.recoveryError]) if (error) errors.add(error);
    for (const draft of state.collection.drafts.filter(item => item.kind === kind)) {
      items.push({ key: `${kind}-${draft.id}`, draft: { ...draft, kind }, unfinished: false });
    }
    if (state.recovery) items.push({ key: `${kind}-${state.recovery.draft.id}-unfinished`, draft: { ...state.recovery.draft, kind }, unfinished: true });
  }
  return { items, error: [...errors].join(' ') };
}

export function olderDraftNotes(item: OlderDraft): { name: string; content: string } {
  const { draft } = item;
  const fields = FIELD_KEYS[draft.kind].filter(key => key in draft.fields).map(key => `${key[0].toUpperCase()}${key.slice(1)}:\n${draft.fields[key]}`);
  return {
    name: `recovered-${item.key}.txt`,
    content: [draft.name, `${olderDraftLabels[draft.kind]}${item.unfinished ? ' (unfinished)' : ''}`, draft.description,
      `Created: ${draft.createdAt}\nUpdated: ${draft.updatedAt}`, ...fields].join('\n\n'),
  };
}

export async function saveOlderDraftNotes(input: { name: string; content: string }, request = api): Promise<SourceDocument> {
  if (new TextEncoder().encode(input.content).byteLength > 65536) throw new Error('These notes exceed the 64 KB file limit. The full original is still available here.');
  const saved = await request<ImportedWorkspaceFile>('/api/files', { method: 'POST', body: JSON.stringify(input) });
  if (!saved?.source?.id || saved.name !== input.name || saved.source.content !== input.content) throw new Error('Saving could not be confirmed. Retry to check the same notes.');
  const source = await request<SourceDocument>(`/api/sources/${encodeURIComponent(saved.source.id)}`);
  if (source?.id !== saved.source.id || source.content !== input.content) throw new Error('The saved notes could not be confirmed. Retry to check the same notes.');
  return source;
}
