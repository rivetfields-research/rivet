import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HarnessError } from './errors.ts';
import type { Run, SourceArchiveState, SourceDocument } from './types.ts';
import type { SocialDatasetSummary } from './social-datasets.ts';

export function validateSourceIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) || new Set(value).size !== value.length)
    throw new HarnessError('Select up to 100 unique source IDs from this workspace.', 400, 'invalid_source_ids');
  return [...value].sort();
}

/** Legacy runs approved the whole library; only actually used inputs may carry forward. */
export function inheritedSourceIds(parent: Run, inputIds: ReadonlySet<string>): string[] {
  if (parent.selectedSourceIds) return [...parent.selectedSourceIds];
  const used = new Set([...(parent.result?.citations ?? []), ...(parent.reply?.citations ?? []),
    ...parent.events.filter(event => event.toolName === 'workspace.read').map(event => (event.input as { sourceId?: string } | undefined)?.sourceId).filter((id): id is string => typeof id === 'string')]);
  const output = parent.result ?? parent.reply;
  const calculatedDatasetIds = [output?.analysis?.datasetId, output?.financialAnalysis?.datasetId, output?.tabularAnalysis?.datasetId].filter((id): id is string => Boolean(id));
  for (const source of parent.sources ?? []) if (calculatedDatasetIds.some(id => source.path.startsWith(`datasets/${id}/`))) used.add(source.id);
  return [...used].filter(id => inputIds.has(id));
}

export function inheritedEvidenceIds(parent: Run, sourceFor: (id: string) => SourceDocument | undefined): string[] {
  const candidates = parent.selectedSourceIds ? parent.sourceIds ?? [] : [...(parent.result?.citations ?? []), ...(parent.reply?.citations ?? [])];
  return [...new Set(candidates)].filter(id => {
    if (!parent.sourceIds?.includes(id) || parent.selectedSourceIds?.includes(id)) return false;
    const source = sourceFor(id);
    return source && !source.provenance && /^(?:calculations\/[^/]+\/receipt\.md|social\/[^/]+\/weekly-summary\.md)$/.test(source.path);
  });
}

/** A discoverable input identity; calculating a weekly receipt is a separate action. */
export function socialInputSource(dataset: SocialDatasetSummary): SourceDocument {
  const content = [`# ${dataset.sourceName}`, `Dataset: ${dataset.id}`, `Batch: ${dataset.batchId}`, `Platform: ${dataset.platform}`,
    `Account: ${dataset.accountId}`, `Records: ${dataset.records}`, 'Already-fetched public post records. Attach this input explicitly to a task to calculate post performance.'].join('\n\n');
  return { id: `source_${createHash('sha256').update(`social-input:${dataset.id}`).digest('hex')}`, title: `Social data · ${dataset.sourceName}`,
    path: `social/${dataset.batchId}/input.md`, bytes: Buffer.byteLength(content), content };
}

export function sourceArchiveStore(db: DatabaseSync, inputs: () => SourceDocument[]) {
  db.exec('CREATE TABLE IF NOT EXISTS source_archives (source_id TEXT PRIMARY KEY REFERENCES sources(id), archived_at TEXT NOT NULL)');
  const isArchived = (id: string) => Boolean(db.prepare('SELECT 1 FROM source_archives WHERE source_id=?').get(id));
  return {
    isArchived,
    list(): SourceArchiveState[] { return db.prepare('SELECT source_id,archived_at FROM source_archives ORDER BY archived_at,source_id').all().map(row => ({ sourceId: row.source_id as string, archived: true, archivedAt: row.archived_at as string })); },
    set(sourceId: string, archived: boolean): SourceArchiveState {
      validateSourceIds([sourceId]);
      if (typeof archived !== 'boolean') throw new HarnessError('Provide archived as a boolean.',400,'invalid_source_archive');
      const source = inputs().find(item => item.id === sourceId);
      if (!source) throw new HarnessError('That input source is not available in this workspace.',404,'unknown_source');
      if (archived) {
        db.prepare('INSERT OR IGNORE INTO sources(id,data) VALUES (?,?)').run(source.id,JSON.stringify(source));
        db.prepare('INSERT OR IGNORE INTO source_archives(source_id,archived_at) VALUES (?,?)').run(sourceId,new Date().toISOString());
      } else db.prepare('DELETE FROM source_archives WHERE source_id=?').run(sourceId);
      return { sourceId, archived, archivedAt: (db.prepare('SELECT archived_at FROM source_archives WHERE source_id=?').get(sourceId)?.archived_at as string | undefined) ?? null };
    },
  };
}
