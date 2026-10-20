import { providerTable } from '../../data-layer/src/adapters/provider-table.ts';
import { HarnessError } from './errors.ts';
import { boundedRequest } from './oauth.ts';
import { asObject, invalidProviderData, objectList } from './provider-reader.ts';
import type { SyncAdapter } from './sync-dispatch.ts';
import { windsorSource, type WindsorProvider } from './windsor-sources.ts';
import { windsorAccountId, windsorDenied as denied, windsorRows } from './windsor-rows.ts';

const ONBOARD = 'https://onboard.windsor.ai';

export function windsorAuthorization(value: unknown, provider: WindsorProvider = 'linkedin'): { url: string; token: string } {
  const raw = typeof value === 'string' ? value : asObject(value).url;
  let url: URL;
  try { url = new URL(typeof raw === 'string' ? raw : ''); } catch { throw invalidProviderData(); }
  const token = url.searchParams.get('access_token') ?? '';
  if (url.origin !== ONBOARD || url.pathname !== '/co-user-login' || url.username || url.password || url.hash ||
      url.searchParams.get('allowed_sources') !== windsorSource(provider).source || !/^[A-Za-z0-9_-]{16,2048}$/.test(token) ||
      [...url.searchParams.keys()].some(key => !['access_token', 'allowed_sources'].includes(key)) ||
      url.searchParams.getAll('access_token').length !== 1 || url.searchParams.getAll('allowed_sources').length !== 1) throw invalidProviderData();
  return { url: url.href, token };
}

/** Installation key never leaves this closure; each saved connection supplies its own customer grant. */
export function createWindsorAdapter(provider: WindsorProvider, options: { apiKey: string; fetch?: typeof fetch; now?: () => number }): SyncAdapter {
  if (!options.apiKey || options.apiKey.length > 2048 || /\s/.test(options.apiKey)) throw new Error('Configure a Windsor API key.');
  const source = windsorSource(provider), id = `windsor-${provider}`;
  const table = providerTable(id, ['Record ID', ...source.fields],
    { kind: 'source-table', confirmed: true, platform: source.platform, columns: { postId: 'Record ID' } });
  const read = async (path: string, query: Record<string, string>, signal: AbortSignal, stage: 'begin' | 'accounts' | 'collection'): Promise<unknown> => {
    const collection = stage === 'collection';
    const url = new URL(path, collection ? 'https://connectors.windsor.ai' : ONBOARD);
    for (const [key, value] of Object.entries({ ...query, api_key: options.apiKey })) url.searchParams.set(key, value);
    const failed = () => new HarnessError('The source connection could not complete the request. Try again.', 502, 'provider_error');
    const response = await boundedRequest(options.fetch ?? fetch, url.href, { headers: { Accept: 'application/json' } }, {
      signal, timeoutMs: collection ? 90_000 : 15_000, limit: collection ? 8 * 1024 * 1024 : 256 * 1024,
      errors: { cancelled: failed, unreachable: failed, unreadable: failed, tooLarge: invalidProviderData },
    });
    if (response.status === 429) throw new HarnessError('The source connection is limiting requests. Try again shortly.', 429, 'rate_limited');
    // An upstream refusal does not establish that the customer's grant was revoked.
    if (response.status === 401 || response.status === 403) throw stage === 'begin'
      ? new HarnessError('Connection setup needs attention. A Rivet administrator must check the connector configuration.', 502, 'credential_setup_required')
      : new HarnessError('The source refused the access check. Try again; if it keeps failing, review the connection permissions.', 502, 'provider_error');
    if (!response.ok) throw failed();
    try { return JSON.parse(response.body); } catch { throw invalidProviderData(); }
  };
  const accounts = async (token: string, signal: AbortSignal) => {
    if (!/^[A-Za-z0-9_-]{16,2048}$/.test(token)) throw denied();
    const result = await read('/api/team/co-user-linked-accounts/', { ds_id: source.source, access_token: token }, signal, 'accounts');
    const rows = objectList(Array.isArray(result) ? result : asObject(result).data);
    if (rows.length > 100) throw invalidProviderData();
    return rows.map(row => {
      // Never use a global account list or legacy member name as evidence of ownership.
      if (row.datasource !== source.source || row.access_token !== token) throw denied();
      const accountId = windsorAccountId(row.account_id, provider);
      const displayName = typeof row.account_name === 'string' && row.account_name.trim() ? row.account_name.trim() : `${source.label} ${accountId}`;
      if (displayName.length > 160) throw invalidProviderData();
      return { accountId, displayName };
    });
  };
  return { id, sourceProvider: source.sourceProvider, label: source.label, credential: 'api_token',
    timeoutMs: 120_000, minSyncIntervalMs: 900_000, syncOnConnect: true, automaticDailySync: true, derive: table.derive,
    broker: { async begin(signal) { return windsorAuthorization(await read('/api/team/generate-co-user-url/', { allowed_sources: source.source }, signal, 'begin'), provider); }, accounts },
    async acquire(context) {
      const token = context.apiToken?.(), accountId = context.connection.providerAccountId;
      if (!token || windsorAccountId(accountId, provider) !== accountId || !(await accounts(token, context.signal)).some(account => account.accountId === accountId)) throw denied();
      const now = (options.now ?? Date.now)() - (source.completedDays ? 86_400_000 : 0);
      const date = (time: number) => new Date(time).toISOString().slice(0, 10);
      const result = asObject(await read(`/${source.source}`, { select_accounts: accountId, fields: source.fields.join(','),
        date_from: date(now - 29 * 86_400_000), date_to: date(now), _renderer: 'json', _max_rows: '5000' }, context.signal, 'collection'));
      const rows = windsorRows(result.data, provider, accountId);
      // Check authorization again after the potentially slow collection before retaining any data.
      if (!(await accounts(token, context.signal)).some(account => account.accountId === accountId)) throw denied();
      return { json: table.serialize({ account: { id: accountId, title: context.connection.displayName }, partial: true, rows,
        notes: [source.notes, 'Requested window: 30 days. At most 5,000 rows. Coverage is unverified; no full-history claim. Missing values remain missing.'] }) };
    },
  };
}

export const createWindsorLinkedInAdapter = (options: Parameters<typeof createWindsorAdapter>[1]) => createWindsorAdapter('linkedin', options);
