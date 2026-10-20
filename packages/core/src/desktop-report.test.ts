import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, type ModelProvider, type Run } from './index.ts';
import { requireExplicitTabularPeriod } from './tabular-followup.ts';
import type { AnalysisRequest, CsvMapping } from '../../data-layer/src/tabular/types.ts';

const CSV = 'Post,Published,Likes,Comments\np1,2026-09-21,10,2\np2,2026-09-22,20,3\np3,2026-09-23,5,0\n';
const MAPPING: CsvMapping = { confirmed: true, platform: 'unspecified', account: 'Fictional desktop test', timezone: 'UTC',
  columns: { postId: 'Post', publishedAt: 'Published', likes: 'Likes', comments: 'Comments' } };
const json = (action: unknown) => ({ content: JSON.stringify(action), usage: { inputTokens: 10, outputTokens: 10 } });

function fixture(t: TestContext, complete: ModelProvider['complete']) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-report-'));
  mkdirSync(join(root, 'sources'));
  const options = { dataDir: join(root, 'data'), sourceDir: join(root, 'sources'), modelBaseUrl: 'http://127.0.0.1:8001/v1',
    provider: { status: async () => ({ configured: true, available: true, model: 'scripted-desktop-report',
      kind: 'openai-compatible' as const, label: 'Scripted test', message: 'No model inference' }), complete } };
  const harness = createHarness(options);
  t.after(async () => { await harness.close(); rmSync(root, { recursive: true, force: true }); });
  return { harness, options };
}

async function settle(harness: ReturnType<typeof createHarness>, id: string): Promise<Run> {
  for (let i = 0; i < 300; i++) {
    const run = harness.getRun(id)!;
    if (!harness.activeRunId() && !['queued', 'running'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Scripted desktop report did not settle');
}

test('explicit publication windows retain exact UTC boundaries and the original request', () => {
  for (const [task, dateRange] of [
    ['Posts published September 1 through September 30, 2026 inclusive.', { from: '2026-09-01', to: '2026-10-01' }],
    ['Posts published from December 1 through December 31, 2026.', { from: '2026-12-01', to: '2027-01-01' }],
    ['Posts published February 1 through February 29, 2028.', { from: '2028-02-01', to: '2028-03-01' }],
  ] as const) {
    const request: AnalysisRequest = { metrics: ['likes'], groupBy: 'day', chart: 'line', timezone: 'UTC', dateRange };
    assert.doesNotThrow(() => requireExplicitTabularPeriod(task, request));
    assert.doesNotThrow(() => requireExplicitTabularPeriod(task, { ...request,
      dateRange: { from: dateRange.from + 'T00:00:00Z', to: dateRange.to + 'T00:00:00Z' } }));
    assert.throws(() => requireExplicitTabularPeriod(task, { ...request, dateRange: undefined }), { code: 'tabular_period_required' });
    assert.throws(() => requireExplicitTabularPeriod(task, { ...request,
      dateRange: { from: dateRange.from, to: dateRange.to.slice(0, 8) + '02' } }), { code: 'tabular_period_required' });
    assert.deepEqual(request.dateRange, dateRange);
  }
});

test('ambiguous, negated, comparative and non-publication dates do not acquire an inferred period', () => {
  const request: AnalysisRequest = { metrics: ['likes'], groupBy: 'week', chart: 'line', timezone: 'UTC' };
  for (const task of [
    'Show all posts by publication week.',
    'Uploaded September 1 through September 30, 2026.',
    'Posts published September 1 through September 30, 2026 exclusive.',
    'Posts published February 1 through February 30, 2026.',
    'Compare posts published September 1 through September 30, 2026 with posts published October 1 through October 31, 2026.',
    'Compare posts published September 1 through September 30, 2026 with October 1 through October 31, 2026.',
    'Show all posts, not just posts published September 1 through September 30, 2026.',
    'The previous report covered posts published September 1 through September 30, 2026. Now show all history.',
    'Posts published September 1, 2026 through September 30, 2026.',
  ]) assert.doesNotThrow(() => requireExplicitTabularPeriod(task, request), task);
});

test('dataset-ID repair exposes only already-read selected inputs and preserves the chart and grouping', async t => {
  let sourceId = '', datasetId = '', otherSource = '', otherDataset = '', step = 0;
  const request: AnalysisRequest = { metrics: ['likes'], groupBy: 'week', chart: 'line', timezone: 'UTC' };
  const { harness, options } = fixture(t, async ({ messages }) => {
    if (step++ === 0) return json({ type: 'tool', name: 'workspace.read', arguments: { sourceId } });
    if (step === 2) return json({ type: 'tool', name: 'workspace.analyze_table', arguments: { datasetId: datasetId + 'bad', request } });
    if (step === 3) {
      const feedback = messages.at(-1)!.content;
      assert.match(feedback, /CSV dataset ID rejected; no calculation was executed/);
      assert.ok(feedback.includes(JSON.stringify({ sourceId, datasetId })));
      assert.ok(!feedback.includes(otherSource));
      assert.ok(!feedback.includes(otherDataset));
      assert.match(feedback, /original requested metrics, grouping, chart and filters unchanged/);
      assert.doesNotMatch(feedback, /Read rejected|not available in this run/);
      return json({ type: 'tool', name: 'workspace.analyze_table', arguments: { datasetId, request } });
    }
    const receipt = JSON.parse(messages.at(-1)!.content.split('\n').slice(1).join('\n')).sourceId;
    return json({ type: 'finish', title: 'Fictional weekly review',
      content: `The supplied fictional records have 35 likes. [Calculation](source:${receipt})`, citations: [receipt] });
  });
  const selected = harness.importTabularDataset({ csv: CSV, sourceName: 'selected-desktop-test.csv', mapping: MAPPING });
  sourceId = selected.source.id;
  datasetId = selected.id;
  const other = harness.importTabularDataset({ csv: CSV.replace('10,2', '99,2'), sourceName: 'unselected-desktop-test.csv', mapping: MAPPING });
  otherSource = other.source.id;
  otherDataset = other.id;
  const run = await settle(harness, (await harness.startRun({ sourceIds: [sourceId],
    task: 'Create a report of recorded likes by publication week with a line chart.', requestId: 'desktop-exact-id-recovery' })).id);
  assert.equal(run.status, 'completed', run.error ?? '');
  assert.equal(run.result?.tabularAnalysis?.result.totals.likes, 35);
  assert.deepEqual(run.result?.tabularAnalysis?.result.request, request);
  assert.deepEqual(run.events.filter(event => event.type === 'tool_call').map(event => event.toolName), ['workspace.read', 'workspace.analyze_table']);
  assert.equal(run.events.filter(event => (event.output as { validationCode?: string })?.validationCode === 'unknown_source').length, 1);
  await harness.close();
  const reopened = createHarness(options);
  try { assert.deepEqual(reopened.getRun(run.id), run); } finally { await reopened.close(); }
});

for (const repair of [true, false]) {
  test(`missing and shortened publication filters are rejected before calculation (${repair ? 'repaired' : 'repeated'})`, async t => {
    let sourceId = '', datasetId = '', step = 0;
    const request: AnalysisRequest = { metrics: ['likes', 'comments'], groupBy: 'day', chart: 'combo', timezone: 'UTC' };
    const { harness } = fixture(t, async ({ messages }) => {
      const current = step++;
      if (current === 0) return json({ type: 'tool', name: 'workspace.read', arguments: { sourceId } });
      if (current === 2 || current === 3) {
        assert.match(messages.at(-1)!.content, /requested publication window needs dateRange/);
        assert.match(messages.at(-1)!.content, /2026-10-01T00:00:00.000Z/);
      }
      if (current <= 3) return json({ type: 'tool', name: 'workspace.analyze_table', arguments: { datasetId,
        request: { ...request, ...(current > 1 ? { dateRange: { from: '2026-09-01', to: current === 3 && repair ? '2026-10-01' : '2026-09-30' } } : {}) } } });
      const receipt = JSON.parse(messages.at(-1)!.content.split('\n').slice(1).join('\n')).sourceId;
      return json({ type: 'finish', title: 'Fictional September counts',
        content: `The supplied fictional records have 44 likes and 5 recorded comments. One comment is missing; one October post and one undated post are excluded. [Calculation](source:${receipt})`, citations: [receipt] });
    });
    const csv = CSV + 'p4,2026-09-30T23:59:59Z,9,\np5,2026-10-01,100,50\np6,,40,7\n';
    const saved = harness.importTabularDataset({ csv, sourceName: 'fictional-period-boundaries.csv', mapping: MAPPING });
    sourceId = saved.source.id;
    datasetId = saved.id;
    const run = await settle(harness, (await harness.startRun({ sourceIds: [sourceId],
      task: 'Report likes and comments for posts published September 1 through September 30, 2026 inclusive, with a combo chart by day.',
      requestId: `desktop-explicit-window-${repair}` })).id);
    assert.equal(run.events.filter(event => event.type === 'tool_call' && event.toolName === 'workspace.analyze_table').length, repair ? 1 : 0);
    assert.equal(run.events.filter(event => (event.output as { validationCode?: string })?.validationCode === 'tabular_period_required').length, 2);
    if (repair) {
      assert.equal(run.status, 'completed', run.error ?? '');
      const result = run.result!.tabularAnalysis!.result;
      assert.deepEqual(result.totals, { likes: 44, comments: 5 });
      assert.deepEqual(result.counts, { inputRows: 6, includedRows: 4, excludedByDate: 1, excludedUndated: 1 });
      assert.equal(result.metricCoverage.comments!.missingRows, 1);
      assert.equal(result.request.chart, 'combo');
    } else {
      assert.equal(run.status, 'failed');
      assert.equal(run.result, null);
      assert.equal(run.savedCalculation, undefined);
    }
  });
}
