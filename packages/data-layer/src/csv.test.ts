import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from './csv.ts';
import { DataLayerError } from './errors.ts';

const code = (run: () => unknown): string => {
  try { run(); } catch (error) { return error instanceof DataLayerError ? error.code : `unexpected:${error}`; }
  return 'no-error';
};

test('quoted fields, doubled quotes, CRLF and a BOM parse into untyped string cells', () => {
  const parsed = parseCsv('\uFEFFname,note\r\nAda,"loves, commas"\r\nGrace,"said ""hi"""\r\n');
  assert.deepEqual(parsed.headers, ['name', 'note']);
  assert.deepEqual(parsed.rows, [['Ada', 'loves, commas'], ['Grace', 'said "hi"']]);
});

test('a quoted field may contain a newline without starting a new record', () => {
  const parsed = parseCsv('id,body\n1,"line one\nline two"\n2,plain\n');
  assert.deepEqual(parsed.rows, [['1', 'line one\nline two'], ['2', 'plain']]);
});

test('cells are preserved verbatim: no trimming, no typing and empty stays empty', () => {
  const parsed = parseCsv('a,b,c\n 1 ,,0\n');
  assert.deepEqual(parsed.rows, [[' 1 ', '', '0']]);
});

test('header labels keep their original characters but must be unique after trimming', () => {
  assert.deepEqual(parseCsv(' Name ,Value\nx,y\n').headers, [' Name ', 'Value'], 'the stored label keeps its original characters');
  assert.equal(code(() => parseCsv('a, a\n1,2\n')), 'duplicate_header', 'labels differing only by outer whitespace are ambiguous');
  assert.equal(code(() => parseCsv('a,\n1,2\n')), 'empty_header');
});

test('ambiguous or malformed CSV is refused with a located diagnostic', () => {
  assert.equal(code(() => parseCsv('a,b\n1\n')), 'column_count');
  assert.equal(code(() => parseCsv('a,b\n1,2\n\n')), 'blank_record');
  assert.equal(code(() => parseCsv('a\n"unclosed\n')), 'invalid_csv');
  assert.equal(code(() => parseCsv('a\n"closed"tail\n')), 'invalid_csv');
  assert.equal(code(() => parseCsv('a\rb\n')), 'invalid_newline');
  assert.equal(code(() => parseCsv('')), 'empty_file');
  try { parseCsv('a,b\n1\n'); } catch (error) {
    assert.deepEqual((error as DataLayerError).diagnostics[0], {
      code: 'column_count', message: 'Every CSV record must have the same number of fields as its header.', record: 2,
    });
  }
});

test('a header-only CSV is a valid empty snapshot rather than an error', () => {
  assert.deepEqual(parseCsv('a,b\n').rows, []);
});
