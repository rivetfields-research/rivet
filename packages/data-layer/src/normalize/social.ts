import { DataLayerError, type DataDiagnostic } from '../errors.ts';
import type { RawBatch, RawRecord } from '../types.ts';

export const SOCIAL_NORMALIZER_VERSION = 'social-posts/v1';

export type SocialPlatform = 'instagram' | 'facebook';

/** Only metrics a public export can actually observe. Reach, impressions, clicks, spend,
 *  revenue and ROI are never derived here, because public post data does not contain them. */
export const SOCIAL_METRICS = ['likes', 'comments', 'shares', 'videoViews', 'videoPlays'] as const;
export type SocialMetric = typeof SOCIAL_METRICS[number];

export interface SocialPost {
  /** 1-based record number inside this batch, so a receipt can name the exact source record. */
  readonly record: number;
  readonly platform: SocialPlatform;
  readonly account: string;
  readonly postId: string;
  readonly postUrl: string;
  readonly contentType: string;
  /** Publication time, or null when the export does not carry one. Never invented. */
  readonly publishedAt: string | null;
  /** Captions are untrusted content and are not needed for a metric summary; only their size is kept. */
  readonly captionCharacters: number;
  readonly metrics: Readonly<Record<SocialMetric, number | null>>;
}

export interface NormalizedSocialBatch {
  readonly version: typeof SOCIAL_NORMALIZER_VERSION;
  readonly platform: SocialPlatform;
  readonly accountId: string | null;
  readonly posts: readonly SocialPost[];
  readonly warnings: readonly DataDiagnostic[];
}

const PLATFORM_HOSTS: Record<SocialPlatform, readonly string[]> = {
  instagram: ['instagram.com', 'www.instagram.com', 'm.instagram.com'],
  facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com'],
};

/** Which provider field carries which observed metric, per platform. */
const FIELD_MAP: Record<SocialPlatform, Readonly<Record<SocialMetric, string | null>>> = {
  instagram: { likes: 'likesCount', comments: 'commentsCount', shares: null, videoViews: 'videoViewCount', videoPlays: 'videoPlayCount' },
  facebook: { likes: 'likes', comments: 'comments', shares: 'shares', videoViews: null, videoPlays: null },
};

function text(record: RawRecord, key: string, position: number): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new DataLayerError(`Record ${position} has a non-text ${key}. Export the field as text rather than coercing it.`, 'invalid_field_type',
      [{ code: 'invalid_field_type', message: `The ${key} field must be text.`, field: key, record: position }]);
  }
  return value.trim() || null;
}

/** Counts are read strictly: a numeric string is a schema change, not a number to coerce. */
function count(record: RawRecord, key: string, position: number): number | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DataLayerError(`Record ${position} has an unusable ${key}. Observed counts must be whole non-negative numbers.`, 'invalid_metric_value',
      [{ code: 'invalid_metric_value', message: `The ${key} field must be a whole non-negative number.`, field: key, record: position }]);
  }
  return value;
}

function postUrl(value: string | null, platform: SocialPlatform, position: number): string {
  let parsed: URL;
  try { parsed = new URL(value ?? ''); }
  catch {
    throw new DataLayerError(`Record ${position} needs a valid ${platform} post URL.`, 'invalid_post_url',
      [{ code: 'invalid_post_url', message: `Provide an absolute ${platform} post URL.`, field: 'url', record: position }]);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !PLATFORM_HOSTS[platform].includes(parsed.hostname)) {
    throw new DataLayerError(`Record ${position} is not a ${platform} URL. Keep each platform's records in its own source.`, 'platform_boundary',
      [{ code: 'platform_boundary', message: `A ${platform} source may only contain ${platform} post URLs.`, field: 'url', record: position }]);
  }
  parsed.hash = '';
  return parsed.href;
}

function published(value: string | null, position: number): string | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DataLayerError(`Record ${position} has an unreadable publication time. Provide an ISO 8601 timestamp or omit the field.`, 'invalid_published_at',
      [{ code: 'invalid_published_at', message: 'Use an ISO 8601 publication timestamp, or omit it when it is genuinely unknown.', field: 'publishedAt', record: position }]);
  }
  return new Date(value).toISOString();
}

/**
 * Map one batch of previously fetched public post records into typed posts.
 *
 * The platform decides the field mapping, so an undeclared platform is refused rather than
 * guessed. Absent metrics stay null, observed zeros stay zero, and a value that is present
 * but unusable stops the import instead of being coerced.
 */
export function normalizeSocialBatch(batch: RawBatch, options: { readonly platform: SocialPlatform | null }): NormalizedSocialBatch {
  const platform = options.platform;
  if (platform !== 'instagram' && platform !== 'facebook') {
    throw new DataLayerError('Declare the export platform as instagram or facebook: the metric fields differ per provider and are never guessed.', 'unknown_platform',
      [{ code: 'unknown_platform', message: 'Declare platform instagram or facebook before normalizing this dataset.' }]);
  }
  if (batch.manifest.format !== 'json') {
    throw new DataLayerError('A social batch must come from a dataset export adapter; this batch is not JSON.', 'unsupported_format',
      [{ code: 'unsupported_format', message: 'Import the provider dataset through the Apify dataset adapter.' }]);
  }
  const fields = FIELD_MAP[platform];
  const seenIds = new Set<string>(), seenUrls = new Set<string>();
  const warnings: DataDiagnostic[] = [];
  const posts = batch.records.map((record, index): SocialPost => {
    const position = index + 1;
    const postId = text(record, platform === 'instagram' ? 'id' : 'postId', position);
    if (!postId) {
      throw new DataLayerError(`Record ${position} has no ${platform} post id. Export the posts dataset rather than a partial projection.`, 'missing_post_id',
        [{ code: 'missing_post_id', message: 'Every post needs a provider post id.', record: position }]);
    }
    const url = postUrl(text(record, 'url', position), platform, position);
    if (seenIds.has(postId) || seenUrls.has(url)) {
      throw new DataLayerError(`Record ${position} repeats a post already present in this batch. Import one observation per post.`, 'duplicate_post',
        [{ code: 'duplicate_post', message: 'Each post may appear once per batch.', record: position }]);
    }
    seenIds.add(postId); seenUrls.add(url);
    const account = text(record, platform === 'instagram' ? 'ownerUsername' : 'pageName', position)
      ?? text(record, platform === 'instagram' ? 'ownerId' : 'facebookId', position)
      ?? batch.accountId;
    if (!account) {
      throw new DataLayerError(`Record ${position} has no account, and this batch declares none. Declare the account or export the owner/page field.`, 'missing_account',
        [{ code: 'missing_account', message: 'A post must be attributable to an account.', record: position }]);
    }
    const metrics = Object.fromEntries(SOCIAL_METRICS.map(metric => {
      const field = fields[metric];
      return [metric, field === null ? null : count(record, field, position)];
    })) as Record<SocialMetric, number | null>;
    if (SOCIAL_METRICS.every(metric => metrics[metric] === null)) {
      throw new DataLayerError(`Record ${position} carries no supported public metric for ${platform}. Check the export schema before importing.`, 'no_supported_metrics',
        [{ code: 'no_supported_metrics', message: `Expected at least one of ${SOCIAL_METRICS.join(', ')}.`, record: position }]);
    }
    const caption = text(record, platform === 'instagram' ? 'caption' : 'text', position);
    return {
      record: position,
      platform,
      account,
      postId,
      postUrl: url,
      contentType: text(record, 'type', position) ?? 'unknown',
      publishedAt: published(text(record, platform === 'instagram' ? 'timestamp' : 'time', position), position),
      captionCharacters: caption?.length ?? 0,
      metrics,
    };
  });
  if (!posts.length) {
    throw new DataLayerError('The batch contains no post records to normalize.', 'empty_batch', [{ code: 'empty_batch', message: 'Sync a non-empty posts dataset first.' }]);
  }
  // Publication time is what makes a weekly cohort meaningful; say so rather than hiding it.
  const undated = posts.filter(post => post.publishedAt === null).length;
  if (undated) {
    warnings.push({ code: 'undated_posts', message: `${undated} of ${posts.length} posts have no publication time and cannot join a weekly cohort.` });
  }
  return { version: SOCIAL_NORMALIZER_VERSION, platform, accountId: batch.accountId, posts, warnings };
}
