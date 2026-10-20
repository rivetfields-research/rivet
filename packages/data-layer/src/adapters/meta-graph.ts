import { canonicalJson } from '../hash.ts';
import { refuse } from '../errors.ts';
import type { RawRecord, RawScalar, RawFetch, SourceAdapter } from '../types.ts';
import type { CsvMapping, MetricSource } from '../tabular/types.ts';

/*
 * Meta Graph API snapshots (M8): one Instagram professional account or one Facebook Page, already fetched by the
 * runtime's Meta connector (C5: this adapter only parses bytes it is given). The snapshot is kept verbatim in the raw
 * store; `deriveMetaGraphCsv` turns it into a `social-csv/v1` CSV with fixed code, mapping only the metrics whose
 * meaning matches a column (docs/CONNECTOR_PROVIDER_FACTS.md section 8):
 *
 *   Instagram   likes, comments, shares   <- media insights `likes`, `comments`, `shares`
 *   Facebook    reactions                 <- sum of `post_reactions_by_type_total`
 *               shares                    <- the post's `shares.count`
 *
 * Views, reach, saves, the follower counts and `like_count` / `comments_count` stay in the raw JSON only. No
 * `*impressions*` metric is ever requested or mapped, and views or reach never become impressions (MM-01, MM-08).
 * Facebook comment counts stay missing until facts U-9 is closed. A value the snapshot does not hold is left blank:
 * missing stays missing, never 0.
 */

export const META_GRAPH_SCHEMA = 'meta-graph/v1' as const;
export const META_GRAPH_LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, posts: 500 });
export type MetaProduct = 'instagram' | 'facebook';

export interface MetaGraphPost {
  readonly id: string;
  /** The provider's own fields, exactly as returned for the requested field list. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Metric name → the provider's value. `null` when insights were not available for this post. */
  readonly insights: Readonly<Record<string, unknown>> | null;
  /** `unsupported`: Meta refused insights for this post (for example a carousel); its values stay missing. */
  readonly insightsStatus: 'ok' | 'unsupported';
}
export interface MetaGraphSnapshot {
  readonly schema: typeof META_GRAPH_SCHEMA;
  readonly product: MetaProduct;
  readonly graphVersion: string;
  readonly account: Readonly<{ id: string; name?: string; username?: string; followers_count?: number; media_count?: number }>;
  /** The bounded window that was read: never a timestamp, so identical provider data gives identical bytes. */
  readonly window: Readonly<{ days: number; maxPosts: number }>;
  /** True when the post cap stopped the read before the window's end. */
  readonly truncated: boolean;
  readonly posts: readonly MetaGraphPost[];
}

const ID = /^[A-Za-z0-9_]{1,80}$/;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Parses and checks a snapshot. Anything else is refused rather than guessed at. */
export function parseMetaGraphSnapshot(json: string): MetaGraphSnapshot {
  if (typeof json !== 'string') refuse('invalid_meta_snapshot', 'Provide the fetched Meta snapshot as JSON text.');
  if (Buffer.byteLength(json) > META_GRAPH_LIMITS.bytes) refuse('byte_limit', 'The Meta snapshot is larger than 10 MiB.');
  let value: unknown;
  try { value = JSON.parse(json); } catch { refuse('invalid_meta_snapshot', 'The Meta snapshot is not valid JSON.'); }
  if (!isObject(value) || value.schema !== META_GRAPH_SCHEMA || (value.product !== 'instagram' && value.product !== 'facebook') ||
      typeof value.graphVersion !== 'string' || !/^v\d{1,3}\.\d$/.test(value.graphVersion) ||
      !isObject(value.account) || typeof value.account.id !== 'string' || !ID.test(value.account.id) ||
      !isObject(value.window) || !Number.isInteger(value.window.days) || !Number.isInteger(value.window.maxPosts) ||
      typeof value.truncated !== 'boolean' || !Array.isArray(value.posts) || value.posts.length > META_GRAPH_LIMITS.posts) {
    refuse('invalid_meta_snapshot', 'The Meta snapshot does not have the expected shape.');
  }
  const ids = new Set<string>();
  for (const post of value.posts as unknown[]) {
    if (!isObject(post) || typeof post.id !== 'string' || !ID.test(post.id) || ids.has(post.id) || !isObject(post.fields) ||
        (post.insights !== null && !isObject(post.insights)) || (post.insightsStatus !== 'ok' && post.insightsStatus !== 'unsupported')) {
      refuse('invalid_meta_snapshot', 'A post in the Meta snapshot does not have the expected shape.');
    }
    ids.add(post.id);
  }
  return value as unknown as MetaGraphSnapshot;
}

/** Scalars stay exact; nested provider values keep their content as canonical JSON text. */
function scalar(value: unknown): RawScalar | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return canonicalJson(value);
}

/** Synchronous parse of an already-fetched snapshot (C5). The payload is kept byte for byte. */
export const metaGraphAdapter: SourceAdapter<string> = {
  id: 'meta-graph',
  format: 'json',
  read(json): RawFetch {
    const snapshot = parseMetaGraphSnapshot(json);
    const records: RawRecord[] = snapshot.posts.map(post => {
      const record: Record<string, RawScalar> = { id: post.id, insightsStatus: post.insightsStatus };
      for (const [key, item] of Object.entries(post.fields)) { const value = scalar(item); if (value !== undefined && key !== 'id') record[key] = value; }
      for (const [key, item] of Object.entries(post.insights ?? {})) { const value = scalar(item); if (value !== undefined) record[`insights.${key}`] = value; }
      return record;
    });
    const times = snapshot.posts.map(post => publishedAt(post, snapshot.product)).filter((item): item is string => item !== null).sort();
    return {
      payload: json,
      payloadEncoding: 'original',
      records,
      format: 'json',
      columns: [...new Set(records.flatMap(record => Object.keys(record)))].sort(),
      // The newest post read. Each sync re-reads its whole bounded window, because lifetime counts keep changing.
      cursorAfter: times.at(-1) ?? null,
      provenance: {
        kind: 'api-fetch',
        label: `Meta Graph API ${snapshot.graphVersion} (${snapshot.product === 'instagram' ? 'Instagram' : 'Facebook Page'})`,
        locator: `${snapshot.product}:${snapshot.account.id}`,
        // Only a bounded recent window is read.
        declaredCoverage: 'partial',
      },
    };
  },
};

const TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;
/** Meta's `2026-07-01T09:30:00+0000` as ISO UTC, or null when it is absent or unreadable. */
function publishedAt(post: MetaGraphPost, product: MetaProduct): string | null {
  const value = post.fields[product === 'instagram' ? 'timestamp' : 'created_time'];
  if (typeof value !== 'string') return null;
  const match = TIME.exec(value);
  if (!match) return null;
  const zone = match[2] === 'Z' ? 'Z' : `${match[2].slice(0, 3)}:${match[2].slice(-2)}`;
  const date = new Date(`${match[1]}${zone}`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const count = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
/** Sum of a reactions-by-type object. An empty object is Meta's real answer of no reactions; anything else is missing. */
function reactions(value: unknown): string {
  if (!isObject(value)) return '';
  let total = 0;
  for (const item of Object.values(value)) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) return '';
    total += item;
  }
  return Number.isSafeInteger(total) ? String(total) : '';
}
const INSTAGRAM_TYPES: Readonly<Record<string, string>> = { IMAGE: 'Image', VIDEO: 'Video', CAROUSEL_ALBUM: 'Carousel' };
const INSTAGRAM_PRODUCTS: Readonly<Record<string, string>> = { REELS: 'Reel', STORY: 'Story' };
function instagramType(fields: Readonly<Record<string, unknown>>): string {
  const product = typeof fields.media_product_type === 'string' ? INSTAGRAM_PRODUCTS[fields.media_product_type] : undefined;
  return product ?? (typeof fields.media_type === 'string' ? INSTAGRAM_TYPES[fields.media_type] ?? '' : '');
}
/** RFC 4180 quoting. Cells are data; the runtime never evaluates them. */
const cell = (value: string) => /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
/** A readable, path-safe label from an account name the provider controls. */
const label = (value: string) => value.replace(/[/\\\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

export const META_INSTAGRAM_MAPPING: CsvMapping = Object.freeze({
  confirmed: true, platform: 'instagram', timezone: 'UTC',
  columns: Object.freeze({ postId: 'Post ID', publishedAt: 'Published', account: 'Account', contentType: 'Type', likes: 'Likes', comments: 'Comments', shares: 'Shares' }),
}) as CsvMapping;
export const META_FACEBOOK_MAPPING: CsvMapping = Object.freeze({
  confirmed: true, platform: 'facebook', timezone: 'UTC',
  columns: Object.freeze({ postId: 'Post ID', publishedAt: 'Published', account: 'Account', reactions: 'Reactions', shares: 'Shares' }),
}) as CsvMapping;

export interface MetaGraphDerived {
  readonly metricSource: MetricSource;
  /** The dataset's file name, from the account: `Instagram · @handle.csv` or `Facebook Page · Name.csv`. */
  readonly name: string;
  /** `social-csv/v1` CSV, byte-identical for identical snapshot bytes. Null when the window holds no posts. */
  readonly csv: string | null;
  readonly mapping: CsvMapping;
  readonly posts: number;
}

/**
 * The canonical CSV for a snapshot: fixed columns, the snapshot's post order, and only same-meaning metrics. Pure and
 * deterministic, so boot recovery re-derives exactly what a live sync would have imported.
 */
export function deriveMetaGraphCsv(json: string): MetaGraphDerived {
  const snapshot = parseMetaGraphSnapshot(json);
  const instagram = snapshot.product === 'instagram';
  const handle = instagram ? label(snapshot.account.username ?? '') : '';
  const account = handle || label(snapshot.account.name ?? '') || snapshot.account.id;
  const name = `${instagram ? `Instagram · ${handle ? '@' : ''}` : 'Facebook Page · '}${account}.csv`;
  const header = instagram ? ['Post ID', 'Published', 'Account', 'Type', 'Likes', 'Comments', 'Shares'] : ['Post ID', 'Published', 'Account', 'Reactions', 'Shares'];
  const textField = instagram ? 'caption' : 'message';
  // Older snapshots must re-derive the same bytes during recovery. New text stays in source cells as data.
  const readablePosts = snapshot.posts.some(post => typeof post.fields[textField] === 'string');
  if (readablePosts) header.push('Post text', 'Post URL');
  const rows = snapshot.posts.map(post => {
    const insights = post.insightsStatus === 'ok' ? post.insights ?? {} : {};
    const published = publishedAt(post, snapshot.product) ?? '';
    const shares = isObject(post.fields.shares) ? count(post.fields.shares.count) : '';
    const row = instagram
      ? [post.id, published, account, instagramType(post.fields), count(insights.likes), count(insights.comments), count(insights.shares)]
      : [post.id, published, account, post.insightsStatus === 'ok' && post.insights ? reactions(insights.post_reactions_by_type_total) : '', shares];
    if (readablePosts) {
      const text = post.fields[textField];
      const url = post.fields[instagram ? 'permalink' : 'permalink_url'];
      row.push(typeof text === 'string' ? text : '', typeof url === 'string' ? url : '');
    }
    return row;
  });
  return {
    name,
    metricSource: { provider: snapshot.product, accountId: snapshot.account.id },
    csv: rows.length ? `${[header, ...rows].map(row => row.map(cell).join(',')).join('\n')}\n` : null,
    mapping: instagram ? META_INSTAGRAM_MAPPING : META_FACEBOOK_MAPPING,
    posts: rows.length,
  };
}
