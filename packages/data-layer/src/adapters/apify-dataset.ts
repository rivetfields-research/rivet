import { canonicalJson } from '../hash.ts';
import { refuse } from '../errors.ts';
import type { RawCoverage, RawRecord, RawScalar, RawFetch, SourceAdapter } from '../types.ts';

export const APIFY_DATASET_LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, records: 10_000 });

export type ApifyPlatform = 'instagram' | 'facebook';

export interface ApifyDatasetInput {
  /** Dataset identifier from the completed run. Recorded as provenance, never fetched here. */
  readonly datasetId?: string | null;
  /** Declared platform of the export. It selects the label only; this adapter does not map fields. */
  readonly platform?: ApifyPlatform | null;
  /** Already-fetched or exported dataset JSON: an array, `{ items: [...] }`, or JSONL text. */
  readonly json: string | readonly unknown[];
  /** Position of the first record inside a paginated fetch, when the caller paged the dataset. */
  readonly offset?: number | null;
  /**
   * Dataset positions the page covered, when the caller dropped some items it read (empty items, M9). The cursor then
   * moves past every position read, not only the records kept. Defaults to the number of records.
   */
  readonly count?: number | null;
  readonly declaredCoverage?: RawCoverage;
}

/** Provider shapes that are not post records. Naming them beats silently importing a profile. */
const NOT_A_POST = ['error', 'commentUrl', 'latestPosts'] as const;

function parseItems(json: string | readonly unknown[]): unknown[] {
  if (Array.isArray(json)) return [...json];
  if (typeof json !== 'string') refuse('invalid_dataset_json', 'Provide the dataset as JSON text or as an already-parsed array of records.');
  // The limit applies to the bytes as supplied, before any trimming: whitespace is payload too.
  if (Buffer.byteLength(json) > APIFY_DATASET_LIMITS.bytes) {
    refuse('byte_limit', `The dataset JSON must be at most ${APIFY_DATASET_LIMITS.bytes / (1024 * 1024)} MiB; page the dataset and fetch a bounded window.`);
  }
  const text = json.replace(/^\uFEFF/, '').trim();
  if (!text) refuse('empty_file', 'The dataset JSON is empty.');
  if (text.startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { refuse('invalid_dataset_json', 'The dataset JSON could not be parsed. Re-export it as a JSON array or as JSONL.'); }
    if (!Array.isArray(parsed)) refuse('invalid_dataset_json', 'The dataset JSON must be an array of records.');
    return parsed;
  }
  if (text.startsWith('{')) {
    // A single object is accepted only in the documented `{ items: [...] }` envelope.
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch {
      // Fall through to JSONL: one record per line is a supported export shape.
      return parseJsonLines(text);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { items?: unknown }).items)) {
      return [...(parsed as { items: unknown[] }).items];
    }
    return parseJsonLines(text);
  }
  return parseJsonLines(text);
}

function parseJsonLines(text: string): unknown[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) refuse('empty_file', 'The dataset JSON contains no records.');
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch { refuse('invalid_dataset_json', `Line ${index + 1} is not valid JSON. Export the dataset as a JSON array or as one JSON object per line.`, { record: index + 1 }); }
  });
}

/** Scalars are preserved exactly. Nested values keep their content as canonical JSON text. */
function toRecord(item: Record<string, unknown>): RawRecord {
  const record: Record<string, RawScalar> = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined) continue;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') record[key] = value;
    else if (typeof value === 'number') record[key] = Number.isFinite(value) ? value : null;
    else record[key] = canonicalJson(value);
  }
  return record;
}

/**
 * An already-fetched Apify dataset. This adapter deliberately stops at the provider's own
 * shape: it does not choose which field is a like count, and it does not infer an account.
 * Field mapping belongs to the strict phase 2 normalizer, which can refuse a schema it does
 * not recognise instead of guessing.
 */
export const apifyDatasetAdapter: SourceAdapter<ApifyDatasetInput> = {
  id: 'apify-dataset',
  format: 'json',
  read(input, _context): RawFetch {
    if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('invalid_dataset_input', 'Provide a fetched dataset as { json } with an optional datasetId and platform.');
    const items = parseItems(input.json);
    if (!items.length) refuse('empty_dataset', 'The dataset contains no records. Confirm the run finished and exported its default dataset.');
    if (items.length > APIFY_DATASET_LIMITS.records) {
      refuse('record_limit', `The dataset has more than ${APIFY_DATASET_LIMITS.records.toLocaleString('en-US')} records; fetch a bounded window with an offset.`);
    }
    const records = items.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        refuse('invalid_record', `Record ${index + 1} is not a JSON object; export the posts dataset rather than a mixed export.`, { record: index + 1 });
      }
      const found = NOT_A_POST.find(marker => marker === 'error' ? Boolean((item as Record<string, unknown>).error) : marker in (item as Record<string, unknown>));
      if (found) {
        refuse('unsupported_record', `Record ${index + 1} is a ${found === 'error' ? 'provider error' : found === 'commentUrl' ? 'comment' : 'profile'} object, not a post. Export the posts dataset for this run and retry.`, { record: index + 1, field: found });
      }
      return toRecord(item as Record<string, unknown>);
    });
    const columns = [...new Set(records.flatMap(record => Object.keys(record)))].sort();
    const offset = input.offset ?? null;
    if (offset !== null && (!Number.isSafeInteger(offset) || offset < 0)) refuse('invalid_offset', 'Provide a whole non-negative offset, or omit it for a complete export.');
    const count = input.count ?? null;
    if (count !== null && (offset === null || !Number.isSafeInteger(count) || count < items.length)) refuse('invalid_offset', 'A page count needs an offset and covers at least the records kept.');
    if (offset !== null && !Number.isSafeInteger(offset + (count ?? items.length))) refuse('invalid_offset', 'The offset plus this page exceeds exact integer range; page the dataset in smaller windows.');
    const platform = input.platform ?? null;
    if (platform !== null && platform !== 'instagram' && platform !== 'facebook') refuse('invalid_platform', 'Declare the platform as instagram or facebook, or omit it.');
    // An array boundary carries no original bytes, so the payload is a faithful re-serialization
    // of the parsed records, nested structure included, and it says so. The flattened `records`
    // remain a separate projection and never stand in for the payload.
    const supplied = typeof input.json === 'string';
    const payload = supplied ? input.json as string : JSON.stringify(input.json, null, 2);
    if (!supplied && Buffer.byteLength(payload) > APIFY_DATASET_LIMITS.bytes) {
      refuse('byte_limit', `The dataset JSON must be at most ${APIFY_DATASET_LIMITS.bytes / (1024 * 1024)} MiB; page the dataset and fetch a bounded window.`);
    }
    return {
      payload,
      payloadEncoding: supplied ? 'original' : 'reserialized',
      records,
      format: 'json',
      columns,
      // Only a paged fetch has a position. A one-shot export is a complete snapshot.
      cursorAfter: offset === null ? null : String(offset + (count ?? records.length)),
      provenance: {
        kind: 'dataset-export',
        label: platform ? `Apify dataset export (${platform})` : 'Apify dataset export',
        locator: typeof input.datasetId === 'string' && input.datasetId.trim() ? input.datasetId.trim() : null,
        declaredCoverage: input.declaredCoverage ?? 'unknown',
      },
    };
  },
};
