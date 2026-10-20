import { canonicalJson } from '../hash.ts';
import { refuse } from '../errors.ts';
import type { SourceAdapter } from '../types.ts';
import type { CsvMapping } from '../tabular/types.ts';

export interface ProviderTableSnapshot {
  schema: string;
  account: { id: string; title: string };
  partial: boolean;
  notes: string[];
  rows: (string | number | null)[][];
}

/** Provider-specific schemas own the column meanings; cell content is always untrusted data. */
export function providerTable(id: string, columns: readonly string[], mapping: Omit<CsvMapping, 'account'>) {
  const schema = `${id}/v1`;
  const parse = (json: string): ProviderTableSnapshot => {
    let value: ProviderTableSnapshot;
    try { value = JSON.parse(json); } catch { refuse('invalid_provider_snapshot', 'The saved source cannot be read.'); }
    if (Buffer.byteLength(json) > 10 * 1024 * 1024 || value?.schema !== schema ||
        typeof value.account?.id !== 'string' || !value.account.id || value.account.id.length > 200 ||
        typeof value.account.title !== 'string' || !value.account.title || value.account.title.length > 256 ||
        typeof value.partial !== 'boolean' || !Array.isArray(value.notes) || value.notes.length > 20 || value.notes.some(note => typeof note !== 'string' || note.length > 2048) ||
        !Array.isArray(value.rows) || value.rows.length > 5000 || value.rows.some(row => !Array.isArray(row) || row.length !== columns.length ||
          row.some(cell => cell !== null && !(typeof cell === 'string' && Buffer.byteLength(cell) <= 8192) && !(typeof cell === 'number' && Number.isFinite(cell))))) {
      refuse('invalid_provider_snapshot', 'The saved source has unexpected fields.');
    }
    return value;
  };
  const source: SourceAdapter<string> = { id, format: 'json', read(json) {
    const value = parse(json);
    return { payload: json, payloadEncoding: 'original', format: 'json', columns,
      records: value.rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))), cursorAfter: null,
      provenance: { kind: 'api-fetch', label: `${id} source snapshot`, locator: `${id}:${value.account.id}`, declaredCoverage: value.partial ? 'partial' : 'complete' } };
  } };
  const csv = (json: string) => {
    const value = parse(json);
    const cell = (value: string | number | null) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    return { name: `${id}.csv`, mapping: { ...mapping, account: value.account.title },
      csv: value.rows.length ? [columns, ...value.rows].map(row => row.map(cell).join(',')).join('\n') + '\n' : null };
  };
  return { derive: { source, csv }, parse, serialize: (snapshot: Omit<ProviderTableSnapshot, 'schema'>) => {
    const json = canonicalJson({ ...snapshot, schema }); parse(json); return json;
  } };
}

export const mailchimpTable = providerTable('mailchimp', ['Campaign ID', 'Campaign', 'Subject', 'Sent at', 'Emails sent', 'Total opens', 'Unique opens', 'Total clicks', 'Unique clicks', 'Unsubscribes', 'Hard bounces', 'Soft bounces'],
  { kind: 'source-table', confirmed: true, platform: 'unspecified', columns: { postId: 'Campaign ID' } });
export const analyticsTable = providerTable('google-analytics', ['Record ID', 'Date', 'Channel', 'Sessions', 'Active users', 'Page and screen views', 'Engaged sessions', 'Property timezone'],
  { kind: 'source-table', confirmed: true, platform: 'unspecified', columns: { postId: 'Record ID' } });
export const linkedinTable = providerTable('linkedin', ['Post ID', 'Published', 'Post text', 'Post URL', 'Likes', 'Comments', 'Shares', 'Impressions', 'Clicks', 'Provider like count'],
  { confirmed: true, platform: 'linkedin', columns: { postId: 'Post ID', publishedAt: 'Published', likes: 'Likes', comments: 'Comments', shares: 'Shares', impressions: 'Impressions', clicks: 'Clicks' } });
