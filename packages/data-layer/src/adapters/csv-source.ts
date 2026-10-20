import { parseCsv } from '../csv.ts';
import { refuse } from '../errors.ts';
import type { RawCoverage, RawRecord, RawFetch, SourceAdapter } from '../types.ts';

export const CSV_SOURCE_LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024 });

/** A label, never a path: a source name must not imply a location on disk. */
const UNSAFE_NAME = /[/\\:<>"|?*\u0000-\u001f\u007f]/u;

export interface CsvSourceInput {
  /** File name, used for provenance and the human label. */
  readonly name: string;
  /** The exact UTF-8 text, including any BOM and its original line endings. */
  readonly content: string;
  readonly declaredCoverage?: RawCoverage;
}

/**
 * A delimiter-separated upload: a complete snapshot with no position to resume from,
 * so `cursorAfter` is always null and identity comes from the content hash. Cells stay
 * strings, an empty cell stays `''`, and nothing is typed or interpreted here.
 */
export const csvSourceAdapter: SourceAdapter<CsvSourceInput> = {
  id: 'csv-upload',
  format: 'csv',
  read(input, _context): RawFetch {
    if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('invalid_csv_input', 'Provide a CSV upload as { name, content }.');
    const { name, content } = input;
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 240 || UNSAFE_NAME.test(name)) {
      refuse('invalid_source_name', 'Use a plain file name of at most 240 characters without control characters or path separators.');
    }
    if (typeof content !== 'string') refuse('invalid_csv_content', 'Provide the CSV as UTF-8 text.');
    if (!content.trim()) refuse('empty_file', 'The CSV is empty.');
    if (Buffer.byteLength(content) > CSV_SOURCE_LIMITS.bytes) {
      refuse('byte_limit', `The CSV must be at most ${CSV_SOURCE_LIMITS.bytes / (1024 * 1024)} MiB.`);
    }
    // A NUL byte usually means a binary or mis-decoded file, not a delimited text export.
    if (content.includes('\u0000')) refuse('binary_content', 'The upload contains a NUL byte; provide a UTF-8 delimited text file.');
    const { headers, rows } = parseCsv(content);
    const records: RawRecord[] = rows.map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
    return {
      payload: content,
      payloadEncoding: 'original',
      records,
      format: 'csv',
      columns: [...headers],
      cursorAfter: null,
      provenance: { kind: 'upload', label: `CSV upload (${name})`, locator: name, declaredCoverage: input.declaredCoverage ?? 'unknown' },
    };
  },
};
