import { sha256 } from './hash.ts';
import { TOOL_IDS, type InternalToolId } from './labels.ts';
import type { RawBatch, RawCoverage } from './types.ts';

export const FRESHNESS_LIMITS = Object.freeze({ freshSeconds: 24 * 60 * 60, ageingSeconds: 7 * 24 * 60 * 60 });

export type Freshness = 'fresh' | 'ageing' | 'stale';

/**
 * Ties one deterministic calculation back to the immutable snapshot it read, so a reviewer
 * can answer: which bytes, which records, when they were fetched, and how old they are now.
 * It records what was read and when; it does not certify that a provider's numbers are true.
 */
export interface EvidenceReceipt {
  readonly id: string;
  /** Internal, namespaced. Never render this; render `label`. */
  readonly toolId: InternalToolId;
  readonly label: string;
  readonly batchId: string;
  readonly batchContentHash: string;
  readonly sourceId: string;
  readonly accountId: string | null;
  readonly adapter: string;
  /** Version of the normalization contract that produced the rows, not of the provider. */
  readonly sourceVersion: string;
  readonly records: readonly number[];
  readonly columns: readonly string[];
  readonly coverage: RawCoverage;
  readonly fetchedAt: string;
  readonly syncedAt: string;
  readonly computedAt: string;
  readonly freshness: Freshness;
  readonly ageSeconds: number;
}

export function freshnessOf(fetchedAt: string, computedAt: string): { freshness: Freshness; ageSeconds: number } {
  const ageSeconds = Math.max(0, Math.floor((Date.parse(computedAt) - Date.parse(fetchedAt)) / 1000));
  if (!Number.isFinite(ageSeconds)) return { freshness: 'stale', ageSeconds: 0 };
  return { freshness: ageSeconds <= FRESHNESS_LIMITS.freshSeconds ? 'fresh' : ageSeconds <= FRESHNESS_LIMITS.ageingSeconds ? 'ageing' : 'stale', ageSeconds };
}

export interface ReceiptInput {
  readonly batch: RawBatch;
  readonly toolId: InternalToolId;
  readonly label: string;
  readonly sourceVersion: string;
  readonly records: readonly number[];
  readonly computedAt: string;
}

export function buildReceipt(input: ReceiptInput): EvidenceReceipt {
  const { batch } = input;
  const { freshness, ageSeconds } = freshnessOf(batch.fetchedAt, input.computedAt);
  const records = [...new Set(input.records)].sort((a, b) => a - b);
  return {
    id: `receipt_${sha256([batch.id, input.toolId, input.sourceVersion, records.join(','), input.computedAt].join('\u0000')).slice(0, 32)}`,
    toolId: input.toolId,
    label: input.label,
    batchId: batch.id,
    batchContentHash: batch.contentHash,
    sourceId: batch.sourceId,
    accountId: batch.accountId,
    adapter: batch.adapter,
    sourceVersion: input.sourceVersion,
    records,
    columns: [...batch.manifest.columns],
    coverage: batch.provenance.declaredCoverage,
    fetchedAt: batch.fetchedAt,
    syncedAt: batch.savedAt,
    computedAt: input.computedAt,
    freshness,
    ageSeconds,
  };
}

/** Two snapshots describe comparable counters only when they were observed close together. */
export const CONTEMPORANEOUS_TOLERANCE_SECONDS = 24 * 60 * 60;

export function observationGapSeconds(left: RawBatch, right: RawBatch): number {
  return Math.abs(Math.floor((Date.parse(left.fetchedAt) - Date.parse(right.fetchedAt)) / 1000));
}

export const RECEIPT_TOOL_IDS = TOOL_IDS;
