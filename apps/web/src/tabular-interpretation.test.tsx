import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeDataset, normalizeCsv } from '../../../packages/data-layer/src/tabular/index';
import type { AnalysisRequest } from '../../../packages/data-layer/src/tabular/types';
import { initialTabularView, tabularInterpretation } from '../../../packages/presentation/src/tabular-interpretation';
import { TabularAnalysisView } from './tabular-analysis';

const dataset = normalizeCsv('id,type,likes,comments,shares,impressions\np1,Image,10,2,3,100\np2,Reel,0,0,0,10\np3,Reel,,1,1,20\n', {
  confirmed: true, platform: 'instagram', columns: { postId: 'id', contentType: 'type', likes: 'likes', comments: 'comments', shares: 'shares', impressions: 'impressions' },
});
const calculate = (overrides: Partial<AnalysisRequest> = {}) => analyzeDataset(dataset, { metrics: ['likes', 'engagementRate'], groupBy: 'contentType', chart: 'table', ...overrides });

test('saved table results open as bars without changing values, identity or other requested chart types', () => {
  const result = calculate(), before = JSON.stringify(result);
  assert.equal(initialTabularView(result, 'likes'), 'bar');
  const html = renderToStaticMarkup(createElement(TabularAnalysisView, { analysis: { kind: 'tabular', datasetId: dataset.id, sourceId: 'source', result }, runId: 'test', onSource() {} }));
  assert.match(html, /value="bar" selected=""/);
  assert.doesNotMatch(html, /value="table"/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*aria-label="Chart"/);
  assert.match(html, /aria-label="Result interpretation"/);
  assert.match(html, /Likes total 10 across 2 source rows with the required inputs/);
  for (const chart of ['bar', 'horizontalBar', 'line', 'area', 'combo', 'scatter'] as const) {
    assert.equal(initialTabularView(calculate({ chart }), 'likes'), chart);
  }
  assert.equal(JSON.stringify(result), before);
});

test('interpretation explains the stored rate and includes missing coverage without treating it as zero', () => {
  const text = tabularInterpretation(calculate(), 'engagementRate');
  assert.match(text, /Engagement rate is 13\.6364% across 2 source rows/);
  assert.match(text, /total likes, comments and shares divided by total impressions/);
  assert.match(text, /not an average of individual post rates/);
  assert.match(text, /Image has the highest recorded engagement rate \(15%\)/);
  assert.match(text, /1 included source row could not contribute/);
  assert.doesNotMatch(text, /above average|caused|signups|registrations|people/);
});

test('zero, missing values and an empty cohort remain distinct, including chart fallback', () => {
  const zero = calculate({ contentTypes: ['Reel'] });
  assert.match(tabularInterpretation(zero, 'likes'), /Likes total 0 across 1 source row/);
  assert.equal(initialTabularView(zero, 'likes'), 'bar');
  const missing = calculate({ metrics: ['saves'] });
  assert.match(tabularInterpretation(missing, 'saves'), /could not be calculated/);
  assert.equal(initialTabularView(missing, 'saves'), 'table');
  const empty = calculate({ dateRange: { from: '2030-01-01', to: '2030-02-01' } });
  assert.match(tabularInterpretation(empty, 'likes'), /No source rows matched/);
  assert.equal(initialTabularView(empty, 'likes'), 'table');
});

test('ranked subsets compare only returned groups and identify full-cohort totals', () => {
  const result = calculate({ sort: { metric: 'likes', direction: 'asc' }, limit: 1 });
  const text = tabularInterpretation(result, 'likes');
  assert.match(text, /Likes total 10/);
  assert.match(text, /total includes groups outside this selection/);
  assert.doesNotMatch(text, /highest/);
});

test('tied and all-zero groups do not invent a winning group', () => {
  const tied = normalizeCsv('id,type,likes\np1,Photo,4\np2,Image,4\np3,Reel,0', { confirmed: true, platform: 'instagram', columns: { postId: 'id', contentType: 'type', likes: 'likes' } });
  const result = analyzeDataset(tied, { metrics: ['likes'], groupBy: 'contentType', chart: 'bar' });
  assert.match(tabularInterpretation(result, 'likes'), /2 of 3 saved groups with a value tie/);
  const zeros = { ...result, totals: { likes: 0 }, rows: result.rows.map(row => ({ ...row, likes: 0 })) };
  assert.match(tabularInterpretation(zeros, 'likes'), /All 3 saved groups with a value have the same recorded value: 0/);
  assert.doesNotMatch(tabularInterpretation(zeros, 'likes'), /highest/);
});

test('descriptions use readable post labels and escape untrusted source captions', () => {
  const result = calculate({ groupBy: 'post' });
  const postLabels = new Map([[result.rows[0].group, { label: '<script>bad</script>', context: 'QA sample', postId: 'p1' }]]);
  const before = JSON.stringify(result);
  const html = renderToStaticMarkup(createElement(TabularAnalysisView, { analysis: { kind: 'tabular', datasetId: dataset.id, sourceId: 'source', result, postLabels: Object.fromEntries(postLabels) }, runId: 'test', onSource() {} }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt; \(Post 1\) has the highest recorded likes/);
  assert.equal(JSON.stringify(result), before);
});

test('automatic bars need a numeric value inside the chart window, not only beyond it', () => {
  const result = calculate({ metrics: ['likes'] });
  const rows = Array.from({ length: 51 }, (_, index) => ({ group: `g${index}`, likes: index === 50 ? 10 : null }));
  assert.equal(initialTabularView({ ...result, rows }, 'likes'), 'table');
  assert.equal(initialTabularView({ ...result, rows: [{ ...rows[0], likes: 0 }, ...rows.slice(1)] }, 'likes'), 'bar');
});

test('identical display labels remain tied to distinct post and group keys', () => {
  const result = calculate({ groupBy: 'post' });
  const postLabels = new Map(result.rows.map((row, index) => [row.group, { label: 'Same caption', context: 'QA sample', postId: `p${index}` }]));
  assert.match(tabularInterpretation({ ...result, postLabels }, 'likes'), /Same caption \(Post 1\) has the highest/);
  const accounts = { ...result, request: { ...result.request, groupBy: 'account' as const }, rows: [{ group: '["facebook","Demo"]', likes: 10 }, { group: '["instagram","Demo"]', likes: 2 }] };
  assert.match(tabularInterpretation(accounts, 'likes'), /Demo \(Group 1\) has the highest/);
});
