import { canonicalJson } from '../hash.ts';
import { refuse } from '../errors.ts';
import type { RawFetch, SourceAdapter } from '../types.ts';
import type { CsvMapping, MetricSource } from '../tabular/types.ts';

export interface YouTubeSnapshot {
  schema: 'youtube/v1';
  account: { id: string; title: string };
  truncated: boolean;
  videos: { id: string; title: string; publishedAt: string; views: string | null; likes: string | null; comments: string | null }[];
}
const id = /^[A-Za-z0-9_-]{1,100}$/;
const count = (value: unknown) => value === null || (typeof value === 'string' && /^\d{1,20}$/.test(value));
export function parseYouTubeSnapshot(json: string): YouTubeSnapshot {
  let value: YouTubeSnapshot;
  try { value = JSON.parse(json); } catch { refuse('invalid_youtube_snapshot', 'YouTube returned unreadable data.'); }
  if (Buffer.byteLength(json) > 10 * 1024 * 1024 || value?.schema !== 'youtube/v1' || typeof value.account?.id !== 'string' || !id.test(value.account.id) ||
      typeof value.account.title !== 'string' || typeof value.truncated !== 'boolean' || !Array.isArray(value.videos) || value.videos.length > 500 ||
      value.videos.some(video => !video || typeof video.id !== 'string' || !id.test(video.id) || typeof video.title !== 'string' ||
        typeof video.publishedAt !== 'string' || !Number.isFinite(Date.parse(video.publishedAt)) ||
        !count(video.views) || !count(video.likes) || !count(video.comments)) || new Set(value.videos.map(video => video.id)).size !== value.videos.length) {
    refuse('invalid_youtube_snapshot', 'YouTube returned an unexpected snapshot.');
  }
  return value;
}
export const youtubeSourceAdapter: SourceAdapter<string> = {
  id: 'youtube', format: 'json',
  read(json): RawFetch {
    const value = parseYouTubeSnapshot(json);
    return { payload: json, payloadEncoding: 'original', records: value.videos, format: 'json',
      columns: ['id', 'title', 'publishedAt', 'views', 'likes', 'comments'], cursorAfter: null,
      provenance: { kind: 'api-fetch', label: 'YouTube video counts', locator: `youtube:${value.account.id}`, declaredCoverage: value.truncated ? 'partial' : 'complete' } };
  },
};
export function deriveYouTubeCsv(json: string): { name: string; csv: string | null; mapping: CsvMapping; metricSource: MetricSource } {
  const value = parseYouTubeSnapshot(json);
  const cell = (text: string | null) => `"${(text ?? '').replaceAll('"', '""')}"`;
  const mapping: CsvMapping = { confirmed: true, platform: 'unspecified', account: value.account.title,
    columns: { postId: 'Video ID', publishedAt: 'Published', contentType: 'Type', likes: 'Likes', comments: 'Comments' } };
  const lines = value.videos.map(video => [video.id, video.publishedAt, 'video', video.title,
    `https://www.youtube.com/watch?v=${video.id}`, video.views, video.likes, video.comments].map(cell).join(','));
  return { name: 'youtube-videos.csv', mapping, metricSource: { provider: 'youtube', accountId: value.account.id },
    csv: lines.length ? ['Video ID,Published,Type,Title,Video URL,Views,Likes,Comments', ...lines].join('\n') + '\n' : null };
}
export const serializeYouTubeSnapshot = (value: YouTubeSnapshot) => canonicalJson(value);
