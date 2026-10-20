import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeDataset, normalizeCsv } from '../../../packages/data-layer/src/tabular/index';
import type { Run } from '../../../packages/core/src/types';
import { exampleRun } from './example-work';
import { analyzeSources, SEMANTIC_VERSION, SOURCE_METRICS, type SourceObservation, type SourceSemantics } from '../../../packages/data-layer/src/source-semantics';

const css = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { AgentSession } = await import('./agent-session');
css.deregister();

const dataset = normalizeCsv('id,date,likes\na,2026-09-21,15\nb,2026-09-22,\nc,2026-09-23,0', {
  confirmed: true, platform: 'facebook', account: 'Synthetic UI test', timezone: 'UTC', columns: { postId: 'id', publishedAt: 'date', likes: 'likes' },
});
const analysis = { kind: 'tabular' as const, sourceId: 'saved-receipt', datasetId: dataset.id,
  result: analyzeDataset(dataset, { metrics: ['likes'], groupBy: 'post', chart: 'bar' }) };
function replyRun(id: string, withAnalysis = true): Run {
  return { ...exampleRun, id, result: null, events: [], reply: { content: '15 recorded likes. [Calculation](source:saved-receipt)',
    citations: ['saved-receipt'], createdAt: exampleRun.createdAt, ...(withAnalysis ? { tabularAnalysis: analysis } : {}) } };
}
function render(run: Run, previousTurns: Run[] = []) {
  return renderToStaticMarkup(createElement(AgentSession, { run, previousTurns, sources: [], onSource() {}, onFollowup() {}, async onRetryExplanation() {}, onWorkflow() {} }));
}

test('calculated chat answers start compact without a document pane or mounted chart/table', () => {
  const run = replyRun('current'), before = structuredClone(run);
  const html = render(run);
  assert.match(html, /15 recorded likes/);
  assert.match(html, /data-source-id="saved-receipt"/);
  assert.match(html, /<details class="agent-supporting-data"><summary>/);
  assert.match(html, /Supporting data/);
  assert.doesNotMatch(html, /class="tabular-analysis"|Complete analysis data table|tabular-chart|tabular\.csv|Task document|Session view/);
  assert.deepEqual(run, before);
});

test('each calculated earlier reply retains a disclosure and plain answers do not invent one', () => {
  assert.doesNotMatch(render(replyRun('plain', false)), /Supporting data/);
  const html = render(replyRun('current'), [replyRun('earlier'), replyRun('plain', false)]);
  assert.equal((html.match(/class="agent-supporting-data"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /class="tabular-analysis"|tabular\.csv/);
  assert.match(html, /Follow-up instructions/);
});

test('the current graphical follow-up opens its supporting chart while older replies remain compact', () => {
  const run = { ...replyRun('followup'), parentRunId: 'earlier' };
  const html = render(run, [replyRun('earlier')]);
  assert.match(html, /<details class="agent-supporting-data" open="">/);
  assert.match(html, /class="tabular-analysis"/);
  assert.match(html, /Complete analysis data table/);
  assert.equal((html.match(/class="tabular-analysis"/g) ?? []).length, 1);
  const table = structuredClone(run);
  table.reply!.tabularAnalysis = { ...analysis, result: { ...analysis.result, request: { ...analysis.result.request, chart: 'table' } } };
  assert.doesNotMatch(render(table), /agent-supporting-data" open/);
});

test('native saved calculations survive failed explanations without inventing a finished report', () => {
  const observation: SourceObservation = { id: 'observed', version: SEMANTIC_VERSION, rawBatchId: 'batch', rawSourceId: 'connected', sourceId: 'source', provider: 'youtube' as const,
    accountId: 'channel', observedAt: '2026-10-06T12:00:00Z', providerMeasuredAt: null, sourceHash: 'a'.repeat(64), coverage: 'complete' as const, capped: false,
    recordCount: 0, metricDefinitions: SOURCE_METRICS.youtube };
  const semantics: SourceSemantics = { get: () => observation, records: () => [], forSource: () => [observation], list: () => [observation], ingest: () => null };
  const sourceAnalysis = { kind: 'source' as const, sourceId: 'checked-source', result: analyzeSources(semantics, { operation: 'review', observationId: 'observed', metric: 'views', groupBy: 'record' }) };
  const failed: Run = { ...replyRun('failed-native', false), reply: undefined, status: 'failed', error: 'Explanation unavailable.', savedSourceAnalysis: sourceAnalysis };
  const html = render(failed);
  assert.match(html, /Calculation saved; explanation incomplete/);
  assert.match(html, /<h1[^>]*>Social performance<\/h1>/);
  assert.match(html, /No records matched this saved analysis/);
  assert.doesNotMatch(html, /No document was saved|Retry explanation|Create workflow|Print report/);
  const completed: Run = { ...failed, status: 'completed', error: null, result: { id: 'native-report', title: 'Connected source review', content: 'Short answer.\n\n## Checked source review\n\nPortable receipt.', citations: ['checked-source'], createdAt: observation.observedAt, sourceAnalysis } };
  const report = render(completed);
  assert.match(report, /source-analysis/); assert.match(report, /Short answer/);
  assert.doesNotMatch(report, /Portable receipt/);
  assert.equal(completed.result!.content.includes('Portable receipt'), true);
  for (const previous of [failed, completed]) {
    const before = structuredClone(previous);
    assert.doesNotMatch(render(previous), /Saved from an earlier answer/);
    const followup = render(replyRun('newer-reply', false), [previous]);
    assert.match(followup, /Saved from an earlier answer/);
    assert.match(followup, /kept unchanged/);
    assert.deepEqual(previous, before);
  }
});

test('failed improvements retain the previous report and disclose useful support details', () => {
  const previous: Run = { ...exampleRun, id: 'previous', status: 'completed', events: [], result: { id: 'report', title: 'Saved chart', content: 'Saved report', citations: [], createdAt: exampleRun.createdAt } };
  const failed: Run = { ...replyRun('failed', false), reply: undefined, status: 'failed', error: 'The model finished without a usable answer.', errorCode: 'provider_empty_response', model: 'configured-deployment' };
  const html = render(failed, [previous]);
  assert.match(html, /Your earlier report is still available/);
  assert.match(html, /Failure details/); assert.match(html, /provider_empty_response/); assert.doesNotMatch(html, /configured-deployment/);
  assert.match(html, /Saved chart/);
  assert.doesNotMatch(render({ ...failed, errorCode: undefined }), /Failure details/);
});

test('context-limit failures distinguish the earlier empty report from the latest unfinished attempt', () => {
  const previous: Run = { ...exampleRun, id: 'previous-week', status: 'completed', events: [],
    result: { id: 'empty-week', title: 'Weekly review', content: 'No records matched the selected week.', citations: [], createdAt: exampleRun.createdAt } };
  const failed: Run = { ...replyRun('oversized', false), parentRunId: previous.id, reply: undefined, status: 'failed',
    error: 'The run reached its 48,000-character context limit.', errorCode: 'context_limit',
    events: [{ id: 'analyzing', sequence: 1, type: 'model', createdAt: exampleRun.createdAt, summary: 'Private model request.' }] };
  const before = structuredClone([previous, failed]);
  for (const current of [failed, { ...failed, errorCode: undefined }, JSON.parse(JSON.stringify(failed)) as Run]) {
    const html = render(current, [previous]);
    assert.match(html, /Earlier task · Complete/); assert.match(html, /Latest task · Failed/);
    assert.match(html, /Earlier report/); assert.match(html, /Latest task failed\. This report was not updated\./);
    assert.match(html, /No records matched the selected week/); assert.match(html, /No new report was saved\./);
    assert.match(html, /one question or a shorter date range/); assert.match(html, /Revise follow-up/);
    assert.match(html, /Prepare answer: Not started/);
    assert.equal((html.match(/data-state="complete"/g) ?? []).length, 4, 'only earlier completion and current preparation are complete');
    assert.doesNotMatch(html, /Retry explanation|verified|>Reset conversation|>Reconnect/i);
  }
  assert.deepEqual([previous, failed], before);
  const fresh = render({ ...failed, id: 'recovered-followup', parentRunId: failed.id, status: 'completed', error: null, errorCode: undefined,
    result: { ...previous.result!, id: 'fresh-week', content: 'A newly saved answer.' } }, [previous, failed]);
  assert.match(fresh, /A newly saved answer/); assert.doesNotMatch(fresh, /Earlier report|This report was not updated|Revise follow-up/);
  assert.match(fresh, /Latest task · Complete/); assert.match(fresh, /Earlier task · Failed/);
  assert.match(fresh, /The run reached its 48,000-character context limit/);
  assert.deepEqual([previous, failed], before);
});

test('a streamed failure stops current prose and leaves saved calculations explicitly incomplete', () => {
  const failed: Run = { ...failedCalculation, status: 'running', error: null, events: [
    { id: 'draft', sequence: 1, type: 'model_delta', requestId: 'draft-request', delta: '{"type":"reply","content":"Provisional prose', createdAt: exampleRun.createdAt, summary: 'Private draft.' },
    { id: 'failure', sequence: 2, type: 'failed', createdAt: exampleRun.createdAt, summary: 'Private failure.', output: { errorCode: 'context_limit' } },
  ] };
  const html = render(failed);
  assert.match(html, /Calculation saved; explanation incomplete/); assert.match(html, /The explanation is incomplete/);
  assert.match(html, /Retry explanation/); assert.match(html, /Revise follow-up/);
  assert.doesNotMatch(html, /Explanation in progress|The explanation is being prepared|Streaming answer|Provisional prose|No new report was saved/);
});

test('failed explanation shows saved calculated data and an explicit budgeted retry, never a fabricated report', () => {
  const failed: Run = {...replyRun('recoverable',false),reply:undefined,status:'failed',error:'Explanation unavailable.',savedCalculation:{analysis,savedAt:exampleRun.createdAt}};
  const html=render(failed);
  assert.match(html,/Calculation saved; explanation incomplete/);
  assert.match(html,/Retry explanation/); assert.match(html,/uses your model allowance/);
  assert.match(html,/<h1[^>]*>Social performance<\/h1>/); assert.match(html,/recoverable\/tabular.csv/);
  assert.doesNotMatch(html,/No document was saved|Create workflow|Print report/);
  assert.doesNotMatch(render({...failed,savedCalculation:undefined}),/Retry explanation|<h1[^>]*>Social performance/);
  assert.doesNotMatch(render({...failed,status:'running',error:null}),/Retry explanation/);
  assert.doesNotMatch(render({...failed,status:'completed',error:null,reply:replyRun('complete').reply}),/Retry explanation|<h1[^>]*>Social performance/);
});

const failedCalculation: Run = { ...replyRun('original', false), reply: undefined, status: 'failed', error: 'Original explanation unavailable.', savedCalculation: { analysis, savedAt: exampleRun.createdAt } };
const recovered: Run = { ...replyRun('retry'), explanationRetryOf: failedCalculation.id, parentRunId: failedCalculation.id, savedCalculation: failedCalculation.savedCalculation };

test('a successful chat retry retains its exact calculation document through follow-ups and reload', () => {
  const before = structuredClone([failedCalculation, recovered]);
  for (const [current, history] of [
    [recovered, [failedCalculation]],
    [replyRun('follow-up', false), [failedCalculation, recovered]],
    [JSON.parse(JSON.stringify(recovered)) as Run, [failedCalculation]],
  ] as const) {
    const html = render(current, [...history]);
    assert.match(html, /<h1[^>]*>Social performance<\/h1>/);
    assert.match(html, /Explanation complete\./);
    assert.match(html, /retry\/tabular.csv/);
    assert.doesNotMatch(html, /original\/tabular.csv|The explanation is incomplete|Retry explanation/);
    assert.match(html, /Original explanation unavailable/, 'the original failure remains in history');
  }
  assert.deepEqual([failedCalculation, recovered], before);
});

test('document progress belongs to the calculation attempt, not an unrelated running follow-up', () => {
  const followup: Run = { ...replyRun('working', false), reply: undefined, status: 'running' };
  const html = render(followup, [failedCalculation, recovered]);
  assert.match(html, /Explanation complete\./);
  assert.doesNotMatch(html, /Explanation in progress|The explanation is being prepared|The explanation is incomplete/);
  const unrecovered = render(followup, [failedCalculation]);
  assert.match(unrecovered, /The explanation is incomplete/);
  assert.doesNotMatch(unrecovered, /Explanation in progress|The explanation is being prepared/);
  const pending = render({ ...recovered, status: 'running', reply: undefined }, [failedCalculation]);
  assert.match(pending, /The explanation is being prepared/);
  assert.doesNotMatch(pending, /Explanation complete\./);
});

test('a failed retry or a newer failed calculation is not marked explained', () => {
  for (const current of [
    { ...recovered, status: 'failed' as const, reply: undefined, error: 'Retry failed.' },
    { ...failedCalculation, id: 'new-calculation' },
  ]) {
    const html = render(current, [failedCalculation, recovered]);
    assert.match(html, /The explanation is incomplete/);
    assert.match(html, /Retry explanation/);
    assert.match(html, new RegExp(`${current.id}/tabular.csv`));
    assert.doesNotMatch(html, /Explanation complete\./);
  }
});

test('a completion flag cannot mark a failed explanation retry as complete', () => {
  for (const run of [
    { ...recovered, error: 'Explanation failed after saving data.' },
    { ...recovered, events: [{ id: 'failed-retry', sequence: 1, type: 'failed' as const, summary: 'Private failure.', createdAt: exampleRun.createdAt }] },
  ]) {
    const html = render(run, [failedCalculation]);
    assert.match(html, /The explanation is incomplete/);
    assert.doesNotMatch(html, /Explanation complete\.|Rivet reply/);
  }
});

test('a plain reply or a retry citing a different calculation cannot complete the saved document', () => {
  for (const current of [replyRun('plain', false),
    { ...recovered, reply: { ...recovered.reply!, tabularAnalysis: { ...analysis, sourceId: 'other-receipt' } } },
    { ...recovered, reply: { ...recovered.reply!, tabularAnalysis: { ...analysis, result: { ...analysis.result, id: 'other-result' } } } },
  ]) {
    const html = render(current, [failedCalculation]);
    assert.match(html, /The explanation is incomplete/);
    assert.match(html, /original\/tabular.csv/);
    assert.doesNotMatch(html, /Explanation complete\./);
  }
});
