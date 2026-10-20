import { linkedinTable } from '../../data-layer/src/adapters/provider-table.ts';
import { HarnessError } from './errors.ts';
import { asObject, discoveryRequest, endpoint, grantKey, invalidProviderData, objectList, providerCount, providerJson, providerText, reconnectBy, type ProviderObject, type ProviderRequest } from './provider-reader.ts';
import type { SyncAdapter } from './sync-dispatch.ts';

const BASE = 'https://api.linkedin.com/rest/';
const ORG = /^urn:li:organization:(\d{1,30})$/;
const POST = /^urn:li:(share|ugcPost):\d{1,30}$/;
const SCOPES = ['r_organization_social', 'rw_organization_admin'];
const headers = { 'LinkedIn-Version': '202603', 'X-Restli-Protocol-Version': '2.0.0' };
const read = (request: ProviderRequest, path: string, query: Record<string, string> = {}) => providerJson(request, endpoint(BASE, path, query),
  { headers: { ...headers, ...(query.q ? { 'X-RestLi-Method': 'FINDER' } : {}) } });
function nextStart(result: ProviderObject, start: number, count: number): number | null {
  const paging = result.paging === undefined ? {} : asObject(result.paging);
  const next = objectList(paging.links ?? []).find(link => link.rel === 'next');
  if (next) {
    let url: URL;
    try { url = new URL(providerText(next.href, 4096)); } catch { throw invalidProviderData(); }
    const value = providerCount(url.searchParams.get('start'));
    if (url.origin !== 'https://api.linkedin.com' || value === null || value <= start || value > 10_000) throw invalidProviderData();
    return value;
  }
  const total = providerCount(paging.total);
  return total !== null && start + count < total ? start + count : null;
}
async function organizations(request: ProviderRequest) {
  const found = new Map<string, string>();
  let start: number | null = 0;
  for (let page = 0; start !== null && page < 10; page++) {
    const result = await read(request, 'organizationAcls', { q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED', count: '100', start: String(start) });
    const elements = objectList(result.elements);
    for (const item of elements) {
      const urn = providerText(item.organization ?? item.organizationTarget, 100), match = ORG.exec(urn);
      if (!match || item.state !== 'APPROVED' || item.role !== 'ADMINISTRATOR') throw invalidProviderData();
      found.set(match[1]!, urn);
    }
    const next = nextStart(result, start, elements.length);
    if ((next !== null && !elements.length) || found.size > 200) throw invalidProviderData();
    start = next;
  }
  if (start !== null) throw invalidProviderData();
  return found;
}
async function postMetrics(request: ProviderRequest, org: string, posts: ProviderObject[]) {
  const found = new Map<string, ProviderObject>();
  for (const type of ['share', 'ugcPost']) {
    const ids = posts.map(post => String(post.id)).filter(id => id.startsWith(`urn:li:${type}:`));
    for (let offset = 0; offset < ids.length; offset += 20) {
      const selected = ids.slice(offset, offset + 20);
      const result = await read(request, 'organizationalEntityShareStatistics', { q: 'organizationalEntity', organizationalEntity: org,
        [type === 'share' ? 'shares' : 'ugcPosts']: `List(${selected.join(',')})` });
      for (const item of objectList(result.elements)) {
        const id = providerText(item.share ?? item.ugcPost, 100);
        if (!selected.includes(id) || item.organizationalEntity !== org || found.has(id)) throw invalidProviderData();
        found.set(id, asObject(item.totalShareStatistics));
      }
    }
  }
  return found;
}
export function createLinkedInAdapter(options: { clientId: string; clientSecret: string; fetch?: typeof fetch; now?: () => number }): SyncAdapter {
  return { id: 'linkedin', label: 'LinkedIn', timeoutMs: 240_000, minSyncIntervalMs: 900_000, syncOnConnect: true, automaticDailySync: true,
    derive: linkedinTable.derive,
    oauth: { clientId: options.clientId, clientSecret: options.clientSecret, dataHosts: ['api.linkedin.com'], ...(options.fetch ? { fetch: options.fetch } : {}),
      provider: { id: 'linkedin', label: 'LinkedIn', pkce: false, implicitBearerToken: true,
        authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken', authorizeParams: { scope: SCOPES.join(' ') },
        validateTokens(tokens) {
          if (tokens.scope && !SCOPES.every(scope => tokens.scope!.split(/[ ,]+/).includes(scope))) throw new HarnessError('Allow access to company posts and page analytics.', 403, 'permission_missing');
        } },
      async accounts(context) {
        const request = discoveryRequest(context), found = await organizations(request), accounts = [];
        for (const id of found.keys()) {
          const organization = await read(request, `organizations/${id}`);
          if (String(organization.id) !== id) throw invalidProviderData();
          accounts.push({ provider: 'linkedin', accountId: id, displayName: providerText(organization.localizedName, 256).slice(0, 120),
            tokens: context.tokens, reconnectBy: reconnectBy(context.tokens) });
        }
        return { accounts, tokens: context.tokens, grantKey: grantKey('linkedin', options.clientId, [...found.keys()].sort().join(',')) };
      } },
    async acquire(context) {
      const id = context.connection.providerAccountId;
      if (!context.oauth || !/^\d{1,30}$/.test(id)) throw invalidProviderData();
      const request = context.oauth.request, org = `urn:li:organization:${id}`;
      if (!(await organizations(request)).has(id)) throw new HarnessError('Reconnect this company page with an administrator account.', 403, 'permission_missing');
      const posts: ProviderObject[] = [], seen = new Set<string>();
      const since = (options.now ?? Date.now)() - 90 * 86_400_000;
      let start: number | null = 0, partial = false;
      for (let page = 0; start !== null && page < 5; page++) {
        const result = await read(request, 'posts', { q: 'author', author: org, count: '100', start: String(start), sortBy: 'CREATED' });
        const elements = objectList(result.elements);
        if (elements.length > 100) throw invalidProviderData();
        for (const post of elements) {
          const postId = providerText(post.id, 100);
          if (!POST.test(postId) || post.author !== org || seen.has(postId)) throw invalidProviderData();
          seen.add(postId);
          const published = providerCount(post.publishedAt);
          if (post.lifecycleState === 'PUBLISHED' && published !== null && published >= since) posts.push(post);
        }
        start = nextStart(result, start, elements.length);
        if (start !== null && !elements.length) throw invalidProviderData();
      }
      partial = start !== null;
      const stats = await postMetrics(request, org, posts);
      const rows = posts.map(post => {
        const metrics = stats.get(String(post.id)) ?? {};
        const rawLikes = metrics.likeCount;
        if (rawLikes !== undefined && (typeof rawLikes !== 'number' || !Number.isSafeInteger(rawLikes))) throw invalidProviderData();
        return [String(post.id), new Date(Number(post.publishedAt)).toISOString(), providerText(post.commentary ?? '', 4096), `https://www.linkedin.com/feed/update/${post.id}/`,
          typeof rawLikes === 'number' && rawLikes < 0 ? null : providerCount(rawLikes), ...[metrics.commentCount, metrics.shareCount, metrics.impressionCount, metrics.clickCount].map(providerCount), rawLikes as number ?? null];
      }).sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en'));
      return { json: linkedinTable.serialize({ account: { id, title: context.connection.displayName }, partial, rows,
        notes: ['Organic lifetime counts for published company posts within 90 days, from at most 500 recent posts. Paid analytics are not included. Negative organic like adjustments remain in Provider like count, not Likes.'] }) };
    } };
}
