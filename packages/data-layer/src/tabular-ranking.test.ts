import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDataset, exportAnalysisCsv, normalizeCsv, validateAnalysisRequest, type AnalysisRequest, type CsvMapping } from './tabular/index.ts';

const csv = 'id,date,type,likes,reactions,comments,shares,impressions\n'
  + 'z,2026-09-21,video,1,20,2,3,100\n'
  + 'a,2026-09-22,photo,7,20,2,3,50\n'
  + 'missing,2026-09-23,video,5,,1,1,100\n'
  + 'zero,2026-09-24,video,0,0,0,0,0\n'
  + 'b,2026-09-25,photo,1,20,2,3,100\n'
  + 't,2026-09-26,video,,10,,1,100\n';
const mapping: CsvMapping = { confirmed: true, platform: 'linkedin', account: 'Synthetic company', timezone: 'UTC', columns: {
  postId: 'id', publishedAt: 'date', contentType: 'type', likes: 'likes', reactions: 'reactions', comments: 'comments', shares: 'shares', impressions: 'impressions',
} };
const dataset = normalizeCsv(csv, mapping);
const request: AnalysisRequest = { metrics: ['reactions', 'postCount'], groupBy: 'post', chart: 'bar' };
const ids = (result: ReturnType<typeof analyzeDataset>) => result.rows.map(row => JSON.parse(row.group)[2]);

test('top groups are ranked over the full cohort with stable ties, null last and exact retained evidence', () => {
  const full = analyzeDataset(dataset, request);
  const top = analyzeDataset(dataset, { ...request, sort: { metric: 'reactions', direction: 'desc' }, limit: 2 });
  assert.deepEqual(ids(top), ['a', 'b'], 'ties use group identity, not input order or a made-up second metric');
  assert.deepEqual(top.rows.map(row => row.reactions), [20, 20]);
  assert.deepEqual(top.selection, { totalGroups: 6, returnedGroups: 2, omittedGroups: 4, totalsScope: 'full_cohort', evidenceScope: 'full_cohort', tieBreak: 'group_ascending', missingValues: 'last' });
  assert.deepEqual(top.totals, { reactions: 70, postCount: 6 }, '70 is the full cohort total, not 40 from the displayed groups');
  assert.deepEqual(top.metricCoverage, full.metricCoverage);
  assert.deepEqual(top.counts, full.counts);
  assert.deepEqual(top.evidence, full.evidence, 'all group and total row references survive selection');
  for (const row of top.rows) {
    const evidence = top.evidence.groups.find(group => group.group === row.group)!;
    const post = JSON.parse(row.group)[2];
    assert.deepEqual(evidence.metrics.reactions!.eligible, [dataset.rows.find(row => row.postId === post)!.provenance]);
  }
  assert.equal(top.evidence.groups.length, 6);
  const exported = exportAnalysisCsv(top);
  assert.equal(exported.trim().split('\r\n').length, 3, 'CSV contains a header and the two selected groups only');
  assert.doesNotMatch(exported, /Total|missing|zero|,70/);
  assert.equal(top.id, analyzeDataset(JSON.parse(JSON.stringify(dataset)), JSON.parse(JSON.stringify(top.request))).id);
  assert.notEqual(top.id, full.id);
  assert.ok(Object.isFrozen(top.selection));
});

test('ascending, descending and all-missing metric sorts have deterministic missing-last behavior', () => {
  assert.deepEqual(ids(analyzeDataset(dataset, { ...request, sort: { metric: 'reactions', direction: 'desc' } })), ['a', 'b', 'z', 't', 'zero', 'missing']);
  assert.deepEqual(ids(analyzeDataset(dataset, { ...request, sort: { metric: 'reactions', direction: 'asc' } })), ['zero', 't', 'a', 'b', 'z', 'missing']);
  for (const direction of ['asc', 'desc'] as const) {
    const result = analyzeDataset(dataset, { ...request, metrics: ['clicks'], sort: { metric: 'clicks', direction }, limit: 100 });
    assert.deepEqual(ids(result), ['a', 'b', 'missing', 't', 'z', 'zero']);
    assert.ok(result.rows.every(row => row.clicks === null));
    assert.equal(result.totals.clicks, null);
    assert.equal(result.selection?.omittedGroups, 0);
  }
});

test('ranking follows date and content filters without deleting excluded-row evidence', () => {
  const scoped = { ...request, contentTypes: ['video'], dateRange: { from: '2026-09-22', to: '2026-09-26' } };
  const full = analyzeDataset(dataset, scoped);
  const top = analyzeDataset(dataset, { ...scoped, sort: { metric: 'reactions', direction: 'desc' }, limit: 1 });
  assert.deepEqual(ids(top), ['zero']);
  assert.deepEqual(top.counts, { inputRows: 6, includedRows: 2, excludedByDate: 2, excludedUndated: 0, excludedByContentType: 2 });
  assert.deepEqual(top.evidence, full.evidence);
  assert.deepEqual(top.evidence.totals.reactions!.missing.map(row => row.record), [4]);
  assert.equal(top.metricCoverage.reactions!.missingRows, 1);
  const empty = analyzeDataset(dataset, { ...request, sort: { metric: 'reactions', direction: 'desc' }, limit: 1, dateRange: { from: '2030-01-01' } });
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.totals, { reactions: null, postCount: 0 });
  assert.equal(empty.selection?.totalGroups, 0);
  assert.equal(empty.selection?.returnedGroups, 0);
});

test('ranking arguments are bounded typed values, and omission preserves the old unranked shape', () => {
  for (const sort of [null, [], {}, { metric: 'reactions' }, { metric: 'likes', direction: 'desc' }, { metric: 'reactions', direction: 'DESC' }, { metric: 'reactions', direction: 'desc', sql: 'SELECT 999' }]) {
    assert.throws(() => validateAnalysisRequest({ ...request, sort } as AnalysisRequest));
  }
  for (const limit of [null, 0, -1, 1.5, 101, '5', NaN, Infinity]) {
    assert.throws(() => validateAnalysisRequest({ ...request, sort: { metric: 'reactions', direction: 'desc' }, limit } as AnalysisRequest));
  }
  assert.throws(() => validateAnalysisRequest({ ...request, limit: 5 }), /explicit metric sort/);
  const result = analyzeDataset(dataset, request);
  for (const name of ['sort', 'limit']) assert.equal(Object.hasOwn(result.request, name), false);
  assert.equal(Object.hasOwn(result, 'selection'), false);
  assert.equal(result.id, analyzeDataset(dataset, { ...request, sort: undefined, limit: undefined }).id);
  assert.equal(dataset.id, normalizeCsv(csv, mapping).id, 'ranking adds no normalized row fields or new mapping semantics');
});

test('reaction formulas use one eligible cohort and remain distinct from the existing likes formulas', () => {
  const result = analyzeDataset(dataset, { metrics: ['reactions', 'reactionInteractions', 'reactionEngagementRate', 'interactions', 'engagementRate'], groupBy: 'platform', chart: 'table' });
  assert.deepEqual(result.totals, { reactions: 70, reactionInteractions: 75, reactionEngagementRate: 30, interactions: 31, engagementRate: 31 / 350 * 100 });
  assert.deepEqual(result.metricCoverage.reactionInteractions, { totalRows: 6, eligibleRows: 4, missingRows: 2, zeroDenominatorRows: 0 });
  assert.deepEqual(result.metricCoverage.reactionEngagementRate, { totalRows: 6, eligibleRows: 3, missingRows: 2, zeroDenominatorRows: 1 });
  const evidence = result.evidence.totals.reactionEngagementRate!;
  assert.deepEqual(evidence.eligible.map(row => row.record), [2, 3, 6]);
  assert.deepEqual(evidence.missing.map(row => row.record), [4, 7]);
  assert.deepEqual(evidence.excluded.map(row => row.record), [5]);
  assert.match(evidence.formula, /reactions \+ comments \+ shares/);
  assert.doesNotMatch(evidence.formula, /likes|clicks|votes/);
  assert.equal(result.definitions.find(metric => metric.id === 'reactionEngagementRate')!.unit, 'percent');
  assert.equal(result.definitions.find(metric => metric.id === 'reactionEngagementRate')!.aggregation, 'ratio_of_sums');
  const ranked = analyzeDataset(dataset, { metrics: ['reactionEngagementRate'], groupBy: 'post', chart: 'bar', sort: { metric: 'reactionEngagementRate', direction: 'desc' }, limit: 3 });
  assert.deepEqual(ids(ranked), ['a', 'b', 'z']);
  assert.deepEqual(ranked.rows.map(row => row.reactionEngagementRate), [50, 25, 25]);
  assert.equal(ranked.totals.reactionEngagementRate, 30, 'cohort rate is not the mean of displayed post rates');
});

test('reaction formulas never substitute likes and refuse unsafe sums', () => {
  const reactionOnly = normalizeCsv('id,r,c,s,i\na,10,2,3,100\nb,0,0,0,0\nc,,1,1,100', { confirmed: true, platform: 'linkedin', account: 'a', columns: { postId: 'id', reactions: 'r', comments: 'c', shares: 's', impressions: 'i' } });
  const result = analyzeDataset(reactionOnly, { metrics: ['reactionInteractions', 'reactionEngagementRate', 'interactions', 'engagementRate'], groupBy: 'platform', chart: 'table' });
  assert.deepEqual(result.totals, { reactionInteractions: 15, reactionEngagementRate: 15, interactions: null, engagementRate: null });
  const unsafe = normalizeCsv('id,r,c,s,i\na,9007199254740991,1,0,100', { confirmed: true, platform: 'linkedin', account: 'a', columns: { postId: 'id', reactions: 'r', comments: 'c', shares: 's', impressions: 'i' } });
  assert.throws(() => analyzeDataset(unsafe, { metrics: ['reactionInteractions'], groupBy: 'post', chart: 'table' }), /exact integer range/);
});
