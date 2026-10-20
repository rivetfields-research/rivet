import { createHash } from 'node:crypto';
import { analyticsTable } from '../../data-layer/src/adapters/provider-table.ts';
import { discoveryRequest, endpoint, googleProvider, grantKey, invalidProviderData, nextToken, objectList, providerCount, providerJson, providerText, reconnectBy, asObject } from './provider-reader.ts';
import type { SyncAdapter } from './sync-dispatch.ts';

const ADMIN = 'https://analyticsadmin.googleapis.com/v1alpha/';
const PROPERTY = /^properties\/(\d{1,30})$/;
const DIMENSIONS = ['date', 'sessionDefaultChannelGroup'];
const METRICS = ['sessions', 'activeUsers', 'screenPageViews', 'engagedSessions'];
export function createAnalyticsAdapter(options: { clientId: string; clientSecret: string; fetch?: typeof fetch }): SyncAdapter {
  return { id: 'google-analytics', label: 'Google Analytics', timeoutMs: 180_000, minSyncIntervalMs: 900_000, syncOnConnect: true, automaticDailySync: true,
    derive: analyticsTable.derive,
    oauth: { clientId: options.clientId, clientSecret: options.clientSecret, ...(options.fetch ? { fetch: options.fetch } : {}),
      dataHosts: ['analyticsadmin.googleapis.com', 'analyticsdata.googleapis.com'],
      provider: googleProvider('google-analytics', 'Google Analytics', 'https://www.googleapis.com/auth/analytics.readonly'),
      async accounts(context) {
        const accounts = [], pages = new Set<string>(), ids = new Set<string>();
        let pageToken = '';
        do {
          const result = await providerJson(discoveryRequest(context), endpoint(ADMIN, 'accountSummaries', { pageSize: '200', ...(pageToken ? { pageToken } : {}) }));
          for (const account of objectList(result.accountSummaries ?? [])) for (const property of objectList(account.propertySummaries ?? [])) {
            const match = PROPERTY.exec(providerText(property.property, 60));
            if (!match || ids.has(match[1]!)) throw invalidProviderData();
            ids.add(match[1]!);
            accounts.push({ provider: 'google-analytics', accountId: match[1]!, displayName: providerText(property.displayName, 256).slice(0, 120),
              tokens: context.tokens, reconnectBy: reconnectBy(context.tokens) });
          }
          pageToken = nextToken(result.nextPageToken, pages);
          if (pages.size > 10 || accounts.length > 200) throw invalidProviderData();
        } while (pageToken);
        return { tokens: context.tokens, accounts, grantKey: grantKey('google-analytics', options.clientId, [...ids].sort().join(',')) };
      } },
    async acquire(context) {
      const id = context.connection.providerAccountId;
      if (!context.oauth || !/^\d{1,30}$/.test(id)) throw invalidProviderData();
      const property = await providerJson(context.oauth.request, endpoint(ADMIN, `properties/${id}`));
      if (property.name !== `properties/${id}`) throw invalidProviderData();
      const timezone = providerText(property.timeZone, 100);
      const account = { id, title: providerText(property.displayName, 256).slice(0, 120) };
      const rows: (string | number | null)[][] = [], ids = new Set<string>();
      let partial = false;
      let expectedTotal: number | undefined;
      for (let offset = 0; offset < 5000; offset += 1000) {
        const result = await providerJson(context.oauth.request, `https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            dateRanges: [{ startDate: '90daysAgo', endDate: 'yesterday' }], dimensions: DIMENSIONS.map(name => ({ name })), metrics: METRICS.map(name => ({ name })),
            orderBys: DIMENSIONS.map(dimensionName => ({ dimension: { dimensionName } })), offset: String(offset), limit: '1000', keepEmptyRows: true,
          }) });
        if (JSON.stringify(objectList(result.dimensionHeaders).map(header => header.name)) !== JSON.stringify(DIMENSIONS) ||
            JSON.stringify(objectList(result.metricHeaders).map(header => header.name)) !== JSON.stringify(METRICS)) throw invalidProviderData();
        const metadata = result.metadata === undefined ? {} : asObject(result.metadata);
        partial ||= metadata.dataLossFromOtherRow === true || metadata.subjectToThresholding === true || objectList(metadata.samplingMetadatas ?? []).length > 0;
        const returned = objectList(result.rows ?? []), total = providerCount(result.rowCount ?? 0);
        if (total === null || returned.length > 1000 || offset + returned.length > total ||
            (!returned.length && offset < total) || (expectedTotal !== undefined && total !== expectedTotal)) throw invalidProviderData();
        expectedTotal = total;
        for (const row of returned) {
          const dimensions = objectList(row.dimensionValues).map(value => providerText(value.value, 1024));
          const values = objectList(row.metricValues).map(value => providerCount(value.value));
          if (dimensions.length !== 2 || values.length !== 4 || !/^\d{8}$/.test(dimensions[0]!)) throw invalidProviderData();
          const recordId = createHash('sha256').update(JSON.stringify(dimensions)).digest('hex');
          if (ids.has(recordId)) throw invalidProviderData();
          ids.add(recordId); rows.push([recordId, ...dimensions, ...values, timezone]);
        }
        if (offset + returned.length >= total) break;
        if (returned.length !== 1000) throw invalidProviderData();
        if (offset === 4000) partial = true;
      }
      return { json: analyticsTable.serialize({ account, partial, rows, notes: ['Last 90 completed days in the property timezone; at most 5,000 date/channel rows. Active users are not additive across days or channels. Thresholded, sampled or capped results are partial.'] }) };
    } };
}
