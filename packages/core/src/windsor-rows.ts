import { createHash } from 'node:crypto';
import { HarnessError } from './errors.ts';
import { invalidProviderData, objectList } from './provider-reader.ts';
import { windsorSource, type WindsorProvider } from './windsor-sources.ts';

export const windsorDenied = () => new HarnessError('Access to this account could not be verified. Connect it again.', 403, 'permission_missing');
export function windsorAccountId(value: unknown, provider: WindsorProvider): string {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw windsorDenied();
  const id = String(value), numeric = windsorSource(provider).numericAccount;
  if (!(numeric ? /^[0-9]{1,30}$/ : /^[A-Za-z0-9._:-]{1,200}$/).test(id)) throw windsorDenied();
  return id;
}

/** Validate the requested grain before retaining rows; keep provider values verbatim. */
export function windsorRows(value: unknown, provider: WindsorProvider, accountId: string) {
  const source = windsorSource(provider), records = objectList(value), seen = new Set<string>();
  if (records.length > 5000) throw invalidProviderData();
  return records.map(record => {
    if (windsorAccountId(record.account_id, provider) !== accountId) throw windsorDenied();
    const rawDate = record.date;
    if (typeof rawDate !== 'string' || !/^(\d{4}-\d{2}-\d{2}|\d{8})$/.test(rawDate)) throw invalidProviderData();
    const date = rawDate.length === 8 ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}` : rawDate;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw invalidProviderData();
    const grain = source.identity.map(field => {
      const value = record[field];
      if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw invalidProviderData();
      return value;
    });
    // Retain existing LinkedIn snapshot IDs; compound keys elsewhere cannot collide on delimiters.
    const id = provider === 'linkedin' ? `${date}:${grain[0]}` : createHash('sha256').update(JSON.stringify([accountId, date, ...grain])).digest('hex');
    if (seen.has(id)) throw invalidProviderData();
    seen.add(id);
    const cells = source.fields.map(field => {
      const value = record[field] ?? null;
      if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) throw invalidProviderData();
      return value as string | number | null;
    });
    return [id, ...cells];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en'));
}
