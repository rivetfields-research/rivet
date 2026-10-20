import type { SocialPost, SocialPlatform } from '../../data-layer/src/normalize/social.ts';
import type { SocialAccountGroup } from '../../data-layer/src/query/social.ts';

/** Exact saved inputs shared by the report, chart, table and CSV; never model-authored. */
export interface SocialAnalysis {
  kind: 'social-weekly';
  sourceId: string;
  batchId: string;
  account: string;
  platform: SocialPlatform;
  week: { from: string; through: string };
  fetchedAt: string;
  coverage: string;
  contentHash: string;
  groups: readonly SocialAccountGroup[];
  posts: readonly SocialPost[];
  notice: string;
}

export const socialMetricLabels = { likes: 'Likes', comments: 'Comments', shares: 'Shares', videoViews: 'Video views', videoPlays: 'Video plays' } as const;

export function socialAnalysisCsv(value: SocialAnalysis): string {
  const metrics = Object.keys(socialMetricLabels) as (keyof typeof socialMetricLabels)[];
  const rows = [['record', 'platform', 'account', 'post_url', 'published_at', ...metrics, 'fetched_at', 'coverage', 'period_from', 'period_through', 'counter_scope', 'source_id'],
    ...value.posts.map(post => [post.record, post.platform, post.account, post.postUrl, post.publishedAt ?? '', ...metrics.map(metric => post.metrics[metric] ?? ''), value.fetchedAt, value.coverage, value.week.from, value.week.through, 'Lifetime counters observed at fetch time; blanks are unknown', value.sourceId])];
  return rows.map(row => row.map(cell => {
    const text = String(cell);
    // Quoting alone does not stop spreadsheet formula execution in untrusted account names.
    return `"${(/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n') + '\r\n';
}
