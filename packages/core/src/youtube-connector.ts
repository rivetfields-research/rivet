import { createHash } from 'node:crypto';
import { deriveYouTubeCsv, parseYouTubeSnapshot, serializeYouTubeSnapshot, youtubeSourceAdapter, type YouTubeSnapshot } from '../../data-layer/src/adapters/youtube.ts';
import { HarnessError } from './errors.ts';
import type { BoundedResponse } from './oauth.ts';
import type { SyncAdapter } from './sync-dispatch.ts';
import { discoveryRequest, reconnectBy } from './provider-reader.ts';
import { isGoogleInvalidRefreshGrant } from './google-oauth.ts';

const BASE = 'https://www.googleapis.com/youtube/v3/';
const ID = /^[A-Za-z0-9_-]{1,100}$/;
type Request = (url: string, init?: RequestInit, limits?: { limit?: number; timeoutMs?: number }) => Promise<BoundedResponse>;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new HarnessError('YouTube returned data this workspace cannot import.', 502, 'provider_invalid_result');
async function read(request: Request, path: string, params: Record<string, string>): Promise<ObjectValue> {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await request(url.href, undefined, { limit: 2 * 1024 * 1024, timeoutMs: 15_000 });
  if (response.status === 401) throw new HarnessError('Reconnect your YouTube account.', 401, 'oauth_expired');
  if (response.status === 429) throw new HarnessError('YouTube is limiting requests. Try syncing later.', 429, 'rate_limited');
  if (response.status === 403) throw new HarnessError('YouTube access or API quota is unavailable. Review the connection settings.', 403, 'provider_blocked');
  if (!response.ok || response.status !== 200 || response.truncated) throw new HarnessError('YouTube could not be read. Try syncing later.', 502, 'provider_error');
  let value: unknown;
  try { value = JSON.parse(response.body); } catch { throw invalid(); }
  if (!object(value) || 'error' in value) throw invalid();
  return value;
}
function items(value: ObjectValue): ObjectValue[] {
  if (!Array.isArray(value.items) || value.items.some(item => !object(item))) throw invalid();
  return value.items as ObjectValue[];
}
function reportedTotal(value: ObjectValue): number | undefined {
  if (value.pageInfo === undefined) return undefined;
  if (!object(value.pageInfo) || !Number.isSafeInteger(value.pageInfo.totalResults) || (value.pageInfo.totalResults as number) < 0) throw invalid();
  return value.pageInfo.totalResults as number;
}
function channel(value: ObjectValue) {
  if (typeof value.id !== 'string' || !ID.test(value.id) || !object(value.snippet) || typeof value.snippet.title !== 'string' ||
      !object(value.contentDetails) || !object(value.contentDetails.relatedPlaylists) ||
      typeof value.contentDetails.relatedPlaylists.uploads !== 'string' || !ID.test(value.contentDetails.relatedPlaylists.uploads)) throw invalid();
  return { id: value.id, title: value.snippet.title.slice(0, 120), uploads: value.contentDetails.relatedPlaylists.uploads };
}
function metric(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw invalid();
  return value;
}
function video(value: ObjectValue, accountId: string): YouTubeSnapshot['videos'][number] {
  const snippet = value.snippet;
  if (typeof value.id !== 'string' || !ID.test(value.id) || !object(snippet) || snippet.channelId !== accountId ||
      typeof snippet.title !== 'string' || typeof snippet.publishedAt !== 'string' || !Number.isFinite(Date.parse(snippet.publishedAt)) || !object(value.statistics)) throw invalid();
  return { id: value.id, title: snippet.title, publishedAt: snippet.publishedAt, views: metric(value.statistics.viewCount),
    likes: metric(value.statistics.likeCount), comments: metric(value.statistics.commentCount) };
}

/** Complete ownership enumeration: a truncated channel list cannot establish lost access. */
async function ownedChannels(request: Request, signal: AbortSignal) {
  const found: ReturnType<typeof channel>[] = [], pages = new Set<string>(), ids = new Set<string>();
  let pageToken = '';
  let total: number | undefined;
  do {
    signal.throwIfAborted();
    const result = await read(request, 'channels', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    signal.throwIfAborted();
    const reported = reportedTotal(result);
    if (total !== undefined && reported !== undefined && total !== reported) throw invalid();
    total ??= reported;
    for (const item of items(result).map(channel)) {
      if (ids.has(item.id)) throw invalid();
      ids.add(item.id); found.push(item);
    }
    if (result.nextPageToken !== undefined && (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 2048)) throw invalid();
    pageToken = typeof result.nextPageToken === 'string' ? result.nextPageToken : '';
    if (pageToken && pages.has(pageToken)) throw invalid();
    if (pageToken) pages.add(pageToken);
    if (pages.size > 20) throw invalid();
  } while (pageToken);
  if (total !== undefined && found.length !== total) throw invalid();
  return found;
}

export type YouTubeSnapshotRevalidation =
  | { status: 'channel_unavailable'; accountId: string }
  | { status: 'checked'; snapshot: YouTubeSnapshot; unavailableVideoIds: string[] };

/**
 * Re-read exactly the videos in a stored acquisition, including videos outside today's uploads window.
 * Returns only after every request succeeds. Missing resources are unavailable, not proof of deletion;
 * failures throw and must never authorize cleanup. No saved snapshot or report is changed here.
 */
export async function revalidateYouTubeSnapshot(input: {
  json: string; accountId: string; request: Request; signal: AbortSignal;
}): Promise<YouTubeSnapshotRevalidation> {
  const stored = parseYouTubeSnapshot(input.json);
  if (stored.account.id !== input.accountId) throw invalid();
  const request: Request = (url, init, limits) => input.request(url, { ...init, signal: input.signal }, limits);
  const selected = (await ownedChannels(request, input.signal)).find(item => item.id === input.accountId);
  input.signal.throwIfAborted();
  if (!selected) return { status: 'channel_unavailable', accountId: input.accountId };
  const videos: YouTubeSnapshot['videos'] = [], unavailableVideoIds: string[] = [];
  const ids = stored.videos.map(item => item.id);
  for (let offset = 0; offset < ids.length; offset += 50) {
    input.signal.throwIfAborted();
    const batch = ids.slice(offset, offset + 50);
    const result = await read(request, 'videos', { part: 'snippet,statistics', id: batch.join(',') });
    input.signal.throwIfAborted();
    // An unexpected pagination marker makes absence ambiguous; do not classify missing IDs.
    if ([result.nextPageToken, result.prevPageToken].some(token => token !== undefined && token !== '')) throw invalid();
    const returned = items(result).map(item => video(item, input.accountId));
    const total = reportedTotal(result);
    if (total !== undefined && total !== returned.length) throw invalid();
    const present = new Set(returned.map(item => item.id));
    if (present.size !== returned.length || returned.some(item => !batch.includes(item.id))) throw invalid();
    unavailableVideoIds.push(...batch.filter(id => !present.has(id)));
    videos.push(...returned);
  }
  videos.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { status: 'checked', unavailableVideoIds,
    snapshot: { schema: 'youtube/v1', account: { id: selected.id, title: selected.title }, truncated: stored.truncated || unavailableVideoIds.length > 0, videos } };
}

export function createYouTubeAdapter(options: { clientId: string; clientSecret: string; fetch?: typeof globalThis.fetch }): SyncAdapter {
  if (!options.clientId || !options.clientSecret) throw new HarnessError('Configure the YouTube OAuth app.', 500, 'oauth_provider_configuration');
  return {
    id: 'youtube', label: 'YouTube', timeoutMs: 180_000, minSyncIntervalMs: 15 * 60_000, syncOnConnect: true, automaticDailySync: true,
    derive: { source: youtubeSourceAdapter, csv: deriveYouTubeCsv },
    oauth: {
      clientId: options.clientId, clientSecret: options.clientSecret, dataHosts: ['www.googleapis.com'], ...(options.fetch ? { fetch: options.fetch } : {}),
      provider: { id: 'youtube', label: 'YouTube', pkce: true,
        isInvalidRefreshGrant: isGoogleInvalidRefreshGrant,
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
        authorizeParams: { scope: 'https://www.googleapis.com/auth/youtube.readonly', access_type: 'offline', prompt: 'consent' },
        validateTokens(tokens) {
          if (!tokens.scope?.split(' ').includes('https://www.googleapis.com/auth/youtube.readonly')) throw new HarnessError('Allow read access to your YouTube account.', 403, 'permission_missing');
        },
      },
      async accounts(context) {
        const found = await ownedChannels(discoveryRequest(context), context.signal);
        if (found.length > 20) throw invalid();
        // Grant identity is stable across refreshes; never persist the access token in a snapshot or identifier.
        const grantKey = createHash('sha256').update(`youtube:${options.clientId}:${found.map(item => item.id).sort().join(',')}`).digest('hex').slice(0, 32);
        return { grantKey, tokens: context.tokens, accounts: found.map(item => ({ provider: 'youtube', accountId: item.id,
          displayName: item.title, tokens: context.tokens, reconnectBy: reconnectBy(context.tokens) })) };
      },
    },
    async acquire(context) {
      if (!context.oauth || !ID.test(context.connection.providerAccountId)) throw invalid();
      const request = context.oauth.request;
      const found = await ownedChannels(request, context.signal);
      const selected = found.find(item => item.id === context.connection.providerAccountId);
      if (!selected) throw new HarnessError('This YouTube channel is no longer accessible. Reconnect it.', 403, 'permission_missing');
      const ids = new Set<string>();
      const pages = new Set<string>();
      let pageToken = '', truncated = false;
      do {
        if (context.signal.aborted) throw new HarnessError('Sync cancelled.', 409, 'cancelled');
        const result = await read(request, 'playlistItems', { part: 'contentDetails', playlistId: selected.uploads, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
        for (const item of items(result)) {
          if (!object(item.contentDetails) || typeof item.contentDetails.videoId !== 'string' || !ID.test(item.contentDetails.videoId)) throw invalid();
          if (ids.size < 500) ids.add(item.contentDetails.videoId); else truncated = true;
        }
        if (result.nextPageToken !== undefined && (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 2048)) throw invalid();
        pageToken = typeof result.nextPageToken === 'string' ? result.nextPageToken : '';
        if (pageToken && pages.has(pageToken)) throw invalid();
        if (pageToken) pages.add(pageToken);
        if (pages.size > 20) throw invalid();
        if (ids.size >= 500 && pageToken) { truncated = true; break; }
      } while (pageToken);
      const videos: YouTubeSnapshot['videos'] = [];
      const allIds = [...ids];
      for (let offset = 0; offset < allIds.length; offset += 50) {
        const batch = allIds.slice(offset, offset + 50);
        const returned = items(await read(request, 'videos', { part: 'snippet,statistics', id: batch.join(',') })).map(item => video(item, selected.id));
        if (returned.some(item => !batch.includes(item.id)) || new Set(returned.map(item => item.id)).size !== returned.length) throw invalid();
        if (returned.length !== batch.length) truncated = true;
        videos.push(...returned);
      }
      videos.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return { json: serializeYouTubeSnapshot({ schema: 'youtube/v1', account: { id: selected.id, title: selected.title }, truncated, videos }) };
    },
  };
}
