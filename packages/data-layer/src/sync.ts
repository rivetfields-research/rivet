import { buildBatch } from './batch.ts';
import { DataLayerError, type DataDiagnostic } from './errors.ts';
import type { RawStore } from './store.ts';
import type { RawBatch, SourceAdapter, SyncReceipt } from './types.ts';

/** Raw acquisition identity. Exported so every caller validates against one definition. */
export const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
export const IDEMPOTENCY_KEY = /^[a-zA-Z0-9_-]{8,128}$/;

export interface SyncRequest<Input> {
  readonly adapter: SourceAdapter<Input>;
  readonly input: Input;
  /** Stable identity of the thing being read, for example `apify:instagram:edtech`. */
  readonly sourceId: string;
  /** Provider account identity when it is genuinely known. Never guessed from content. */
  readonly accountId?: string | null;
  /** One key per attempt. Replaying it returns the stored receipt instead of reading again. */
  readonly idempotencyKey: string;
  readonly now?: () => string;
}

export interface SyncOutcome {
  readonly receipt: SyncReceipt;
  readonly batch: RawBatch | null;
  /** True when the attempt was answered from a stored receipt, so nothing was fetched. */
  readonly replayed: boolean;
  /** True when identical bytes were already stored and no second batch was written. */
  readonly deduplicated: boolean;
}

/**
 * Fetch through an adapter, then persist durably before the checkpoint moves.
 *
 * Ordering is the whole point: the adapter only reads, the store owns the transaction, and
 * the checkpoint is written inside it. A refused read records a failed receipt and leaves
 * the previous checkpoint untouched, so a retry resumes from the same place.
 */
export function runSync<Input>(store: RawStore, request: SyncRequest<Input>): SyncOutcome {
  const now = request.now ?? (() => new Date().toISOString());
  const { adapter, input, idempotencyKey } = request;
  const accountId = request.accountId ?? null;
  if (!SOURCE_ID.test(request.sourceId ?? '')) {
    throw new DataLayerError('Use a stable source id of 1–80 letters, digits, dot, colon, underscore or dash.', 'invalid_source_id');
  }
  if (!IDEMPOTENCY_KEY.test(idempotencyKey ?? '')) {
    throw new DataLayerError('Provide an idempotency key of 8–128 letters, digits, underscores or dashes.', 'invalid_idempotency_key');
  }
  const replayed = store.receiptFor(idempotencyKey);
  if (replayed) {
    // An idempotency key identifies one acquisition. Reusing it for another source, account or
    // adapter is a conflict, never a cache hit: answering it would hand back another
    // connection's data under this request's identity.
    if (replayed.sourceId !== request.sourceId || replayed.accountId !== accountId || replayed.adapter !== adapter.id) {
      throw new DataLayerError(
        `This idempotency key already recorded a sync for ${replayed.sourceId}${replayed.accountId ? ` / ${replayed.accountId}` : ''} via ${replayed.adapter}. Use a new key for another source, account or adapter.`,
        'idempotency_conflict',
        [{ code: 'idempotency_conflict', message: 'An idempotency key may only replay the exact acquisition it first recorded.' }],
      );
    }
    // Resolve through the receipt's own acquisition, never the newest one for those bytes.
    return { receipt: replayed, batch: replayed.observationId ? store.batchAtObservation(replayed.observationId) ?? null : null, replayed: true, deduplicated: false };
  }
  const startedAt = now();
  const cursorBefore = store.checkpoint(request.sourceId, accountId)?.cursor ?? null;
  let fetch;
  try {
    fetch = adapter.read(input, { cursor: cursorBefore });
  } catch (error) {
    const failure = error instanceof DataLayerError
      ? error
      : new DataLayerError(error instanceof Error ? error.message : 'The source read failed.', 'read_failed');
    store.fail({
      idempotencyKey, sourceId: request.sourceId, accountId, adapter: adapter.id, startedAt, cursorBefore,
      error: { code: failure.code, message: failure.message },
    });
    throw failure;
  }
  const batch = buildBatch(fetch, {
    sourceId: request.sourceId, accountId, adapter: adapter.id, cursorBefore, fetchedAt: now(),
  });
  const { receipt, deduplicated } = store.commit({ batch, idempotencyKey, startedAt });
  // Read the batch back through this attempt's observation, so the caller only ever sees what is
  // durable and describes the fetch that just happened.
  const stored = receipt.observationId ? store.batchAtObservation(receipt.observationId) : undefined;
  if (!stored) throw new DataLayerError('The batch could not be read back after the commit.', 'batch_readback_failed');
  return { receipt, batch: stored, replayed: false, deduplicated };
}

/** Diagnostics for a refusal, kept separate so callers can render them without parsing text. */
export function refusalDiagnostics(error: unknown): readonly DataDiagnostic[] {
  return error instanceof DataLayerError ? error.diagnostics : [];
}
