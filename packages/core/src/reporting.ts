import { createHash } from 'node:crypto';

/** Development contract for a fictional usage report; not an agreed customer schema. */
export const USAGE_SCHEMA_VERSION = 'fictional-usage-csv/v1' as const;
export const USAGE_METRICS_VERSION = 'weekly-usage/v1' as const;
export const USAGE_IMPORT_LIMITS = Object.freeze({ bytes: 1024 * 1024, rows: 10_000, columns: 3, fieldBytes: 4096, errors: 50 });
const COLUMNS = ['date', 'user_id', 'event'] as const;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const DAY = 86_400_000;

export interface UsageDiagnostic {
  readonly code: string;
  readonly message: string;
  /** CSV record number, including the header; quoted newlines do not create records. */
  readonly record?: number;
  readonly column?: string;
  readonly count?: number;
}
export interface UsageRow {
  readonly record: number;
  readonly date: string;
  readonly userId: string;
  readonly event: string;
}
export interface UsageDataset {
  readonly id: string;
  readonly schemaVersion: typeof USAGE_SCHEMA_VERSION;
  /** SHA-256 of the exact UTF-8 upload, before BOM/newline handling. */
  readonly contentHash: string;
  readonly sourceName: string;
  readonly bytes: number;
  readonly rows: readonly UsageRow[];
  readonly duplicatePolicy: 'keep-and-warn';
  readonly duplicateRows: number;
}
export type UsageImportResult =
  | { readonly ok: true; readonly dataset: UsageDataset; readonly warnings: readonly UsageDiagnostic[] }
  | { readonly ok: false; readonly errors: readonly UsageDiagnostic[]; readonly warnings: readonly UsageDiagnostic[] };

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function failure(code: string, message: string, record?: number): UsageImportResult {
  return freeze({ ok: false, errors: [{ code, message, ...(record ? { record } : {}) }], warnings: [] });
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

/**
 * Strict, bounded CSV state machine: UTF-8, comma separator, LF or CRLF, optional
 * initial BOM, quoted fields and doubled quotes. Bare CR, malformed quoting,
 * blank records and additional columns are rejected rather than repaired.
 * The entire import fails on invalid input; there is no partial dataset.
 */
export function importUsageCsv(input: string | Uint8Array, sourceName = 'usage.csv'): UsageImportResult {
  if (typeof sourceName !== 'string' || !sourceName.trim() || sourceName !== sourceName.trim() || CONTROLS.test(sourceName) || Buffer.byteLength(sourceName) > 200) {
    return failure('invalid_source_name', 'Use a nonempty source label of at most 200 UTF-8 bytes without control characters.');
  }
  if (!(typeof input === 'string' || input instanceof Uint8Array)) return failure('invalid_input', 'Provide a UTF-8 string or byte array.');
  // In Unicode mode valid surrogate pairs are full code points, outside this range.
  if (typeof input === 'string' && /[\ud800-\udfff]/u.test(input)) return failure('invalid_utf8', 'The upload contains an unpaired Unicode surrogate.');
  const bytesLength = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength;
  if (bytesLength > USAGE_IMPORT_LIMITS.bytes) return failure('byte_limit', 'The CSV must be at most 1 MiB.');
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return failure('invalid_utf8', 'The CSV must contain valid UTF-8.'); }
  if (!text.length) return failure('empty_file', 'The CSV is empty.');
  // TextDecoder removes an initial BOM; the content hash still includes it.
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let pendingRecord = false;
  const diagnostic = (code: string, message: string) => failure(code, message, records.length + 1);
  const finishField = (): UsageImportResult | undefined => {
    if (Buffer.byteLength(field) > USAGE_IMPORT_LIMITS.fieldBytes) return diagnostic('field_limit', 'A field exceeds 4,096 UTF-8 bytes.');
    record.push(field); field = ''; state = 'start';
    if (record.length > USAGE_IMPORT_LIMITS.columns) return diagnostic('column_count', 'Every record must have exactly three columns.');
  };
  const finishRecord = (): UsageImportResult | undefined => {
    const error = finishField();
    if (error) return error;
    if (record.length !== USAGE_IMPORT_LIMITS.columns) return diagnostic('column_count', 'Every record must have exactly three columns; blank records are not allowed.');
    records.push(record); record = []; pendingRecord = false;
    if (records.length > USAGE_IMPORT_LIMITS.rows + 1) return failure('row_limit', 'The CSV must have at most 10,000 data records.', records.length);
  };
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    pendingRecord = true;
    if (state === 'quoted') {
      if (character === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else state = 'closed';
      } else field += character;
    } else if (character === ',' || character === '\n' || character === '\r') {
      if (character === '\r') {
        if (text[i + 1] !== '\n') return diagnostic('invalid_newline', 'Use LF or CRLF record endings.');
        i++;
      }
      const error = character === ',' ? finishField() : finishRecord();
      if (error) return error;
      if (character === ',' && record.length >= USAGE_IMPORT_LIMITS.columns) return diagnostic('column_count', 'Every record must have exactly three columns.');
    } else if (state === 'closed') {
      return diagnostic('invalid_csv', 'A closing quote must be followed by a comma, record ending or end of file.');
    } else if (character === '"') {
      if (state !== 'start') return diagnostic('invalid_csv', 'Quotes must surround the entire field; escape a quote by doubling it.');
      state = 'quoted';
    } else { field += character; state = 'plain'; }
    // Bound accumulation before UTF-8 byte validation at the field boundary.
    if (field.length > USAGE_IMPORT_LIMITS.fieldBytes) return diagnostic('field_limit', 'A field exceeds 4,096 UTF-8 bytes.');
  }
  if (state === 'quoted') return diagnostic('invalid_csv', 'A quoted field was not closed.');
  if (pendingRecord) {
    const error = finishRecord();
    if (error) return error;
  }
  if (records[0].some((value, index) => value !== COLUMNS[index])) return failure('invalid_header', 'Use the exact header date,user_id,event in that order.', 1);
  if (records.length === 1) return failure('empty_dataset', 'The CSV contains a header but no data records.');
  const errors: UsageDiagnostic[] = [];
  const rows: UsageRow[] = [];
  const seen = new Set<string>();
  let duplicateRows = 0;
  for (let i = 1; i < records.length; i++) {
    const [date, userId, event] = records[i];
    const recordNumber = i + 1;
    const addError = (code: string, message: string, column: string) => {
      if (errors.length < USAGE_IMPORT_LIMITS.errors) errors.push({ code, message, column, record: recordNumber });
    };
    if (!validDate(date)) addError('invalid_date', 'Use a real UTC calendar date in YYYY-MM-DD format (years 0001–9999).', 'date');
    for (const [column, value, maxBytes] of [['user_id', userId, 256], ['event', event, 128]] as const) {
      if (!value || value !== value.trim() || CONTROLS.test(value) || Buffer.byteLength(value) > maxBytes) {
        addError('invalid_value', `Use a nonempty value without outer whitespace or control characters, at most ${maxBytes} UTF-8 bytes.`, column);
      }
    }
    const key = JSON.stringify([date, userId, event]);
    if (seen.has(key)) duplicateRows++; else seen.add(key);
    rows.push({ record: recordNumber, date, userId, event });
  }
  if (errors.length) return freeze({ ok: false, errors, warnings: [] });
  const contentHash = sha256(bytes);
  return freeze({
    ok: true,
    dataset: { id: `usage_${contentHash}`, contentHash, sourceName, bytes: bytesLength, schemaVersion: USAGE_SCHEMA_VERSION, rows, duplicatePolicy: 'keep-and-warn', duplicateRows },
    warnings: duplicateRows ? [{ code: 'duplicate_rows', count: duplicateRows, message: `${duplicateRows} repeated data record(s) retained. Without event IDs, identical rows may represent separate events; resolve accidental duplicate exports before relying on the report.` }] : [],
  });
}

export interface UsageEvidence {
  readonly sourceId: string;
  readonly contentHash: string;
  readonly schemaVersion: typeof USAGE_SCHEMA_VERSION;
  /** Exact CSV records used; not line numbers, and never model-generated citations. */
  readonly records: readonly number[];
  readonly columns: readonly string[];
}
export interface UsageMetric {
  readonly key: 'active_users' | 'events' | 'events_per_active_user';
  readonly label: string;
  readonly value: number | null;
  readonly unit: 'users' | 'events' | 'events/user';
  readonly definition: string;
  readonly evidence: UsageEvidence;
}
export interface WeeklyUsageReport {
  readonly version: typeof USAGE_METRICS_VERSION;
  readonly schemaVersion: typeof USAGE_SCHEMA_VERSION;
  readonly sourceName: string;
  readonly period: { readonly from: string; readonly through: string; readonly timezone: 'UTC' };
  readonly dataRange: { readonly firstDate: string; readonly lastDate: string };
  readonly recordsIncluded: number;
  readonly recordsExcluded: number;
  readonly duplicatePolicy: 'keep-and-warn';
  readonly duplicateRowsIncluded: number;
  readonly metrics: readonly UsageMetric[];
  readonly days: readonly { readonly date: string; readonly events: number; readonly activeUsers: number }[];
}

/**
 * Only imported snapshots should reach this pure calculation; storage/authentication
 * remain the caller's responsibility. The seven-day UTC interval is explicit and
 * inclusive. Count every record, preserve exact case-sensitive IDs, and return null
 * for a ratio whose denominator is zero. No model, arbitrary SQL or shell is used.
 */
export function calculateWeeklyUsage(dataset: UsageDataset, weekStart: string): WeeklyUsageReport {
  if (dataset.schemaVersion !== USAGE_SCHEMA_VERSION) throw new TypeError('Unsupported usage dataset schema.');
  if (!validDate(weekStart)) throw new RangeError('weekStart must be a real UTC date in YYYY-MM-DD format.');
  const start = Date.parse(`${weekStart}T00:00:00.000Z`);
  const end = new Date(start + 6 * DAY).toISOString();
  if (end.length !== 24) throw new RangeError('The full report period must fall within years 0001–9999.');
  const through = end.slice(0, 10);
  const selected = dataset.rows.filter(row => row.date >= weekStart && row.date <= through);
  const users = new Set(selected.map(row => row.userId));
  const records = selected.map(row => row.record);
  const evidence = (columns: readonly string[]): UsageEvidence => ({ sourceId: dataset.id, contentHash: dataset.contentHash, schemaVersion: dataset.schemaVersion, records, columns });
  const dates = dataset.rows.map(row => row.date).sort();
  const uniqueRows = new Set(selected.map(row => JSON.stringify([row.date, row.userId, row.event])));
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start + index * DAY).toISOString().slice(0, 10);
    const rows = selected.filter(row => row.date === date);
    return { date, events: rows.length, activeUsers: new Set(rows.map(row => row.userId)).size };
  });
  return freeze({
    version: USAGE_METRICS_VERSION, schemaVersion: dataset.schemaVersion, sourceName: dataset.sourceName,
    period: { from: weekStart, through, timezone: 'UTC' },
    dataRange: { firstDate: dates[0], lastDate: dates[dates.length - 1] },
    recordsIncluded: selected.length, recordsExcluded: dataset.rows.length - selected.length,
    duplicatePolicy: 'keep-and-warn', duplicateRowsIncluded: selected.length - uniqueRows.size,
    metrics: [
      { key: 'active_users', label: 'Active users', value: users.size, unit: 'users', definition: 'Distinct, case-sensitive user_id values with at least one event during this seven-day UTC period.', evidence: evidence(['date', 'user_id']) },
      { key: 'events', label: 'Events', value: selected.length, unit: 'events', definition: 'All data records during this seven-day UTC period, including repeated identical records.', evidence: evidence(['date', 'event']) },
      { key: 'events_per_active_user', label: 'Events per active user', value: users.size ? selected.length / users.size : null, unit: 'events/user', definition: 'Events divided by active users for this seven-day UTC period; null when there are no active users. No rounding is applied.', evidence: evidence(['date', 'user_id', 'event']) },
    ], days,
  });
}
