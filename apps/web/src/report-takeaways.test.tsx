import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeDataset, normalizeCsv } from '../../../packages/data-layer/src/tabular/index';
import type { AnalysisRequest } from '../../../packages/data-layer/src/tabular/types';
import { TabularTakeaways } from './report-takeaways';

const dataset = normalizeCsv('id,type,likes,comments,shares,impressions\np1,Image,10,2,3,100\np2,Reel,0,0,0,10\np3,Reel,,1,1,20\n', {
  confirmed: true, platform: 'instagram', columns: { postId: 'id', contentType: 'type', likes: 'likes', comments: 'comments', shares: 'shares', impressions: 'impressions' },
});
const calculate = (overrides: Partial<AnalysisRequest> = {}) => analyzeDataset(dataset, { metrics: ['likes', 'engagementRate'], groupBy: 'contentType', chart: 'bar', ...overrides });
const render = (result = calculate()) => renderToStaticMarkup(createElement(TabularTakeaways, { result, onInspect() {} }));

test('takeaways bind colored numbers to saved metrics and preserve the calculation', () => {
  const result = calculate(), before = structuredClone(result), html = render(result);
  assert.match(html, /class="report-evidence-number" aria-label="Show source rows for takeaway Likes total"[^>]*>10<\/button>/);
  assert.match(html, /Show source rows for takeaway Likes for Image/);
  assert.match(html, /Show source rows for takeaway Engagement rate total[^>]*>13\.6364%/);
  assert.match(html, /1 included source row could not contribute/);
  assert.match(html, /may be lifetime values/);
  assert.deepEqual(result, before);
});
test('rates describe ratios of totals without claiming clicks are registrations', () => {
  const html = render(calculate({ metrics: ['engagementRate'] }));
  assert.match(html, /13\.6364%/);
  assert.match(html, /ratio of totals, not an average of post rates/);
  assert.doesNotMatch(html, /registrations|caused|above average/);
});
test('empty, missing and zero summaries remain distinct', () => {
  const empty = render(calculate({ dateRange: { from: '2030-01-01', to: '2030-02-01' } }));
  assert.match(empty, /not a measured zero/); assert.doesNotMatch(empty, /report-evidence-number/);
  const missing = render(calculate({ metrics: ['saves'] }));
  assert.match(missing, /do not support a saves total/); assert.doesNotMatch(missing, /report-evidence-number/);
  const zero = render(calculate({ metrics: ['likes'], contentTypes: ['Reel'] }));
  assert.match(zero, /Likes total[^>]*>0<\/button>/);
});
test('limited selections and tied groups do not invent a winner', () => {
  const limited = render(calculate({ sort: { metric: 'likes', direction: 'asc' }, limit: 1 }));
  assert.match(limited, /Totals include groups outside this selection/);
  assert.doesNotMatch(limited, /highest/);
  const base = calculate({ metrics: ['likes'] });
  const tied = render({ ...base, totals: { likes: 0 }, rows: base.rows.map(row => ({ ...row, likes: 0 })) });
  assert.match(tied, /shown values are equal/);
  assert.match(tied, /no single leader/);
});
test('untrusted and duplicated captions stay readable without changing evidence identity', () => {
  const result = calculate({ groupBy: 'post' });
  const postLabels = new Map(result.rows.map(row => [row.group, { label: '<script>Same caption</script>', context: 'Synthetic sample', postId: row.group }]));
  const html = renderToStaticMarkup(createElement(TabularTakeaways, { result: { ...result, postLabels }, onInspect() {} }));
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
});
