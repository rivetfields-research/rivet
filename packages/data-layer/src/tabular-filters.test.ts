import test from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerError } from './errors.ts';
import { analyzeDataset, normalizeCsv, validateAnalysisRequest, type AnalysisRequest, type CsvMapping } from './tabular/index.ts';
import { contentHash } from './tabular/input.ts';

const csv = 'id,date,type,likes,comments,shares,impressions\n'
  + 'p1,2026-09-21,photo,10,2,1,100\n'
  + 'p2,2026-09-22,video,90,5,5,500\n'
  + 'p3,2026-09-23,photo,20,,1,200\n'
  + 'p4,2026-09-24,,50,4,1,250\n'
  + 'p5,2026-09-20,video,100,10,10,1000\n'
  + 'p6,,photo,30,3,2,300\n'
  + 'p7,2026-09-25,photo,0,0,0,0\n'
  + 'p8,2026-09-26,Photo,40,4,1,400\n'
  + 'p9,2026-09-27,photo,5,0,0,50\n';
const mapping: CsvMapping = {
  confirmed: true, platform: 'instagram', account: 'Fictional filter test', timezone: 'UTC',
  columns: { postId: 'id', publishedAt: 'date', contentType: 'type', likes: 'likes', comments: 'comments', shares: 'shares', impressions: 'impressions' },
};
const dataset = normalizeCsv(csv, mapping);
const request: AnalysisRequest = {
  metrics: ['likes', 'comments', 'shares', 'impressions', 'interactions', 'engagementRate', 'postCount'],
  groupBy: 'day', chart: 'table', timezone: 'UTC', dateRange: { from: '2026-09-21', to: '2026-09-28' },
};
function refuses(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof DataLayerError && error.code === code);
}

test('date eligibility precedes exact type filtering and every source row has one partition', () => {
  const result = analyzeDataset(dataset, { ...request, contentTypes: ['photo'] });
  assert.deepEqual(result.rows.map(row => row.group), ['2026-09-21', '2026-09-23', '2026-09-25', '2026-09-27']);
  assert.deepEqual(result.totals, { likes: 35, comments: 2, shares: 2, impressions: 350, interactions: 18, engagementRate: 12, postCount: 4 });
  assert.deepEqual(result.counts, { inputRows: 9, includedRows: 4, excludedByDate: 1, excludedUndated: 1, excludedByContentType: 3 });
  assert.deepEqual(result.evidence.totals.postCount!.eligible.map(ref => ref.record), [2, 4, 8, 10]);
  assert.deepEqual(result.evidence.excludedByDate.map(ref => ref.record), [6]);
  assert.deepEqual(result.evidence.excludedUndated.map(ref => ref.record), [7]);
  assert.deepEqual(result.evidence.excludedByContentType!.map(ref => ref.record), [3, 5, 9]);
  const partitions = [result.evidence.totals.postCount!.eligible, result.evidence.excludedByDate, result.evidence.excludedUndated, result.evidence.excludedByContentType!];
  const refs = partitions.flat();
  assert.equal(new Set(refs.map(ref => ref.rowId)).size, dataset.rows.length);
  assert.equal(refs.length, dataset.rows.length);
  for (const ref of refs) assert.deepEqual(ref, dataset.rows.find(row => row.id === ref.rowId)!.provenance);
});

test('filtered rate recomputes a ratio of sums over matching complete positive-denominator rows', () => {
  const result = analyzeDataset(dataset, { ...request, contentTypes: ['photo'] });
  assert.equal(result.totals.engagementRate, (13 + 5) / (100 + 50) * 100);
  assert.notEqual(result.totals.engagementRate, (13 + 10) / 2);
  assert.deepEqual(result.metricCoverage.engagementRate, { totalRows: 4, eligibleRows: 2, missingRows: 1, zeroDenominatorRows: 1 });
  const evidence = result.evidence.totals.engagementRate!;
  assert.deepEqual(evidence.eligible.map(ref => ref.record), [2, 10]);
  assert.deepEqual(evidence.missing.map(ref => ref.record), [4]);
  assert.deepEqual(evidence.excluded.map(ref => ref.record), [8]);
  assert.equal(evidence.formula, analyzeDataset(dataset, request).evidence.totals.engagementRate!.formula);
});

test('filters are exact normalized values, preserving case and refusing whitespace or aliases', () => {
  const result = analyzeDataset(dataset, { ...request, contentTypes: ['Photo'] });
  assert.equal(result.totals.likes, 40);
  assert.deepEqual(result.evidence.totals.postCount!.eligible.map(ref => ref.record), [9]);
  for (const value of ['PHOTO', ' photo', 'photo ', 'reel', '(missing content type)']) {
    refuses(() => analyzeDataset(dataset, { ...request, contentTypes: [value] }), 'unknown_content_type');
  }
});

test('filter values are checked against the complete dataset, not just the requested period', () => {
  const result = analyzeDataset(dataset, { ...request, contentTypes: ['video'], dateRange: { from: '2026-09-23', to: '2026-09-28' } });
  assert.deepEqual(result.rows, []);
  assert.equal(result.totals.likes, null);
  assert.equal(result.totals.postCount, 0);
  assert.deepEqual(result.counts, { inputRows: 9, includedRows: 0, excludedByDate: 3, excludedUndated: 1, excludedByContentType: 5 });
  assert.match(result.warnings.find(warning => warning.code === 'empty_cohort')!.message, /content types and publication period/);
});

test('unmapped content type refuses a filter instead of reporting an empty cohort', () => {
  const { contentType: _contentType, ...columns } = mapping.columns;
  const unmapped = normalizeCsv(csv, { ...mapping, columns });
  refuses(() => analyzeDataset(unmapped, { ...request, contentTypes: ['photo'] }), 'unmapped_content_type');
  assert.equal(analyzeDataset(unmapped, request).counts.includedRows, 7);
});

test('missing content types remain missing, and a literal missing-label string only selects that literal', () => {
  const source = normalizeCsv('id,type,likes\np1,,5\np2,(missing content type),7', {
    confirmed: true, platform: 'facebook', account: 'Synthetic', columns: { postId: 'id', contentType: 'type', likes: 'likes' },
  });
  const result = analyzeDataset(source, { metrics: ['likes', 'postCount'], groupBy: 'contentType', chart: 'table', contentTypes: ['(missing content type)'] });
  assert.deepEqual(result.totals, { likes: 7, postCount: 1 });
  assert.deepEqual(result.evidence.excludedByContentType!.map(ref => ref.record), [2]);
  const onlyMissing = normalizeCsv('id,type,likes\np1,,5', source.mapping);
  refuses(() => analyzeDataset(onlyMissing, { ...result.request, contentTypes: ['photo'] }), 'unknown_content_type');
});

test('invalid filter shapes, controls, duplicate values and unbounded arrays fail explicitly', () => {
  const bad: unknown[] = [null, 'photo', {}, [], [''], [null], [1], [undefined], Array(1), ['photo', 'photo'], ['a'.repeat(257)],
    Array.from({ length: 21 }, (_, i) => `type-${i}`), ['photo\n'], ['photo\t'], ['photo\u0000'], ['photo\u007f'], ['photo\u0085']];
  for (const contentTypes of bad) {
    refuses(() => validateAnalysisRequest({ ...request, contentTypes } as AnalysisRequest), 'invalid_content_types');
  }
  const values = Array.from({ length: 20 }, (_, i) => i === 0 ? 'x'.repeat(256) : `type-${i}`);
  assert.deepEqual(validateAnalysisRequest({ ...request, contentTypes: values }).contentTypes, [...values].sort());
});

test('equivalent filter sets have identical request, result and hash without mutating caller input', () => {
  const contentTypes = ['video', 'photo'];
  const first = analyzeDataset(dataset, { ...request, contentTypes });
  const second = analyzeDataset(dataset, { ...request, contentTypes: ['photo', 'video'] });
  assert.deepEqual(first.request.contentTypes, ['photo', 'video']);
  assert.deepEqual(first, second);
  assert.deepEqual(contentTypes, ['video', 'photo']);
  assert.ok(Object.isFrozen(first.request.contentTypes));
});

test('no-filter output keeps the pre-filter shape and calculation apart from the readable heading', () => {
  const result = analyzeDataset(dataset, request);
  assert.equal(result.hash, 'd581e28048cfb09c893ebd1bfa51e8f45c7f6930ec69fbbac554301ee9472909');
  const { id: _id, hash: _hash, ...body } = result;
  assert.equal(contentHash({ ...body, columns: [{ ...body.columns[0], label: 'day' }, ...body.columns.slice(1)] }), '0c796af7f57dfb977622687351478671f9d37f5ab0e3357583d1a9ad872bd0fd');
  assert.equal(Object.hasOwn(result.request, 'contentTypes'), false);
  assert.equal(Object.hasOwn(result.counts, 'excludedByContentType'), false);
  assert.equal(Object.hasOwn(result.evidence, 'excludedByContentType'), false);
  assert.deepEqual(result, analyzeDataset(dataset, { ...request, contentTypes: undefined }));
});

test('filtering keeps the immutable dataset, raw source cells and missing numeric values intact', () => {
  const before = JSON.stringify(dataset);
  const result = analyzeDataset(dataset, { ...request, contentTypes: ['photo'] });
  assert.equal(JSON.stringify(dataset), before);
  assert.equal(dataset.rows[2].rawCells[4], '');
  assert.equal(dataset.rows[2].metrics.comments, null);
  assert.equal(dataset.rows[3].contentType, null);
  assert.equal(result.rows.find(row => row.group === '2026-09-23')!.comments, null);
  assert.equal(result.rows.find(row => row.group === '2026-09-25')!.comments, 0);
});

test('undated rows remain eligible for an undated grouping when their exact type matches', () => {
  const result = analyzeDataset(dataset, { metrics: ['likes'], groupBy: 'contentType', chart: 'bar', contentTypes: ['photo'] });
  assert.deepEqual(result.rows, [{ group: 'photo', likes: 65 }]);
  assert.equal(result.counts.excludedUndated, 0);
  assert.equal(result.counts.includedRows, 5);
});

test('filter support does not allow SQL, code or additional filter fields', () => {
  for (const extra of [{ sql: 'SELECT * FROM posts' }, { code: 'return rows' }, { filters: { contentType: 'photo' } }]) {
    refuses(() => analyzeDataset(dataset, { ...request, contentTypes: ['photo'], ...extra } as AnalysisRequest), 'invalid_schema');
  }
  refuses(() => validateAnalysisRequest({ ...request, contentTypes: { sql: 'photo' } } as unknown as AnalysisRequest), 'invalid_content_types');
  refuses(() => analyzeDataset(dataset, { ...request, contentTypes: ['SELECT * FROM posts'] }), 'unknown_content_type');
});
