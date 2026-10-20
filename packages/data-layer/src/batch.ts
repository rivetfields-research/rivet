import { createHash } from 'node:crypto';
import { canonicalJson, sha256 } from './hash.ts';
import type { RawBatch, RawFetch, RawManifest } from './types.ts';

/** A batch before the store stamps its identity, observation and save time. */
export type PendingBatch = Omit<RawBatch, 'savedAt' | 'observationId'>;

export const MANIFEST_DIGEST_PREFIX = 200;

/**
 * A null account cannot participate in a uniqueness rule (SQL treats nulls as distinct), so
 * identity uses an explicit empty-string key while the readable account id stays nullable.
 */
export const accountKeyOf = (accountId: string | null): string => accountId ?? '';

/**
 * A batch id is derived from the source, the account, the adapter and the exact bytes. Two
 * accounts reading identical bytes, or two adapters reading them, are different batches —
 * content alone must never let one connection's data answer for another's.
 */
export function batchId(sourceId: string, accountId: string | null, adapter: string, contentHash: string): string {
  return `raw_${sha256([sourceId, accountKeyOf(accountId), adapter, contentHash].join('\u0000')).slice(0, 32)}`;
}

export interface BatchIdentity {
  readonly sourceId: string;
  readonly accountId: string | null;
  readonly adapter: string;
  readonly cursorBefore: string | null;
  readonly fetchedAt: string;
  readonly digestPrefix?: number;
}

/** Pure: turn one adapter read into the batch the store will persist. */
export function buildBatch(fetch: RawFetch, identity: BatchIdentity): PendingBatch {
  const contentHash = sha256(fetch.payload);
  const rolling = createHash('sha256');
  const recordDigests: string[] = [];
  for (const record of fetch.records) {
    const value = sha256(canonicalJson(record));
    rolling.update(`${value}\n`);
    recordDigests.push(value);
  }
  const prefix = identity.digestPrefix ?? MANIFEST_DIGEST_PREFIX;
  const manifest: RawManifest = {
    format: fetch.format,
    records: fetch.records.length,
    bytes: Buffer.byteLength(fetch.payload),
    columns: [...fetch.columns],
    recordDigests: recordDigests.slice(0, prefix),
    digestOfDigests: rolling.digest('hex'),
    digestsTruncated: recordDigests.length > prefix,
  };
  return {
    id: batchId(identity.sourceId, identity.accountId, identity.adapter, contentHash),
    sourceId: identity.sourceId,
    accountId: identity.accountId,
    adapter: identity.adapter,
    cursorBefore: identity.cursorBefore,
    cursorAfter: fetch.cursorAfter,
    fetchedAt: identity.fetchedAt,
    contentHash,
    records: [...fetch.records],
    payload: fetch.payload,
    payloadEncoding: fetch.payloadEncoding,
    manifest,
    provenance: { ...fetch.provenance, untrusted: true },
  };
}
