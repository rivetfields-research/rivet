import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeDataset, normalizeCsv } from './tabular/index.ts';
import { contentHash } from './tabular/input.ts';
import { analysisColumnLabel } from './tabular/labels.ts';
import type { Grouping } from './tabular/types.ts';

const dataset = normalizeCsv('id,date,type,likes\np1,2026-09-14,photo,9', {
  confirmed: true, platform: 'instagram', account: 'Test account', timezone: 'UTC',
  columns: { postId: 'id', publishedAt: 'date', contentType: 'type', likes: 'likes' },
});

test('new analyses use known grouping headings in their immutable result', () => {
  const headings: Record<Grouping, string> = {
    post: 'Post', platform: 'Platform', account: 'Account', contentType: 'Content type',
    day: 'Publication day', week: 'Publication week', month: 'Publication month',
  };
  for (const groupBy of Object.keys(headings) as Grouping[]) {
    const result = analyzeDataset(dataset, { metrics: ['likes'], groupBy, chart: 'table' });
    assert.equal(result.columns[0].label, headings[groupBy]);
    assert.equal(result.columns[0].id, 'group');
    assert.equal(result.rows[0].likes, 9);
    assert.equal(result.evidence.groups[0].group, result.rows[0].group);
    assert.deepEqual(result.evidence.groups[0].metrics.likes?.eligible, [dataset.rows[0].provenance]);
    const { id, hash, ...body } = result;
    assert.equal(hash, contentHash(body));
    assert.equal(id, `analysis_${hash}`);
  }
});

test('heading lookup preserves custom, metric and unknown labels verbatim', () => {
  for (const label of ['Editorial format', 'content_type', 'week', 'Content type', '']) {
    assert.equal(analysisColumnLabel({ id: 'group', label }, 'contentType'), label);
  }
  assert.equal(analysisColumnLabel({ id: 'likes', label: 'contentType' }, 'contentType'), 'contentType');
  assert.equal(analysisColumnLabel({ id: 'group', label: 'campaignId' }, 'campaignId' as Grouping), 'campaignId');
});
