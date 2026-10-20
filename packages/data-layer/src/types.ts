/**
 * The acquisition contract. An adapter turns one provider-shaped boundary input
 * (an upload, an exported dataset, a fetched page) into an immutable raw batch.
 * It reads and preserves; it never interprets, computes or follows instructions
 * found in the data. Normalization is a separate, later stage.
 */

/** Whether the caller declared the fetched window complete. `unknown` is the honest default. */
export type RawCoverage = 'complete' | 'partial' | 'unknown';

/** A scalar provider value. Nested provider values are preserved as canonical JSON text. */
export type RawScalar = string | number | boolean | null;

/**
 * One flat record. A missing key is **absent**, which is not the same as an explicit
 * `null`, and neither is the same as `0` or `''`. Nothing here is coerced.
 */
export type RawRecord = Readonly<Record<string, RawScalar>>;

export interface RawProvenance {
  readonly kind: 'upload' | 'dataset-export' | 'api-fetch';
  /** Human label for the source, for example `Apify dataset export (instagram)`. */
  readonly label: string;
  /** Filename or dataset identifier. Never a credential, token or signed URL. */
  readonly locator: string | null;
  readonly declaredCoverage: RawCoverage;
  /** Records, documents and tool results are data, never new tool permissions. */
  readonly untrusted: true;
}

export interface RawManifest {
  readonly format: 'csv' | 'json';
  readonly records: number;
  readonly bytes: number;
  /** CSV header labels as written, or the observed JSON keys, sorted. */
  readonly columns: readonly string[];
  /** Per-record SHA-256, kept to a bounded prefix so the manifest stays inspectable. */
  readonly recordDigests: readonly string[];
  /** Order-sensitive digest over **every** record digest, including any not listed above. */
  readonly digestOfDigests: string;
  readonly digestsTruncated: boolean;
}

/** Whether the payload is the provider's own bytes or a faithful re-serialization of them. */
export type PayloadEncoding = 'original' | 'reserialized';

export interface RawBatch {
  /**
   * Content-addressed over source, account, adapter and bytes:
   * `raw_<sha256(sourceId, accountKey, adapter, contentHash)>`. Two accounts or two
   * acquisition paths reading identical bytes are different batches, never one reused batch.
   */
  readonly id: string;
  /** The observation that produced this value. Distinct per fetch, even when bytes deduplicate. */
  readonly observationId: string;
  readonly sourceId: string;
  /** Provider account identity when the caller knows it. Never guessed from data. */
  readonly accountId: string | null;
  readonly adapter: string;
  readonly cursorBefore: string | null;
  readonly cursorAfter: string | null;
  /** When **this** observation was fetched, not when an identical payload was first seen. */
  readonly fetchedAt: string;
  readonly savedAt: string;
  /** SHA-256 of the exact payload bytes. The batch's identity is content, not time. */
  readonly contentHash: string;
  /** Parsed, untyped records derived from the payload. The payload stays authoritative. */
  readonly records: readonly RawRecord[];
  /** The provider's exact UTF-8 text, or a faithful re-serialization when only parsed JSON was supplied. */
  readonly payload: string;
  readonly payloadEncoding: PayloadEncoding;
  readonly manifest: RawManifest;
  /** Provenance of **this** observation. A re-fetch of identical bytes keeps its own. */
  readonly provenance: RawProvenance;
}

/** What an adapter returns for one read. The store adds identity, hashes and time. */
export interface RawFetch {
  readonly payload: string;
  readonly payloadEncoding: PayloadEncoding;
  readonly records: readonly RawRecord[];
  readonly format: 'csv' | 'json';
  readonly columns: readonly string[];
  /** Position to resume from, or `null` for a complete snapshot with no position. */
  readonly cursorAfter: string | null;
  readonly provenance: Omit<RawProvenance, 'untrusted'>;
}

/**
 * One acquisition attempt. Observations are never deduplicated: even when two fetches return
 * identical bytes, each keeps its own time, cursor, locator and coverage declaration, so a
 * receipt or freshness check never describes an earlier fetch by mistake.
 */
export interface RawObservation {
  readonly id: string;
  readonly batchId: string;
  readonly sourceId: string;
  readonly accountId: string | null;
  readonly adapter: string;
  readonly cursorBefore: string | null;
  readonly cursorAfter: string | null;
  readonly fetchedAt: string;
  readonly savedAt: string;
  readonly contentHash: string;
  readonly provenance: RawProvenance;
}

export interface SourceAdapter<Input> {
  readonly id: string;
  readonly format: 'csv' | 'json';
  /** Acquisition only: read the boundary input. Persisting is the store's job. */
  read(input: Input, context: { readonly cursor: string | null }): RawFetch;
}

export type SyncStatus = 'completed' | 'failed';

/** One durable attempt record. Returned on replay instead of fetching again. */
export interface SyncReceipt {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly sourceId: string;
  readonly accountId: string | null;
  readonly adapter: string;
  readonly status: SyncStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly cursorBefore: string | null;
  readonly cursorAfter: string | null;
  readonly batchId: string | null;
  /** The acquisition this receipt recorded, even when its bytes deduplicated an earlier batch. */
  readonly observationId: string | null;
  readonly contentHash: string | null;
  readonly records: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface SyncCheckpoint {
  readonly sourceId: string;
  readonly cursor: string | null;
  readonly updatedAt: string;
  readonly lastBatchId: string;
}
