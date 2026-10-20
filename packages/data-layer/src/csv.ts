import { DataLayerError, type DataDiagnostic } from './errors.ts';

export const CSV_LIMITS = Object.freeze({ columns: 100, fieldBytes: 4096, rows: 10_000 });

export interface ParsedCsv {
  /** Header labels exactly as written; a BOM is removed from the first one only. */
  readonly headers: readonly string[];
  /** Every data record, in order. Cells stay strings: no trimming, typing or coercion. */
  readonly rows: readonly (readonly string[])[];
}

/**
 * Strict comma-delimited parsing: RFC-style quoted fields, doubled quotes, LF or CRLF
 * records and an optional leading BOM. Mirrors the rules the harness already applies to
 * uploaded files, including preserving original labels and rejecting ambiguous headers.
 */
export function parseCsv(content: string): ParsedCsv {
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const rows: string[][] = [];
  let headers: string[] | undefined;
  let record: string[] = [], field = '', touched = false;
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  const recordNumber = () => (headers ? rows.length + 2 : 1);
  // A function declaration (not an arrow) so the compiler treats every call as terminating.
  function stop(code: string, message: string, extra: Omit<DataDiagnostic, 'code' | 'message'> = {}): never {
    throw new DataLayerError(message, code, [{ code, message, record: recordNumber(), ...extra }]);
  }
  const finishField = () => {
    if (Buffer.byteLength(field) > CSV_LIMITS.fieldBytes) stop('field_limit', `A CSV field exceeds ${CSV_LIMITS.fieldBytes.toLocaleString('en-US')} UTF-8 bytes.`);
    if (record.length >= CSV_LIMITS.columns) stop('column_limit', `The CSV supports at most ${CSV_LIMITS.columns} columns.`);
    record.push(field); field = ''; state = 'start';
  };
  const finishRecord = () => {
    if (!touched) stop('blank_record', 'Remove blank CSV records; use a quoted empty field for an intentional empty value.');
    finishField();
    if (!headers) {
      // Trim only to detect ambiguity. The stored header keeps its original characters.
      const names = record.map(value => value.trim());
      if (names.some(value => !value)) stop('empty_header', 'Every CSV column needs a nonempty header.', { record: 1 });
      if (new Set(names).size !== names.length) stop('duplicate_header', 'CSV column headers must be unique after trimming outer whitespace.', { record: 1 });
      headers = record;
    } else {
      if (record.length !== headers.length) stop('column_count', 'Every CSV record must have the same number of fields as its header.');
      rows.push(record);
      if (rows.length > CSV_LIMITS.rows) stop('row_limit', `The CSV supports at most ${CSV_LIMITS.rows.toLocaleString('en-US')} data records.`, { record: rows.length + 1 });
    }
    record = []; touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (state === 'quoted') {
      if (character === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else state = 'closed';
      } else field += character;
    } else if (character === ',') {
      touched = true; finishField();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r') {
        if (text[i + 1] !== '\n') stop('invalid_newline', 'Use LF or CRLF CSV record endings.');
        i++;
      }
      finishRecord();
    } else if (state === 'closed') {
      stop('invalid_csv', 'A closing quote must be followed by a comma, a record ending or the end of the input.');
    } else if (character === '"') {
      if (state !== 'start') stop('invalid_csv', 'Quote the whole CSV field and escape a quote by doubling it.');
      touched = true; state = 'quoted';
    } else {
      touched = true; field += character; state = 'plain';
    }
    if (field.length > CSV_LIMITS.fieldBytes) stop('field_limit', `A CSV field exceeds ${CSV_LIMITS.fieldBytes.toLocaleString('en-US')} UTF-8 bytes.`);
  }
  if (state === 'quoted') stop('invalid_csv', 'A quoted CSV field was not closed.');
  if (touched) finishRecord();
  if (!headers) stop('empty_file', 'The CSV needs a header record.');
  return { headers, rows };
}
