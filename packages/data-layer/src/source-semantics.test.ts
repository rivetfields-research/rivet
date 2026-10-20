import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRawStore } from './store.ts';
import { runSync } from './sync.ts';
import { metaGraphAdapter } from './adapters/meta-graph.ts';
import { youtubeSourceAdapter } from './adapters/youtube.ts';
import { mailchimpTable, analyticsTable } from './adapters/provider-table.ts';
import { createSourceSemantics, analyzeSources, validateSourceAnalysis, SOURCE_METRICS } from './source-semantics.ts';
import type { SourceAdapter } from './types.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'rivet-semantics-')), file = join(root, 'source.sqlite');
  const raw = openRawStore(file), facts = createSourceSemantics(raw.database);
  t.after(() => { try { raw.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  let sequence = 0;
  const save = (adapter: SourceAdapter<string>, payload: string, connection = 'fixture') => {
    const number = ++sequence;
    const result = runSync(raw, { adapter, input: payload, sourceId: `conn:${connection}`, accountId: connection,
      idempotencyKey: `semantic_attempt_${number}`, now: () => new Date(Date.UTC(2026, 9, number)).toISOString() });
    const observation = facts.ingest(result.batch!, `source_${connection}`)!;
    assert.equal(raw.batchAtObservation(observation.id)!.payload, payload, 'projection does not rewrite acquisition bytes');
    assert.equal(raw.receipt(result.receipt.id)!.observationId, observation.id);
    return observation;
  };
  return { raw, facts, save, file };
}
const youtube = (values: (number | null)[], account = 'UCfixture') => JSON.stringify({ schema: 'youtube/v1', account: { id: account, title: 'Fictional teaching channel' }, truncated: false,
  videos: values.map((value, index) => ({ id: `v${index}`, title: 'Same title is not a join key', publishedAt: '2026-09-25T00:00:00Z', views: '100', likes: value === null ? null : String(value), comments: '0' })) });
const mailchimp = (values: (number | null)[]) => mailchimpTable.serialize({ account: { id: 'us21:fixture', title: 'Fictional school mail' }, partial: false, notes: [],
  rows: values.map((value, index) => [`c${index}`, 'Same title is not a join key', 'Newsletter', '2026-09-25T00:00:00Z', 100, value, null, 0, null, 0, null, null]) });
const analytics = (timezone = 'America/New_York', date = '20261002', duplicate = false) => analyticsTable.serialize({ account: { id: '123', title: 'Fictional site' }, partial: false, notes: [],
  rows: [[`r1`, date, 'Organic Search', 12, 8, 15, 0, timezone], ...(duplicate ? [[`r2`, date, 'Organic Search', 12, 8, 15, 0, timezone]] : [])] });

test('five native sources produce typed observations, readable records, native metric meanings and exact missing values', t => {
  const { facts, save, raw } = fixture(t);
  for (const product of ['facebook', 'instagram'] as const) {
    const observation = save(metaGraphAdapter, JSON.stringify({ schema: 'meta-graph/v1', product, graphVersion: 'v26.0', account: { id: 'page1', name: 'Fictional Page' },
      window: { days: 90, maxPosts: 500 }, truncated: true, posts: [{ id: 'post1', fields: { message: 'Read me', caption: 'Read me', created_time: '2026-09-25T00:00:00Z', timestamp: '2026-09-25T00:00:00Z',
        permalink: 'https://example.com/post1', permalink_url: 'https://example.com/post1', link: 'https://example.com/?utm_campaign=school', shares: { count: 0 } },
      insights: product === 'facebook' ? { post_reactions_by_type_total: { like: 2, love: 3 } } : { likes: 5, comments: 0 }, insightsStatus: 'ok' }] }), product);
    const record = facts.records(observation.id)[0]!;
    assert.equal(record.text, 'Read me'); assert.equal(record.url, 'https://example.com/post1');
    assert.deepEqual(record.trackingLinks, ['https://example.com/?utm_campaign=school']); assert.equal(record.campaignId, null, 'UTM text does not become a provider campaign ID');
    assert.equal(record.publishedAt, '2026-09-25T00:00:00.000Z'); assert.equal(observation.providerMeasuredAt, null);
    assert.equal(observation.capped, true); assert.equal(observation.coverage, 'partial');
    assert.equal(record.metrics[product === 'facebook' ? 'reactions' : 'likes']!.value, 5);
    assert.equal(record.metrics[product === 'facebook' ? 'shares' : 'comments']!.value, 0);
  }
  const yt = save(youtubeSourceAdapter, youtube([0, null]), 'youtube');
  assert.equal(facts.records(yt.id)[1]!.metrics.likes!.missingReason, 'not_returned');
  assert.equal(facts.records(yt.id)[0]!.metrics.likes!.value, 0);
  assert.equal(yt.metricDefinitions.find(metric => metric.id === 'views')!.sourceField, 'statistics.viewCount');
  assert.equal(yt.metricDefinitions.some(metric => metric.id === 'impressions'), false);
  const mc = save(mailchimpTable.derive.source, mailchimp([5]), 'mailchimp');
  assert.equal(facts.records(mc.id)[0]!.campaignId, 'c0');
  assert.equal(facts.records(mc.id)[0]!.metrics.uniqueOpens!.value, null);
  assert.match(mc.metricDefinitions.find(metric => metric.id === 'uniqueOpens')!.label, /Campaign/);
  const ga = save(analyticsTable.derive.source, analytics(), 'analytics');
  assert.deepEqual(facts.records(ga.id)[0]!.period, { date: '2026-10-02', timezone: 'America/New_York', channel: 'Organic Search' });
  assert.equal(ga.metricDefinitions.find(metric => metric.id === 'activeUsers')!.additive, false);
  assert.equal(ga.metricDefinitions[0]!.basis, 'period');
  assert.equal(Number(raw.database.prepare('SELECT count(*) AS n FROM semantic_metric_values').get()!.n), 23);
  assert.ok(SOURCE_METRICS.facebook.every(metric => metric.id !== 'views'));
});

test('unchanged payloads keep separate observations and replay idempotently after reopening SQLite', t => {
  const { facts, save, raw, file } = fixture(t);
  const first = save(youtubeSourceAdapter, youtube([3])), second = save(youtubeSourceAdapter, youtube([3]));
  assert.notEqual(first.id, second.id); assert.equal(first.rawBatchId, second.rawBatchId);
  assert.notEqual(first.observedAt, second.observedAt);
  assert.deepEqual(facts.ingest(raw.batchAtObservation(first.id)!, first.sourceId), first);
  assert.equal(facts.list(first.rawSourceId).length, 2);
  const records = facts.records(second.id);
  raw.close();
  const reopened = openRawStore(file); t.after(() => reopened.close());
  const restored = createSourceSemantics(reopened.database);
  assert.deepEqual(restored.get(first.id), first); assert.deepEqual(restored.records(second.id), records);
  assert.equal(restored.list(first.rawSourceId).length, 2);
});

test('counter comparisons separate changed, new, absent and missing records and retain negative corrections', t => {
  const { facts, save } = fixture(t);
  const before = save(youtubeSourceAdapter, youtube([10, 2, 3, null]));
  const changed = JSON.parse(youtube([8, 4, 3, 7, 9])); changed.videos.splice(2, 1);
  const after = save(youtubeSourceAdapter, JSON.stringify(changed));
  const result = analyzeSources(facts, { operation: 'compare', before: before.id, after: after.id, metric: 'likes' });
  assert.ok(result.operation === 'compare');
  assert.deepEqual(result.rows.map(row => [row.recordId, row.status, row.delta]), [['v0', 'matched', -2], ['v1', 'matched', 2], ['v2', 'absent_from_window', null], ['v3', 'missing_metric', null], ['v4', 'new_in_window', null]]);
  assert.equal(result.matchedNetChange, 0); assert.equal(result.matchedRecords, 2);
  assert.equal(result.rows[0]!.evidence[0]!.rawBatchId, before.rawBatchId);
  assert.match(result.warnings[0]!, /not a complete activity log/);
  assert.throws(() => analyzeSources(facts, { operation: 'compare', before: after.id, after: before.id, metric: 'likes' }), /forward/);
  const other = save(youtubeSourceAdapter, youtube([10], 'UCother'), 'other');
  assert.throws(() => analyzeSources(facts, { operation: 'compare', before: before.id, after: other.id, metric: 'likes' }), /same connected account/);
});

test('cross-source correlation uses explicit stable IDs, reports sample size and never joins by matching text', t => {
  const { facts, save } = fixture(t);
  const left = save(youtubeSourceAdapter, youtube([1, 2, 3, null, 9]), 'youtube');
  const right = save(mailchimpTable.derive.source, mailchimp([2, 4, 6, 8, 18]), 'mailchimp');
  const request = { operation: 'correlate', left: { observationId: left.id, metric: 'likes' }, right: { observationId: right.id, metric: 'totalOpens' },
    on: { kind: 'explicit', pairs: [0, 1, 2, 3].map(i => ({ leftRecordId: `v${i}`, rightRecordId: `c${i}` })) } };
  const result = analyzeSources(facts, request);
  assert.ok('correlation' in result); assert.equal(result.status, 'calculated'); assert.equal(result.correlation, 1);
  assert.equal(result.eligiblePairs, 3); assert.equal(result.missingPairs, 1);
  assert.equal(result.unmatchedLeft, 1); assert.equal(result.unmatchedRight, 1);
  assert.match(result.warnings.join(' '), /not attribution or causation/); assert.match(result.warnings.join(' '), /caller-declared/);
  assert.deepEqual(analyzeSources(facts, request), result, 'same pinned observations give the same result and evidence');
  assert.throws(() => analyzeSources(facts, { ...request, on: { kind: 'identity' } }), /same provider and account/);
  assert.throws(() => analyzeSources(facts, { ...request, on: { kind: 'name' } }), /identity/);
  assert.throws(() => analyzeSources(facts, { ...request, on: { kind: 'explicit', pairs: [{ leftRecordId: 'v0', rightRecordId: 'missing' }] } }), /outside/);
});

test('correlation refuses to invent a coefficient for tiny, constant or all-missing samples', t => {
  const { facts, save } = fixture(t);
  for (const values of [[1, 2], [1, 1, 1], [null, null, null]]) {
    const observation = save(youtubeSourceAdapter, youtube(values));
    const result = analyzeSources(facts, { operation: 'correlate', left: { observationId: observation.id, metric: 'likes' },
      right: { observationId: observation.id, metric: 'views' }, on: { kind: 'identity' } });
    assert.ok('correlation' in result); assert.equal(result.correlation, null);
    assert.equal(result.status, values.length < 3 || values[0] === null ? 'insufficient_pairs' : 'constant_or_unrepresentable_series');
  }
});

test('period joins require real compatible dates, channels and timezone and reject lifetime/period mixing', t => {
  const { facts, save } = fixture(t);
  const first = save(analyticsTable.derive.source, analytics()), second = save(analyticsTable.derive.source, analytics());
  const request = { operation: 'join', left: { observationId: first.id, metric: 'sessions' }, right: { observationId: second.id, metric: 'views' }, on: { kind: 'period' } };
  const result = analyzeSources(facts, request); assert.equal(result.rows.length, 1);
  const otherZone = save(analyticsTable.derive.source, analytics('UTC'));
  assert.throws(() => analyzeSources(facts, { ...request, right: { observationId: otherZone.id, metric: 'views' } }), /timezone/);
  const duplicate = save(analyticsTable.derive.source, analytics('America/New_York', '20261002', true));
  assert.throws(() => analyzeSources(facts, { ...request, right: { observationId: duplicate.id, metric: 'views' } }), /not unique/);
  const yt = save(youtubeSourceAdapter, youtube([1]), 'youtube');
  assert.throws(() => analyzeSources(facts, { ...request, right: { observationId: yt.id, metric: 'likes' } }), /lifetime counters with daily/);
  assert.throws(() => analyzeSources(facts, { operation: 'compare', before: first.id, after: second.id, metric: 'sessions' }), /Period data/);
});

test('typed requests reject SQL, supplied values, fan-out, unknown metrics and unknown observations', t => {
  const { facts, save } = fixture(t), observation = save(youtubeSourceAdapter, youtube([1]));
  const request = { operation: 'join', left: { observationId: observation.id, metric: 'likes' }, right: { observationId: observation.id, metric: 'views' }, on: { kind: 'identity' } };
  for (const invalid of [null, { sql: 'select *' }, { ...request, values: [1, 2] }, { ...request, on: { kind: 'identity', sql: 'select *' } }, { ...request, left: { ...request.left, sql: 'select *' } }]) assert.throws(() => validateSourceAnalysis(invalid));
  assert.throws(() => validateSourceAnalysis({ ...request, on: { kind: 'explicit', pairs: [{ leftRecordId: 'v0', rightRecordId: 'v0' }, { leftRecordId: 'v0', rightRecordId: 'v1' }] } }), /one-to-one/);
  assert.throws(() => analyzeSources(facts, { ...request, left: { ...request.left, metric: 'impressions' } }), /not defined/);
  assert.throws(() => analyzeSources(facts, { ...request, left: { ...request.left, observationId: 'missing' } }), /unavailable/);
});

test('invalid projections cannot leave half-written facts or rounded counts', t => {
  const { raw, facts, save } = fixture(t);
  for (const payload of [analytics('Invalid/Timezone'), analytics('UTC', '20260230'),
    youtube([Number.MAX_SAFE_INTEGER + 1]), mailchimp([1]).replace('"c0"', '""'),
    mailchimpTable.serialize({ account: { id: 'us21:fixture', title: 'Mail' }, partial: false, notes: [], rows: [
      ['duplicate', 'A', 'A', null, 1, 1, null, null, null, null, null, null], ['duplicate', 'B', 'B', null, 1, 1, null, null, null, null, null, null]] })]) {
    const adapter = payload.includes('google-analytics/v1') ? analyticsTable.derive.source : payload.includes('youtube/v1') ? youtubeSourceAdapter : mailchimpTable.derive.source;
    assert.throws(() => save(adapter, payload));
  }
  assert.equal(Number(raw.database.prepare('SELECT count(*) AS n FROM semantic_observations').get()!.n), 0);
  assert.equal(Number(raw.database.prepare('SELECT count(*) AS n FROM semantic_records').get()!.n), 0);
  assert.equal(facts.list('conn:fixture').length, 0);
});

test('empty windows retain an observation without inventing zeros or removing earlier facts', t => {
  const { facts, save } = fixture(t);
  const populated = save(youtubeSourceAdapter, youtube([2])), empty = save(youtubeSourceAdapter, youtube([]));
  assert.equal(empty.recordCount, 0); assert.deepEqual(facts.records(empty.id), []);
  assert.equal(empty.recordRange, undefined);
  assert.equal(facts.records(populated.id)[0]!.metrics.likes!.value, 2);
  const result = analyzeSources(facts, { operation: 'compare', before: populated.id, after: empty.id, metric: 'likes' });
  assert.ok(result.operation === 'compare'); assert.equal(result.matchedNetChange, null); assert.equal(result.rows[0]!.delta, null);
});

test('saved record ranges cover all dated records, not the preview page or the requested backfill window', t => {
  const { facts, save, raw } = fixture(t);
  const observation = save(mailchimpTable.derive.source, mailchimpTable.serialize({ account: { id: 'us21:fixture', title: 'Mail' }, partial: true, notes: [], rows: [
    ['c1', 'Recent', 'Recent', '2026-09-29T12:00:00Z', 1, 1, null, null, null, null, null, null],
    ['c2', 'Missing', 'Missing', null, 1, 1, null, null, null, null, null, null],
    ['c3', 'Old', 'Old', '2026-08-01T12:00:00Z', 1, 1, null, null, null, null, null, null],
  ] }));
  assert.deepEqual(observation.recordRange, { from: '2026-08-01T12:00:00.000Z', to: '2026-09-29T12:00:00.000Z', basis: 'publication', datedRecords: 2 });
  assert.equal(observation.recordCount, 3); assert.equal(observation.coverage, 'partial');
  const ga = save(analyticsTable.derive.source, analytics());
  assert.deepEqual(ga.recordRange, { from: '2026-10-02', to: '2026-10-02', basis: 'reporting-period', datedRecords: 1 });
  const { recordRange: _range, ...legacy } = observation;
  raw.database.prepare('UPDATE semantic_observations SET metadata=? WHERE id=?').run(JSON.stringify(legacy), observation.id);
  assert.equal(facts.get(observation.id)!.recordRange, undefined, 'older observations remain readable without fabricating coverage');
});

test('source reviews filter publication dates exactly, rank bounded rows and retain full-cohort evidence', t => {
  const { facts, save } = fixture(t);
  const payload = JSON.parse(youtube([1, 9, 3, 5]));
  ['2026-09-20T23:59:59Z', '2026-09-21T00:00:00Z', '2026-09-27T23:59:59Z', '2026-09-28T00:00:00Z']
    .forEach((date, i) => { payload.videos[i].publishedAt = date; });
  const observation = save(youtubeSourceAdapter, JSON.stringify(payload));
  const request = { operation: 'review', observationId: observation.id, metric: 'likes', groupBy: 'record', dateRange: { from: '2026-09-21', to: '2026-09-28' }, limit: 1 };
  const result = analyzeSources(facts, request);
  assert.ok(result.operation === 'review');
  assert.deepEqual(result.rows.map(row => [row.group, row.value]), [['v1', 9]]);
  assert.equal(result.totals.value, 12); assert.equal(result.evidence.included.length, 2);
  assert.deepEqual(result.counts, { inputRecords: 4, includedRecords: 2, excludedByDate: 2, excludedUndated: 0, totalGroups: 2, returnedGroups: 1 });
  assert.equal(result.dateBasis, 'publication_utc'); assert.equal(result.timezone, 'UTC');
  assert.match(result.warnings.join(' '), /not engagement earned/);
  assert.deepEqual(analyzeSources(facts, request), result);
  assert.equal(facts.forSource(observation.sourceId!)[0]!.id, observation.id);
  assert.deepEqual(facts.forSource('unselected-source'), []);
});

test('source reviews preserve missing values, genuine zero, empty cohorts and non-additive unique counts', t => {
  const { facts, save } = fixture(t);
  const observation = save(mailchimpTable.derive.source, mailchimp([0, null]));
  const result = analyzeSources(facts, { operation: 'review', observationId: observation.id, metric: 'totalOpens', groupBy: 'record' });
  assert.ok(result.operation === 'review');
  assert.equal(result.totals.value, null); assert.equal(result.totals.knownSum, 0); assert.equal(result.totals.missingRecords, 1);
  assert.equal(result.rows[0]!.value, 0); assert.equal(result.rows[1]!.value, null);
  const nonAdditive = analyzeSources(facts, { operation: 'review', observationId: observation.id, metric: 'uniqueOpens', groupBy: 'day' });
  assert.ok(nonAdditive.operation === 'review'); assert.equal(nonAdditive.totals.value, null); assert.equal(nonAdditive.totals.nonAdditive, true);
  const empty = analyzeSources(facts, { operation: 'review', observationId: observation.id, metric: 'totalOpens', groupBy: 'record', dateRange: { from: '2020-01-01', to: '2020-01-02' } });
  assert.ok(empty.operation === 'review'); assert.equal(empty.totals.value, null); assert.equal(empty.counts.includedRecords, 0);
  assert.match(empty.warnings.join(' '), /not proof of zero/);
});

test('GA4 reviews use reporting days and property timezone, and withhold unique-user totals', t => {
  const { facts, save } = fixture(t);
  const observation = save(analyticsTable.derive.source, analyticsTable.serialize({ account: { id: '123', title: 'Site' }, partial: false, notes: [], rows: [
    ['r1', '20261002', 'Organic Search', 12, 8, 15, 0, 'America/New_York'],
    ['r2', '20261003', 'Email', 5, 4, 7, 0, 'America/New_York'],
  ] }));
  const result = analyzeSources(facts, { operation: 'review', observationId: observation.id, metric: 'sessions', groupBy: 'channel', dateRange: { from: '2026-10-02', to: '2026-10-03' } });
  assert.ok(result.operation === 'review'); assert.equal(result.totals.value, 12);
  assert.equal(result.rows[0]!.group, 'Organic Search'); assert.equal(result.dateBasis, 'provider_period'); assert.equal(result.timezone, 'America/New_York');
  const users = analyzeSources(facts, { operation: 'review', observationId: observation.id, metric: 'activeUsers', groupBy: 'day' });
  assert.ok(users.operation === 'review'); assert.equal(users.totals.value, null); assert.equal(users.totals.knownSum, null);
  assert.throws(() => analyzeSources(facts, { operation: 'review', observationId: observation.id, metric: 'sessions', groupBy: 'contentType' }), /channel/);
});

test('source reviews refuse malformed dates, SQL, supplied totals, unknown metrics and numeric overflow', t => {
  const { facts, save } = fixture(t), observation = save(youtubeSourceAdapter, youtube([Number.MAX_SAFE_INTEGER, 1]));
  const request = { operation: 'review', observationId: observation.id, metric: 'likes', groupBy: 'record' };
  for (const invalid of [{ ...request, sql: 'SELECT *' }, { ...request, values: [5] }, { ...request, limit: 0 }, { ...request, limit: 101 }, { ...request, groupBy: ['record'] },
    { ...request, dateRange: { from: '2026-02-30', to: '2026-03-01' } }, { ...request, dateRange: { from: '2026-03-02', to: '2026-03-01' } }]) assert.throws(() => validateSourceAnalysis(invalid));
  assert.throws(() => analyzeSources(facts, request), /exact supported range/);
  assert.throws(() => analyzeSources(facts, { ...request, metric: 'revenue' }), /not defined/);
  assert.throws(() => analyzeSources(facts, { ...request, observationId: 'missing' }), /unavailable/);
});
