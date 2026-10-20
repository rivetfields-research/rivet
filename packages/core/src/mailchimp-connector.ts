import { mailchimpTable } from '../../data-layer/src/adapters/provider-table.ts';
import { HarnessError } from './errors.ts';
import { asObject, discoveryRequest, endpoint, grantKey, invalidProviderData, objectList, providerCount, providerJson, providerText, type ProviderObject, type ProviderRequest } from './provider-reader.ts';
import type { SyncAdapter } from './sync-dispatch.ts';

const DC = /^us[1-9]\d{0,2}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,100}$/;
export const mailchimpDataHost = (host: string) => /^us[1-9]\d{0,2}\.api\.mailchimp\.com$/.test(host);
const base = (dc: string) => `https://${dc}.api.mailchimp.com/3.0/`;
const fields = 'id,campaign_title,subject_line,send_time,emails_sent,opens.opens_total,opens.unique_opens,clicks.clicks_total,clicks.unique_clicks,unsubscribed,bounces.hard_bounces,bounces.soft_bounces';
async function identity(request: ProviderRequest, dc: string) {
  const value = await providerJson(request, endpoint(base(dc), './', { fields: 'account_id,account_name' }));
  const id = providerText(value.account_id, 100);
  if (!ACCOUNT.test(id)) throw invalidProviderData();
  return { id, title: providerText(value.account_name, 256).slice(0, 120) || 'Mailchimp account' };
}
function campaign(value: ProviderObject): (string | number | null)[] {
  const id = providerText(value.id, 100);
  const sent = providerText(value.send_time, 100);
  if (!ACCOUNT.test(id) || !Number.isFinite(Date.parse(sent))) throw invalidProviderData();
  const opens = value.opens === undefined ? {} : asObject(value.opens);
  const clicks = value.clicks === undefined ? {} : asObject(value.clicks);
  const bounces = value.bounces === undefined ? {} : asObject(value.bounces);
  return [id, providerText(value.campaign_title ?? '', 2048), providerText(value.subject_line ?? '', 2048), sent,
    ...[value.emails_sent, opens.opens_total, opens.unique_opens, clicks.clicks_total, clicks.unique_clicks,
      value.unsubscribed, bounces.hard_bounces, bounces.soft_bounces].map(providerCount)];
}
export function createMailchimpAdapter(options: { clientId: string; clientSecret: string; fetch?: typeof fetch; now?: () => number }): SyncAdapter {
  return { id: 'mailchimp', label: 'Mailchimp', timeoutMs: 180_000, minSyncIntervalMs: 900_000, syncOnConnect: true, automaticDailySync: true,
    derive: mailchimpTable.derive,
    oauth: { clientId: options.clientId, clientSecret: options.clientSecret, ...(options.fetch ? { fetch: options.fetch } : {}),
      provider: { id: 'mailchimp', label: 'Mailchimp', pkce: false, authorizeParams: {}, nonExpiringTokens: true, implicitBearerToken: true, nullableTokenScope: true,
        authorizeUrl: 'https://login.mailchimp.com/oauth2/authorize', tokenUrl: 'https://login.mailchimp.com/oauth2/token', allowDataHost: mailchimpDataHost },
      async accounts(context) {
        const metadata = await providerJson(discoveryRequest(context, 'OAuth'), 'https://login.mailchimp.com/oauth2/metadata');
        const dc = providerText(metadata.dc, 6);
        if (!DC.test(dc)) throw invalidProviderData();
        // Never follow api_endpoint from the response: construct the regional host ourselves.
        const account = await identity(discoveryRequest(context), dc);
        const accountId = `${dc}:${account.id}`;
        return { tokens: context.tokens, grantKey: grantKey('mailchimp', options.clientId, accountId), accounts: [
          { provider: 'mailchimp', accountId, displayName: account.title, tokens: context.tokens, reconnectBy: null },
        ] };
      } },
    async acquire(context) {
      const [dc, id, extra] = context.connection.providerAccountId.split(':');
      if (!context.oauth || !dc || !DC.test(dc) || !id || !ACCOUNT.test(id) || extra !== undefined) throw invalidProviderData();
      const account = await identity(context.oauth.request, dc);
      if (account.id !== id) throw new HarnessError('Reconnect the selected Mailchimp account.', 403, 'permission_missing');
      const since = new Date((options.now ?? Date.now)() - 90 * 86_400_000).toISOString();
      const rows: (string | number | null)[][] = [], seen = new Set<string>();
      let partial = false;
      let expectedTotal: number | undefined;
      for (let offset = 0; offset < 500; offset += 100) {
        const result = await providerJson(context.oauth.request, endpoint(base(dc), 'reports', { count: '100', offset: String(offset), since_send_time: since,
          fields: `${fields.split(',').map(field => `reports.${field}`).join(',')},total_items` }));
        const total = providerCount(result.total_items), reports = objectList(result.reports);
        if (total === null || reports.length > 100 || offset + reports.length > total ||
            (!reports.length && offset < total) || (expectedTotal !== undefined && total !== expectedTotal)) throw invalidProviderData();
        expectedTotal = total;
        for (const report of reports) {
          const row = campaign(report);
          if (seen.has(String(row[0]))) throw invalidProviderData();
          seen.add(String(row[0])); rows.push(row);
        }
        if (offset + reports.length >= total) break;
        if (reports.length !== 100) throw invalidProviderData();
        if (offset === 400) partial = true;
      }
      rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en'));
      return { json: mailchimpTable.serialize({ account: { ...account, id: `${dc}:${id}` }, partial, rows,
        notes: ['Lifetime tracked totals for campaigns sent in the last 90 days; at most 500 campaigns. Opens and clicks may include automated activity. No subscriber-level data is collected.'] }) };
    } };
}
