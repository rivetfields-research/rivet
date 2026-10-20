import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from './hash.ts';
import { accountKeyOf, type PendingBatch } from './batch.ts';
import type { PayloadEncoding, RawBatch, RawManifest, RawObservation, RawProvenance, RawRecord, SyncCheckpoint, SyncReceipt, SyncStatus } from './types.ts';

export interface RawStoreOptions {
  /** Injectable clock so tests can assert ordering without depending on wall time. */
  readonly now?: () => Date;
}

export interface CommitInput {
  readonly batch: PendingBatch;
  /** Stable per attempt: a replayed key returns the original receipt instead of re-fetching. */
  readonly idempotencyKey: string;
  readonly startedAt: string;
}

export interface CommitResult {
  readonly receipt: SyncReceipt;
  readonly batch: RawBatch;
  /** True when identical bytes for this source/account/adapter were already stored. */
  readonly deduplicated: boolean;
}

export interface FailInput {
  readonly idempotencyKey: string;
  readonly sourceId: string;
  readonly accountId: string | null;
  readonly adapter: string;
  readonly startedAt: string;
  readonly cursorBefore: string | null;
  readonly error: { readonly code: string; readonly message: string };
}

const receiptId = (idempotencyKey: string) => `sync_${sha256(idempotencyKey).slice(0, 32)}`;
const observationId = (batchId: string, idempotencyKey: string) => `obs_${sha256(`${batchId}\u0000${idempotencyKey}`).slice(0, 32)}`;

type Row = Record<string, unknown>;

/**
 * Durable storage for raw batches, acquisition observations, checkpoints and sync receipts.
 *
 * Two things are deliberately separate:
 *
 * - a **batch** is immutable bytes, unique per (source, account, adapter, content hash), so
 *   re-fetching identical data never duplicates a payload; and
 * - an **observation** is one acquisition, never deduplicated, so a re-fetch keeps its own
 *   time, cursor, locator and coverage instead of inheriting an earlier fetch's provenance.
 *
 * The batch row, its observation, the checkpoint update and the receipt commit in **one**
 * transaction, so a checkpoint can never point past data that was not saved. `synchronous=FULL`
 * makes that commit survive a crash.
 */
export function openRawStore(filePath: string, options: RawStoreOptions = {}) {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS raw_batches (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      account_id TEXT,
      adapter TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      payload_encoding TEXT NOT NULL,
      records_data TEXT NOT NULL,
      manifest TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      UNIQUE (source_id, account_key, adapter, content_hash)
    );
    CREATE INDEX IF NOT EXISTS raw_batches_source ON raw_batches (source_id, account_key, first_seen_at);
    CREATE TABLE IF NOT EXISTS raw_observations (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES raw_batches(id),
      source_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      account_id TEXT,
      adapter TEXT NOT NULL,
      cursor_before TEXT,
      cursor_after TEXT,
      fetched_at TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      provenance TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS raw_observations_source ON raw_observations (source_id, account_key, saved_at);
    CREATE TABLE IF NOT EXISTS sync_cursors (
      source_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      cursor TEXT,
      updated_at TEXT NOT NULL,
      last_batch_id TEXT NOT NULL,
      PRIMARY KEY (source_id, account_key)
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL,
      account_id TEXT,
      adapter TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      cursor_before TEXT,
      cursor_after TEXT,
      batch_id TEXT,
      observation_id TEXT,
      content_hash TEXT,
      records INTEGER NOT NULL,
      error_code TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS sync_runs_source ON sync_runs (source_id, started_at);`);

  const blob = (row: Row) => ({
    id: row.id as string,
    sourceId: row.source_id as string,
    accountId: (row.account_id as string | null) ?? null,
    adapter: row.adapter as string,
    contentHash: row.content_hash as string,
    payload: row.payload as string,
    payloadEncoding: row.payload_encoding as PayloadEncoding,
    records: JSON.parse(row.records_data as string) as RawRecord[],
    manifest: JSON.parse(row.manifest as string) as RawManifest,
    firstSeenAt: row.first_seen_at as string,
  });
  const observation = (row: Row): RawObservation => ({
    id: row.id as string,
    batchId: row.batch_id as string,
    sourceId: row.source_id as string,
    accountId: (row.account_id as string | null) ?? null,
    adapter: row.adapter as string,
    cursorBefore: (row.cursor_before as string | null) ?? null,
    cursorAfter: (row.cursor_after as string | null) ?? null,
    fetchedAt: row.fetched_at as string,
    savedAt: row.saved_at as string,
    contentHash: row.content_hash as string,
    provenance: JSON.parse(row.provenance as string) as RawProvenance,
  });
  const receiptRow = (row: Row | undefined): SyncReceipt | undefined => row ? {
    id: row.id as string,
    idempotencyKey: row.idempotency_key as string,
    sourceId: row.source_id as string,
    accountId: (row.account_id as string | null) ?? null,
    adapter: row.adapter as string,
    status: row.status as SyncStatus,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string,
    cursorBefore: (row.cursor_before as string | null) ?? null,
    cursorAfter: (row.cursor_after as string | null) ?? null,
    batchId: (row.batch_id as string | null) ?? null,
    observationId: (row.observation_id as string | null) ?? null,
    contentHash: (row.content_hash as string | null) ?? null,
    records: row.records as number,
    errorCode: (row.error_code as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
  } : undefined;
  const latestObservation = (batchId: string): RawObservation | undefined => {
    const row = db.prepare('SELECT * FROM raw_observations WHERE batch_id=? ORDER BY saved_at DESC, id DESC LIMIT 1').get(batchId) as Row | undefined;
    return row ? observation(row) : undefined;
  };
  /** A stored batch is always presented through one of its observations, never merged. */
  const joinWith = (stored: ReturnType<typeof blob>, seen: RawObservation): RawBatch => {
    return {
      id: stored.id,
      observationId: seen.id,
      sourceId: stored.sourceId,
      accountId: stored.accountId,
      adapter: stored.adapter,
      cursorBefore: seen.cursorBefore,
      cursorAfter: seen.cursorAfter,
      fetchedAt: seen.fetchedAt,
      savedAt: seen.savedAt,
      contentHash: stored.contentHash,
      records: stored.records,
      payload: stored.payload,
      payloadEncoding: stored.payloadEncoding,
      manifest: stored.manifest,
      provenance: seen.provenance,
    };
  };
  const joinLatest = (row: Row): RawBatch => {
    const stored = blob(row);
    const seen = latestObservation(stored.id);
    if (!seen) throw new Error(`Stored batch ${stored.id} has no acquisition observation.`);
    return joinWith(stored, seen);
  };
  const findRow = (sourceId: string, accountId: string | null, adapter: string, contentHash: string) =>
    db.prepare('SELECT * FROM raw_batches WHERE source_id=? AND account_key=? AND adapter=? AND content_hash=?')
      .get(sourceId, accountKeyOf(accountId), adapter, contentHash) as Row | undefined;
  return {
    /** Returns the stored receipt for a replayed attempt, whatever its outcome. */
    receiptFor(idempotencyKey: string): SyncReceipt | undefined {
      return receiptRow(db.prepare('SELECT * FROM sync_runs WHERE idempotency_key=?').get(idempotencyKey) as Row | undefined);
    },
    receipt(id: string): SyncReceipt | undefined {
      return receiptRow(db.prepare('SELECT * FROM sync_runs WHERE id=?').get(id) as Row | undefined);
    },
    getBatch(id: string): RawBatch | undefined {
      const row = db.prepare('SELECT * FROM raw_batches WHERE id=?').get(id) as Row | undefined;
      return row ? joinLatest(row) : undefined;
    },
    /** Content identity is scoped to the source, account and adapter that read it. */
    findBatch(sourceId: string, contentHash: string, accountId: string | null = null, adapter?: string): RawBatch | undefined {
      const row = adapter
        ? findRow(sourceId, accountId, adapter, contentHash)
        : db.prepare('SELECT * FROM raw_batches WHERE source_id=? AND account_key=? AND content_hash=? ORDER BY first_seen_at DESC LIMIT 1')
          .get(sourceId, accountKeyOf(accountId), contentHash) as Row | undefined;
      return row ? joinLatest(row) : undefined;
    },
    listBatches(sourceId?: string): RawBatch[] {
      const rows = sourceId
        ? db.prepare('SELECT * FROM raw_batches WHERE source_id=? ORDER BY first_seen_at DESC, id').all(sourceId)
        : db.prepare('SELECT * FROM raw_batches ORDER BY first_seen_at DESC, id').all();
      return rows.map(row => joinLatest(row as Row));
    },
    /** Every acquisition of this source, newest first: bytes may deduplicate, observations never do. */
    observationsFor(sourceId: string, accountId: string | null = null): RawObservation[] {
      return db.prepare('SELECT * FROM raw_observations WHERE source_id=? AND account_key=? ORDER BY saved_at DESC, id DESC')
        .all(sourceId, accountKeyOf(accountId)).map(row => observation(row as Row));
    },
    observation(id: string): RawObservation | undefined {
      const row = db.prepare('SELECT * FROM raw_observations WHERE id=?').get(id) as Row | undefined;
      return row ? observation(row) : undefined;
    },
    /**
     * The batch as it stood for one specific acquisition.
     *
     * Evidence and freshness must describe the fetch a receipt recorded, so a receipt-bound read
     * resolves through its own observation. Reading the newest observation would let a replayed
     * old attempt report a later fetch's time and provenance.
     */
    batchAtObservation(observationID: string): RawBatch | undefined {
      const seen = this.observation(observationID);
      if (!seen) return undefined;
      const row = db.prepare('SELECT * FROM raw_batches WHERE id=?').get(seen.batchId) as Row | undefined;
      return row ? joinWith(blob(row), seen) : undefined;
    },
    /** A checkpoint belongs to one source **and** one account; accounts never share a cursor. */
    checkpoint(sourceId: string, accountId: string | null = null): SyncCheckpoint | undefined {
      const row = db.prepare('SELECT * FROM sync_cursors WHERE source_id=? AND account_key=?').get(sourceId, accountKeyOf(accountId)) as Row | undefined;
      return row ? { sourceId: row.source_id as string, cursor: (row.cursor as string | null) ?? null, updatedAt: row.updated_at as string, lastBatchId: row.last_batch_id as string } : undefined;
    },
    listSyncRuns(sourceId?: string): SyncReceipt[] {
      const rows = sourceId
        ? db.prepare('SELECT * FROM sync_runs WHERE source_id=? ORDER BY started_at DESC, id').all(sourceId)
        : db.prepare('SELECT * FROM sync_runs ORDER BY started_at DESC, id').all();
      return rows.map(row => receiptRow(row as Row)!);
    },
    /**
     * Store one fetched batch, record its observation, advance the checkpoint and write the
     * receipt atomically. The batch is written before the checkpoint and both roll back
     * together, so a saved checkpoint always refers to data that is already durable.
     *
     * A replayed attempt is answered from `receiptFor` by the caller: reaching here twice with
     * the same idempotency key is a programming error and fails on the unique index.
     */
    commit(input: CommitInput): CommitResult {
      const { batch, idempotencyKey, startedAt } = input;
      const savedAt = now();
      const accountKey = accountKeyOf(batch.accountId);
      const seenId = observationId(batch.id, idempotencyKey);
      db.exec('BEGIN IMMEDIATE');
      try {
        const inserted = db.prepare(`INSERT INTO raw_batches
          (id, source_id, account_key, account_id, adapter, content_hash, payload, payload_encoding, records_data, manifest, first_seen_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id, account_key, adapter, content_hash) DO NOTHING`).run(
          batch.id, batch.sourceId, accountKey, batch.accountId, batch.adapter, batch.contentHash, batch.payload,
          batch.payloadEncoding, JSON.stringify(batch.records), JSON.stringify(batch.manifest), savedAt);
        const deduplicated = Number(inserted.changes) === 0;
        const storedId = findRow(batch.sourceId, batch.accountId, batch.adapter, batch.contentHash)!.id as string;
        db.prepare(`INSERT INTO raw_observations
          (id, batch_id, source_id, account_key, account_id, adapter, cursor_before, cursor_after, fetched_at, saved_at, content_hash, provenance)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          seenId, storedId, batch.sourceId, accountKey, batch.accountId, batch.adapter, batch.cursorBefore,
          batch.cursorAfter, batch.fetchedAt, savedAt, batch.contentHash, JSON.stringify(batch.provenance));
        // A null cursor means "complete snapshot with no position": it must not erase a checkpoint.
        if (batch.cursorAfter !== null) {
          db.prepare(`INSERT INTO sync_cursors (source_id, account_key, cursor, updated_at, last_batch_id) VALUES (?,?,?,?,?)
            ON CONFLICT(source_id, account_key) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at, last_batch_id=excluded.last_batch_id`)
            .run(batch.sourceId, accountKey, batch.cursorAfter, savedAt, storedId);
        }
        const receipt: SyncReceipt = {
          id: receiptId(idempotencyKey), idempotencyKey, sourceId: batch.sourceId, accountId: batch.accountId, adapter: batch.adapter,
          status: 'completed', startedAt, finishedAt: savedAt, cursorBefore: batch.cursorBefore, cursorAfter: batch.cursorAfter,
          batchId: storedId, observationId: seenId, contentHash: batch.contentHash, records: batch.records.length,
          errorCode: null, errorMessage: null,
        };
        db.prepare(`INSERT INTO sync_runs
          (id, idempotency_key, source_id, account_id, adapter, status, started_at, finished_at, cursor_before, cursor_after, batch_id, observation_id, content_hash, records, error_code, error_message)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          receipt.id, receipt.idempotencyKey, receipt.sourceId, receipt.accountId, receipt.adapter, receipt.status, receipt.startedAt,
          receipt.finishedAt, receipt.cursorBefore, receipt.cursorAfter, receipt.batchId, receipt.observationId, receipt.contentHash,
          receipt.records, null, null);
        db.exec('COMMIT');
        return { receipt, batch: this.batchAtObservation(seenId)!, deduplicated };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    /** A refused fetch still leaves a durable receipt, and never moves the checkpoint. */
    fail(input: FailInput): SyncReceipt {
      const existing = this.receiptFor(input.idempotencyKey);
      if (existing) return existing;
      const finishedAt = now();
      const receipt: SyncReceipt = {
        id: receiptId(input.idempotencyKey), idempotencyKey: input.idempotencyKey, sourceId: input.sourceId, accountId: input.accountId,
        adapter: input.adapter, status: 'failed', startedAt: input.startedAt, finishedAt, cursorBefore: input.cursorBefore,
        cursorAfter: null, batchId: null, observationId: null, contentHash: null, records: 0,
        errorCode: input.error.code, errorMessage: input.error.message,
      };
      db.prepare(`INSERT INTO sync_runs
        (id, idempotency_key, source_id, account_id, adapter, status, started_at, finished_at, cursor_before, cursor_after, batch_id, observation_id, content_hash, records, error_code, error_message)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receipt.id, receipt.idempotencyKey, receipt.sourceId, receipt.accountId, receipt.adapter, receipt.status, receipt.startedAt,
        receipt.finishedAt, receipt.cursorBefore, receipt.cursorAfter, null, null, null, 0, receipt.errorCode, receipt.errorMessage);
      return receipt;
    },
    close() { db.close(); },
    /** Exposed for bounded inspection scripts and for the phase 2 query tables. */
    database: db,
  };
}

export type RawStore = ReturnType<typeof openRawStore>;
