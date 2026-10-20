import { createHash } from 'node:crypto';
import { HarnessError } from './errors.ts';
import type { SourceDocument } from './types.ts';

export const FILE_IMPORT_VERSION = 'workspace-file/v1' as const;
/** Match sources.ts's existing per-source bound; larger uploads need a separate extraction path. */
export const FILE_IMPORT_LIMITS = Object.freeze({ bytes: 64 * 1024, nameBytes: 240, rows: 10_000, columns: 100, fieldBytes: 4096, previewCharacters: 2000, previewRows: 10 });

export interface CsvFilePreview {
  /** Original header values, without normalization or type inference. */
  readonly headers: readonly string[];
  /** Data records only; quoted newlines do not start another record. */
  readonly rowCount: number;
  readonly columnCount: number;
  /** First ten data records, with every cell preserved as a literal string. */
  readonly rows: readonly (readonly string[])[];
  readonly rowsTruncated: boolean;
}
export interface ImportedWorkspaceFile {
  readonly schemaVersion: typeof FILE_IMPORT_VERSION;
  /** SHA-256 of the exact original UTF-8 bytes, including BOM and line endings. */
  readonly contentHash: string;
  readonly name: string;
  readonly kind: 'csv' | 'text' | 'markdown';
  readonly bytes: number;
  /** Full original content; never a generated description or silently shortened excerpt. */
  readonly source: Readonly<SourceDocument>;
  readonly preview: {
    readonly text: string;
    readonly textTruncated: boolean;
    readonly totalCharacters: number;
    readonly csv?: CsvFilePreview;
  };
  readonly warnings: readonly string[];
}

const CONTENT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const INVALID_NAME = /[\/\\:<>"|?*\p{Cc}\p{Cf}]/u;
const unpairedSurrogate = (value: string) => /[\ud800-\udfff]/u.test(value);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const invalid = (code: string, message: string, record?: number): never => {
  throw new HarnessError(`${message}${record === undefined ? '' : ` Record ${record}.`}`, 422, `file_${code}`);
};
const limit = (code: string, message: string, record?: number): never => {
  throw new HarnessError(`${message}${record === undefined ? '' : ` Record ${record}.`}`, 413, `file_${code}`);
};

/** Comma-delimited RFC-style quoted fields, escaped quotes, LF/CRLF records and an optional initial BOM. */
function inspectCsv(content: string): CsvFilePreview {
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;
  let headers: string[] | undefined;
  const rows: string[][] = [];
  let rowCount = 0, record: string[] = [], field = '', touched = false;
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  const recordNumber = () => headers ? rowCount + 2 : 1;
  const finishField = () => {
    if (Buffer.byteLength(field) > FILE_IMPORT_LIMITS.fieldBytes) limit('field_limit', 'A CSV field exceeds 4,096 UTF-8 bytes.', recordNumber());
    if (record.length >= FILE_IMPORT_LIMITS.columns) limit('column_limit', 'The CSV supports at most 100 columns.', recordNumber());
    record.push(field); field = ''; state = 'start';
  };
  const finishRecord = () => {
    if (!touched) invalid('blank_record', 'Remove blank CSV records; use quoted empty fields for intentional empty values.', recordNumber());
    finishField();
    if (!headers) {
      // Trimming is for ambiguity checks only. Preserve the original labels and bytes.
      const names = record.map(value => value.trim());
      if (names.some(value => !value)) invalid('empty_header', 'Every CSV column needs a nonempty header.', 1);
      if (new Set(names).size !== names.length) invalid('duplicate_header', 'CSV column headers must be unique after trimming outer whitespace.', 1);
      headers = record;
    } else {
      if (record.length !== headers.length) invalid('column_count', 'Every CSV record must have the same number of fields as its header.', recordNumber());
      rowCount++;
      if (rowCount > FILE_IMPORT_LIMITS.rows) limit('row_limit', 'The CSV supports at most 10,000 data records.', rowCount + 1);
      if (rows.length < FILE_IMPORT_LIMITS.previewRows) rows.push(record);
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
        if (text[i + 1] !== '\n') invalid('invalid_newline', 'Use LF or CRLF CSV record endings.', recordNumber());
        i++;
      }
      finishRecord();
    } else if (state === 'closed') {
      invalid('invalid_csv', 'A closing quote must be followed by a comma, record ending or end of file.', recordNumber());
    } else if (character === '"') {
      if (state !== 'start') invalid('invalid_csv', 'Quote the whole CSV field and escape quotes by doubling them.', recordNumber());
      touched = true; state = 'quoted';
    } else {
      touched = true; field += character; state = 'plain';
    }
    // Bound accumulation before validating UTF-8 byte width at the field boundary.
    if (field.length > FILE_IMPORT_LIMITS.fieldBytes) limit('field_limit', 'A CSV field exceeds 4,096 UTF-8 bytes.', recordNumber());
  }
  if (state === 'quoted') invalid('invalid_csv', 'A quoted CSV field was not closed.', recordNumber());
  if (touched) finishRecord();
  if (!headers) return invalid('empty_file', 'The CSV needs a header.');
  return { headers, rowCount, columnCount: headers.length, rows, rowsTruncated: rowCount > rows.length };
}

/**
 * Pure validation and preview only: no file writes, execution, formulas, metrics,
 * instruction following, or model calls. The caller must authorize and persist it.
 * Each exact (filename, original bytes, import version) identifies one snapshot;
 * uploading identical bytes under another name deliberately creates another source.
 */
export function importWorkspaceFile(input: { name: string; content: string | Uint8Array }): ImportedWorkspaceFile {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name','content'].includes(key))) {
    throw new HarnessError('Provide a file name and UTF-8 content.', 400, 'invalid_file_input');
  }
  const { name, content } = input;
  if (typeof name !== 'string' || !name || name !== name.trim() || name.startsWith('.') || name.endsWith('.') ||
      INVALID_NAME.test(name) || unpairedSurrogate(name) || Buffer.byteLength(name) > FILE_IMPORT_LIMITS.nameBytes) {
    throw new HarnessError('Use a plain file name of at most 240 UTF-8 bytes without paths or control characters.', 400, 'invalid_file_name');
  }
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (!name.includes('.') || !['csv','txt','md'].includes(extension)) {
    throw new HarnessError('Upload a CSV, text (.txt), or Markdown (.md) file. Other formats need a dedicated extractor.', 415, 'unsupported_file_type');
  }
  if (!(typeof content === 'string' || content instanceof Uint8Array)) throw new HarnessError('Provide UTF-8 text or bytes.', 400, 'invalid_file_input');
  if (typeof content === 'string' && unpairedSurrogate(content)) invalid('invalid_utf8', 'The file contains an unpaired Unicode surrogate.');
  const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
  if (bytes > FILE_IMPORT_LIMITS.bytes) limit('byte_limit', 'Each file must be at most 64 KiB in this first version.');
  const original = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  let text: string;
  // ignoreBOM=true retains the BOM as content so round-tripping recovers the exact bytes.
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original); }
  catch { return invalid('invalid_utf8', 'The file must contain valid UTF-8.'); }
  if (CONTENT_CONTROLS.test(text)) invalid('control_character', 'The file contains a control character; only tabs and line endings are allowed.');
  if (!text.trim()) invalid('empty_file', 'Choose a file with content.');
  const kind = extension === 'csv' ? 'csv' : extension === 'md' ? 'markdown' : 'text';
  const csv = kind === 'csv' ? inspectCsv(text) : undefined;
  const contentHash = hash(original);
  const identity = hash(JSON.stringify([FILE_IMPORT_VERSION, name, contentHash]));
  const characters = [...text];
  return freeze({
    schemaVersion: FILE_IMPORT_VERSION, contentHash, name, kind, bytes,
    source: { id: `source_${identity}`, title: name, path: `uploads/${identity}/${name}`, bytes, content: text },
    preview: { text: characters.slice(0, FILE_IMPORT_LIMITS.previewCharacters).join(''), textTruncated: characters.length > FILE_IMPORT_LIMITS.previewCharacters, totalCharacters: characters.length, ...(csv ? { csv } : {}) },
    warnings: csv?.rowCount === 0 ? ['This CSV contains column headers but no data records.'] : [],
  });
}
