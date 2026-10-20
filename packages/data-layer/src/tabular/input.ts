import { refuse } from '../errors.ts';
import { canonicalJson, sha256 } from '../hash.ts';

export const TABULAR_LIMITS = Object.freeze({ bytes: 1_048_576, rows: 5_000, columns: 64, fieldBytes: 4096 });

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function contentHash(value: unknown): string { return sha256(canonicalJson(value)); }

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    refuse('invalid_schema', `${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

export function allowedKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !keys.includes(key));
  if (unknown) refuse('invalid_schema', `${label} contains an unsupported field: ${unknown}.`, { field: unknown });
}

/** Strict bounded RFC-style CSV. Empty physical records are ignored, with line numbers retained. */
export function parseBoundedCsv(content: string): { headers: string[]; rows: { cells: string[]; record: number; line: number }[] } {
  if (typeof content !== 'string') refuse('invalid_csv', 'CSV content must be a UTF-8 string.');
  if (Buffer.byteLength(content, 'utf8') > TABULAR_LIMITS.bytes) refuse('file_limit', 'The CSV exceeds the 1 MiB import limit.');
  // In Unicode mode valid surrogate pairs are one code point outside this range.
  if (/[\uD800-\uDFFF]/u.test(content) || content.includes('\0')) refuse('invalid_csv', 'CSV content must contain valid Unicode text without null bytes.');
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;
  let headers: string[] | undefined;
  const rows: { cells: string[]; record: number; line: number }[] = [];
  let fields: string[] = [], field = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let line = 1, startLine = 1, touched = false, structured = false;
  const record = () => headers ? rows.length + 2 : 1;
  function fail(code: string, message: string): never { return refuse(code, message, { record: record() }); }
  function finishField(): void {
    if (Buffer.byteLength(field, 'utf8') > TABULAR_LIMITS.fieldBytes) fail('field_limit', 'A CSV cell exceeds 4096 UTF-8 bytes.');
    if (fields.length >= TABULAR_LIMITS.columns) fail('column_limit', 'The CSV supports at most 64 columns.');
    fields.push(field); field = ''; state = 'start';
  }
  function finishRecord(): void {
    if (touched && (structured || field.trim() !== '')) {
      finishField();
      if (!headers) {
        const names = fields.map(value => value.trim());
        if (names.some(name => !name)) fail('empty_header', 'Every CSV column needs a nonempty header.');
        if (new Set(names).size !== names.length) fail('duplicate_header', 'CSV headers must be unique after trimming outer whitespace.');
        headers = fields;
      } else {
        if (fields.length !== headers.length) fail('column_count', 'Each CSV record must have the same number of cells as its header.');
        if (rows.length >= TABULAR_LIMITS.rows) fail('row_limit', 'The CSV supports at most 5000 data rows.');
        rows.push({ cells: fields, record: record(), line: startLine });
      }
    }
    fields = []; field = ''; state = 'start'; touched = false; structured = false;
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (state === 'quoted') {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; } else state = 'closed';
      } else {
        field += char;
        if (char === '\n') line++;
      }
    } else if (char === ',') {
      touched = structured = true; finishField();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r') {
        if (text[index + 1] !== '\n') fail('invalid_newline', 'Use LF or CRLF CSV record endings.');
        index++;
      }
      finishRecord(); line++; startLine = line;
    } else if (state === 'closed') {
      fail('invalid_csv', 'A closing quote must be followed by a comma or a record ending.');
    } else if (char === '"') {
      if (state !== 'start') fail('invalid_csv', 'Quote the entire CSV cell and double embedded quotes.');
      touched = structured = true; state = 'quoted';
    } else {
      field += char; touched = true; state = 'plain';
    }
    if (field.length > TABULAR_LIMITS.fieldBytes) fail('field_limit', 'A CSV cell exceeds 4096 UTF-8 bytes.');
  }
  if (state === 'quoted') fail('invalid_csv', 'A quoted CSV cell was not closed.');
  if (touched) finishRecord();
  if (!headers) fail('empty_file', 'The CSV needs a header record.');
  return { headers, rows };
}

/** ISO only, including real calendar validation; no host-dependent Date.parse guessing. */
export function parseDate(value: string, allowUtc: boolean, field: string, record?: number): { iso: string; assumedUtc: boolean } {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  const fail = (): never => refuse('invalid_date', `${field} must be a real ISO date/time with an offset, or an ISO date/time interpreted using a confirmed UTC timezone.`, { field, ...(record === undefined ? {} : { record }) });
  if (!match) return fail();
  const [, ys, ms, ds, hs, mins, ss, fraction, zone] = match;
  const [year, month, day, hour, minute, second] = [ys, ms, ds, hs ?? '0', mins ?? '0', ss ?? '0'].map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number((fraction ?? '.0').slice(1).padEnd(3, '0')));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return fail();
  if (!zone && !allowUtc) return fail();
  if (zone && zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3)), offsetMinutes = Number(zone.slice(4));
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) return fail();
    const offset = (offsetHours * 60 + offsetMinutes) * (zone[0] === '+' ? 1 : -1);
    date.setTime(date.getTime() - offset * 60_000);
  }
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) return fail();
  return { iso: date.toISOString(), assumedUtc: !zone };
}
