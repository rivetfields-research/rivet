import { createHash, createHmac } from 'node:crypto';
import { canonicalJson } from '../../data-layer/src/hash.ts';
import { deriveMetaGraphCsv, META_GRAPH_SCHEMA, metaGraphAdapter, type MetaGraphPost, type MetaGraphSnapshot, type MetaProduct } from '../../data-layer/src/adapters/meta-graph.ts';
import { HarnessError } from './errors.ts';
import type { BoundedResponse, OAuthProviderDefinition, OAuthTokens } from './oauth.ts';
import type { SignInAccount, SignInDiscovery, SyncAdapter, SyncAdapterContext, SyncAdapterOAuth } from './sync-dispatch.ts';

/*
 * Meta connector (M8): Instagram professional accounts and Facebook Pages through one Facebook Login for Business
 * sign-in, implemented strictly from docs/CONNECTOR_PROVIDER_FACTS.md.
 *
 *   - Graph API pinned to v26.0 on graph.facebook.com; the login dialog on www.facebook.com (facts MV-01, ML-01).
 *   - `config_id`, never `scope` (MT-06). The configuration must hold only the read permissions in facts section 2.
 *   - Long-lived (~60-day) user token for Instagram; Page tokens for Pages (MT-02, MT-03). No server-side refresh
 *     (MT-04): `debug_token` gives "Reconnect by" (MT-08).
 *   - `appsecret_proof` on every authorized call (MT-11), added by the OAuth core.
 *   - Only the endpoints and metrics in facts section 8. No `*impressions*` metric is ever requested (MM-01, MM-08).
 *   - Error classification from facts section 5.
 *
 * Nothing here logs. Error messages are fixed text; a provider's own error text never leaves this module. Tokens
 * never reach the snapshot, which holds only the requested fields and metric values.
 */

export const META_GRAPH_VERSION = 'v26.0';
export const META_PROVIDER_ID = 'meta';
/** Production hosts. The `origins` option exists only for tests registering adapters in code with a loopback fake. */
export const META_ORIGINS = Object.freeze({ graph: 'https://graph.facebook.com', www: 'https://www.facebook.com' });
/** Facts section 2: the minimum read set (plus `pages_read_user_content` if the consent flow adds it, U-11). */
export const META_READ_PERMISSIONS = Object.freeze(['pages_show_list', 'pages_read_engagement', 'read_insights', 'instagram_basic', 'instagram_manage_insights', 'pages_read_user_content']);
export const META_INSTAGRAM_METRICS = Object.freeze(['likes', 'comments', 'shares', 'saved', 'reach', 'views']);
export const META_PAGE_METRICS = Object.freeze(['post_reactions_by_type_total', 'post_media_view', 'post_total_media_view_unique']);
export const META_LABELS: Readonly<Record<MetaProduct, string>> = Object.freeze({ instagram: 'Instagram professional account', facebook: 'Facebook Page' });
/** One acquisition: about 2 × (1 + ⌈N/100⌉ + N) calls for N ≤ 500 posts (facts section 5). */
export const META_SYNC_TIMEOUT_MS = 5 * 60_000;
/** "Sync now" for one account at most every 15 minutes: Meta's limits are real (MR-01, MR-02). */
export const META_SYNC_NOW_INTERVAL_MS = 15 * 60_000;
const DEFAULT_WINDOW = Object.freeze({ days: 90, maxPosts: 500 });
const THROTTLE_CODES = new Set([4, 17, 32, 341, 613, 80001, 80002]);
const TOKEN_SUBCODES = new Set([458, 459, 460, 463, 464, 467, 492]);
const INSIGHTS_CONCURRENCY = 4;

export interface MetaConnectorOptions {
  appId: string;
  appSecret: string;
  configId: string;
  /** Which products this runtime offers (HARNESS_CONNECTOR_INSTAGRAM, HARNESS_CONNECTOR_FACEBOOK). */
  products: readonly MetaProduct[];
  /** Tests only: loopback fake Graph and login origins. A hosted runtime refuses plain-HTTP origins anyway. */
  origins?: { graph: string; www: string };
  /** Tests only: the fetch the OAuth client uses for every Meta request. */
  fetch?: typeof globalThis.fetch;
  /** Tests only: a smaller read window. */
  window?: { days: number; maxPosts: number };
  /** Tests only: the clock for the read window and token facts, and a fast back-off. */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Tests only: a shorter "Sync now" interval, so a browser journey can repeat within minutes. */
  syncNowIntervalMs?: number;
}

const fail = (code: string, status = 502) => {
  const messages: Record<string, string> = {
    oauth_failed: 'Meta sign-in could not be completed. Start again.',
    oauth_expired: 'Meta authorization expired or was revoked. Reconnect the account.',
    rate_limited: 'Meta is limiting requests for this account right now. The next sync will try again.',
    permission_missing: 'Meta did not grant a permission this connection needs. Reconnect and allow the requested access.',
    provider_blocked: 'Meta blocked this request for the account.',
    provider_error: 'Meta could not be read. The next sync will try again.',
    provider_invalid_result: 'Meta returned data this workspace cannot import.',
  };
  return new HarnessError(messages[code] ?? messages.provider_error!, status, code);
};
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const ID = /^[0-9]{1,40}(_[0-9]{1,40})?$/;
const TOKEN = /^[A-Za-z0-9._|-]{8,4096}$/;
const parse = (response: BoundedResponse): Record<string, unknown> | undefined => {
  if (response.truncated) return undefined;
  try { const value: unknown = JSON.parse(response.body); return isObject(value) ? value : undefined; } catch { return undefined; }
};
/** Use only the cursor; a provider-supplied next URL may contain credentials or a foreign host. */
function afterCursor(body: Record<string, unknown>, seen: Set<string>): string | undefined {
  if (body.paging === undefined) return undefined;
  if (!isObject(body.paging)) throw fail('provider_invalid_result', 422);
  if (body.paging.next === undefined || body.paging.next === null) return undefined;
  const cursors = isObject(body.paging.cursors) ? body.paging.cursors : undefined;
  if (typeof body.paging.next !== 'string' || !body.paging.next || typeof cursors?.after !== 'string' ||
      !/^[A-Za-z0-9_=-]{1,512}$/.test(cursors.after) || seen.has(cursors.after)) throw fail('provider_invalid_result', 422);
  seen.add(cursors.after);
  return cursors.after;
}
const publicationTime = (value: unknown): number => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) throw fail('provider_invalid_result', 422);
  const time = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(time) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) throw fail('provider_invalid_result', 422);
  return time / 1000;
};
function insightValues(body: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  if (!Array.isArray(body.data) || body.data.length > allowed.length) throw fail('provider_invalid_result', 422);
  const values: Record<string, unknown> = {}, seen = new Set<string>();
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  for (const metric of body.data) {
    if (!isObject(metric) || typeof metric.name !== 'string' || !allowed.includes(metric.name) || seen.has(metric.name) ||
        (metric.values !== undefined && (!Array.isArray(metric.values) || metric.values.length > 1 || metric.values.some(value => !isObject(value)))) ||
        (metric.total_value !== undefined && (!isObject(metric.total_value) || metric.values !== undefined))) throw fail('provider_invalid_result', 422);
    seen.add(metric.name);
    const value = Array.isArray(metric.values) ? metric.values[0]?.value : isObject(metric.total_value) ? metric.total_value.value : undefined;
    // An omitted or null metric stays missing; a malformed value must not become a successful blank cell.
    if (value === undefined || value === null) continue;
    if (metric.name === 'post_reactions_by_type_total') {
      if (!isObject(value) || !Object.values(value).every(count) ||
          !Number.isSafeInteger((Object.values(value) as number[]).reduce((sum, item) => sum + item, 0))) throw fail('provider_invalid_result', 422);
    } else if (!count(value)) throw fail('provider_invalid_result', 422);
    values[metric.name] = value;
  }
  return values;
}
const graphError = (body: Record<string, unknown> | undefined) => {
  const error = isObject(body?.error) ? body.error : {};
  return { code: Number(error.code), subcode: Number(error.error_subcode) };
};
/** `X-Business-Use-Case-Usage` → the longest `estimated_time_to_regain_access` (minutes) in milliseconds (facts MR-03). */
export function metaRegainMs(headers: BoundedResponse['headers']): number | null {
  const header = headers?.['x-business-use-case-usage'];
  if (!header) return null;
  try {
    const value: unknown = JSON.parse(header);
    let minutes = 0;
    if (isObject(value)) for (const entries of Object.values(value)) {
      if (Array.isArray(entries)) for (const entry of entries) {
        const time = isObject(entry) ? entry.estimated_time_to_regain_access : undefined;
        if (typeof time === 'number' && Number.isFinite(time) && time > minutes) minutes = time;
      }
    }
    return minutes > 0 ? Math.min(minutes, 24 * 60) * 60_000 : null;
  } catch { return null; }
}
const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', onAbort, { once: true });
});
/** A readable, bounded label from a name the provider controls. */
const label = (value: unknown, fallback: string) => {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (text || fallback).slice(0, 120);
};
export const metaGrantKey = (userId: string) => createHash('sha256').update(`meta:${userId}`).digest('hex').slice(0, 32);

/** Classifies a Graph error (facts section 5). Returns only for "this metric is not available for this post". */
type GraphFailure = { kind: 'throttle'; regainMs: number | null } | { kind: 'transient' } | { kind: 'unsupported'; permission: boolean };
function classify(response: BoundedResponse, body: Record<string, unknown> | undefined, insights: boolean, invalidate: () => void): GraphFailure {
  const { code, subcode } = graphError(body);
  if (response.status === 429 || THROTTLE_CODES.has(code)) return { kind: 'throttle', regainMs: metaRegainMs(response.headers) };
  if (code === 1 || code === 2) return { kind: 'transient' };
  if (code === 190 || code === 102 || TOKEN_SUBCODES.has(subcode)) { invalidate(); throw fail('oauth_expired', 401); }
  if (response.status >= 500 && response.status <= 599) return { kind: 'transient' };
  const permission = code === 10 || (code >= 200 && code <= 299);
  // Per-post insights: a refused metric (MR-07, U-7) stays missing for that post; an account-wide permission gap is
  // recognised when every post is refused this way (see `insightsFor`).
  if (insights && (code === 100 || permission)) return { kind: 'unsupported', permission };
  // The token itself is still valid: it stays sealed, so a disconnect can still revoke it, and Needs attention asks for
  // a reconnect that grants the missing permission (renewed in place).
  if (permission) throw fail('permission_missing', 403);
  if (code === 368) throw fail('provider_blocked', 403);
  throw fail('provider_error');
}

/** Builds the sign-in definition, discovery and the two product adapters. Only enabled products get an adapter. */
export function createMetaAdapters(options: MetaConnectorOptions): SyncAdapter[] {
  if (!options || typeof options !== 'object' || typeof options.appId !== 'string' || !/^[0-9]{5,30}$/.test(options.appId) ||
      typeof options.appSecret !== 'string' || !/^[A-Za-z0-9]{16,128}$/.test(options.appSecret) ||
      typeof options.configId !== 'string' || !/^[0-9]{5,30}$/.test(options.configId) ||
      !Array.isArray(options.products) || options.products.some(product => product !== 'instagram' && product !== 'facebook')) {
    throw new HarnessError('Meta needs its app ID, app secret and Facebook Login for Business configuration ID.', 400, 'invalid_connections');
  }
  const origins = options.origins ?? META_ORIGINS;
  const graph = `${origins.graph}/${META_GRAPH_VERSION}`;
  const window = options.window ?? DEFAULT_WINDOW;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const appToken = `${options.appId}|${options.appSecret}`;
  const syncNowInterval = options.syncNowIntervalMs ?? META_SYNC_NOW_INTERVAL_MS;
  /** `appsecret_proof` for a user token on calls this module makes itself (MT-11); the OAuth core adds it to sync calls. */
  const proofFor = (token: string) => createHmac('sha256', options.appSecret).update(token).digest('hex');
  const permissionsOf = (tokens: OAuthTokens) => {
    const granted = (tokens.scope ?? '').split(/[\s,]+/).filter(item => META_READ_PERMISSIONS.includes(item));
    return granted.length ? granted : META_READ_PERMISSIONS.slice(0, 5);
  };
  const provider: OAuthProviderDefinition = Object.freeze({
    id: META_PROVIDER_ID, label: 'Meta',
    authorizeUrl: `${origins.www}/${META_GRAPH_VERSION}/dialog/oauth`,
    tokenUrl: `${graph}/oauth/access_token`,
    // Facebook Login for Business: the configuration names the permissions; `scope` is never sent (MT-06).
    authorizeParams: Object.freeze({ config_id: options.configId }),
    pkce: false,
    localHost: 'localhost' as const,
    appSecretProof: true,
    // MT-09: one DELETE per granted permission, with the app token for the person who granted them. Without a known
    // user ID (an unsaved grant), the person's own token revokes through `me`.
    revokeRequest: (tokens: OAuthTokens) => permissionsOf(tokens).map(permission => tokens.providerUserId && ID.test(tokens.providerUserId)
      ? { url: `${graph}/${tokens.providerUserId}/permissions/${permission}`, init: { method: 'DELETE', headers: { Authorization: `Bearer ${appToken}`, Accept: 'application/json' } } }
      : { url: `${graph}/me/permissions/${permission}?appsecret_proof=${proofFor(tokens.accessToken)}`, init: { method: 'DELETE', headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' } } }),
  });

  /** After the exchange: long-lived token, its facts, and the Pages and linked Instagram accounts to pick from. */
  const accounts: NonNullable<SyncAdapterOAuth['accounts']> = async context => {
    let stage = 'meta_token_exchange_failed';
    const failedStage = () => new HarnessError('Meta sign-in could not be completed. Start again.', 400, stage);
    const get = async (url: string, bearer?: string) => {
      const response = await context.request(url, { method: 'GET', headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } }, { limit: 1_048_576, timeoutMs: 15_000 });
      const body = parse(response);
      if (!response.ok || !body || body.error) {
        const { code } = graphError(body);
        if (response.status === 429 || THROTTLE_CODES.has(code)) throw fail('rate_limited', 429);
        throw failedStage();
      }
      return body;
    };
    // MT-02: exchange the short-lived token server-side for a long-lived one.
    const exchange = new URL(`${graph}/oauth/access_token`);
    exchange.search = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: options.appId, client_secret: options.appSecret, fb_exchange_token: context.tokens.accessToken }).toString();
    const longLived = await get(exchange.toString());
    if (typeof longLived.access_token !== 'string' || !TOKEN.test(longLived.access_token)) throw failedStage();
    const userToken = longLived.access_token;
    // MT-08: who granted it, which permissions, and when it (and data access) ends.
    stage = 'meta_token_inspection_failed';
    const debug = new URL(`${graph}/debug_token`);
    debug.search = new URLSearchParams({ input_token: userToken }).toString();
    const facts = (await get(debug.toString(), appToken)).data;
    if (!isObject(facts) || facts.is_valid !== true || String(facts.app_id) !== options.appId || typeof facts.user_id !== 'string' || !ID.test(facts.user_id)) throw failedStage();
    const userId = facts.user_id;
    const scopes = Array.isArray(facts.scopes) ? facts.scopes.filter((item): item is string => typeof item === 'string' && /^[a-z_]{1,60}$/.test(item)) : [];
    const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : null;
    const issuedAt = now();
    const expiresAt = seconds(facts.expires_at) ?? (typeof longLived.expires_in === 'number' && longLived.expires_in > 0 ? issuedAt + longLived.expires_in * 1000 : null);
    const dataAccessEnds = seconds(facts.data_access_expires_at);
    const scope = scopes.join(' ');
    const userTokens: OAuthTokens = { accessToken: userToken, obtainedAt: issuedAt, providerUserId: userId, ...(scope ? { scope } : {}), ...(expiresAt ? { expiresAt } : {}) };
    const found: SignInAccount[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>(), pageIds = new Set<string>();
    // Facts section 8, "At connect": one page of up to 100 Pages, then the `after` cursor, at most five pages.
    stage = 'meta_accounts_failed';
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const list = new URL(`${graph}/me/accounts`);
      list.search = new URLSearchParams({ fields: 'id,name,access_token,tasks,instagram_business_account{id,username}', limit: '100',
        ...(after ? { after } : {}), appsecret_proof: proofFor(userToken) }).toString();
      const body = await get(list.toString(), userToken);
      if (!Array.isArray(body.data) || body.data.length > 100) throw fail('provider_invalid_result', 422);
      for (const item of body.data) {
        if (!isObject(item) || typeof item.id !== 'string' || !ID.test(item.id) || pageIds.has(item.id)) throw fail('provider_invalid_result', 422);
        pageIds.add(item.id);
        const tasks = Array.isArray(item.tasks) ? item.tasks : [];
        // MA-08: Page insights need the ANALYZE task; a Page without it is not offered.
        if (options.products.includes('facebook') && typeof item.access_token === 'string' && TOKEN.test(item.access_token) && tasks.includes('ANALYZE') && !seen.has(`facebook:${item.id}`)) {
          seen.add(`facebook:${item.id}`);
          found.push({ provider: 'facebook', accountId: item.id, displayName: `${label(item.name, `Page ${item.id}`)} · Facebook Page`,
            // A Page token from a long-lived user token does not expire (MT-03); data access may (MT-05).
            tokens: { accessToken: item.access_token, obtainedAt: issuedAt, providerUserId: userId, ...(scope ? { scope } : {}) },
            reconnectBy: dataAccessEnds });
        }
        const linked = isObject(item.instagram_business_account) ? item.instagram_business_account : undefined;
        if (options.products.includes('instagram') && linked && typeof linked.id === 'string' && ID.test(linked.id) && !seen.has(`instagram:${linked.id}`)) {
          seen.add(`instagram:${linked.id}`);
          found.push({ provider: 'instagram', accountId: linked.id,
            displayName: `${typeof linked.username === 'string' && linked.username ? `@${label(linked.username, linked.id)}` : `Instagram ${linked.id}`} · Instagram`,
            tokens: { ...userTokens },
            reconnectBy: [expiresAt, dataAccessEnds].filter((value): value is number => value !== null).reduce<number | null>((min, value) => min === null || value < min ? value : min, null) });
        }
      }
      after = afterCursor(body, cursors);
      if (!after) break;
    }
    const discovery: SignInDiscovery = { grantKey: metaGrantKey(userId), accounts: found, tokens: userTokens };
    return discovery;
  };
  const oauth: SyncAdapterOAuth = Object.freeze({ provider, clientId: options.appId, clientSecret: options.appSecret,
    ...(options.fetch ? { fetch: options.fetch } : {}), accounts });

  /**
   * One acquisition's shared Graph state (M8 security review). `gate` is set while Meta is throttling: every request
   * waits for it, so nothing calls Graph during a throttle (MR-03). `stop` ends every concurrent request and worker as
   * soon as one fails. The wait budget (three throttle waits) is shared by the whole acquisition.
   */
  type GraphRun = { stop: AbortController; signal: AbortSignal; gate: Promise<void> | null; throttled: number; backoff: number };
  const graphRun = (context: SyncAdapterContext): GraphRun => {
    const stop = new AbortController();
    return { stop, signal: AbortSignal.any([context.signal, stop.signal]), gate: null, throttled: 0, backoff: 2_000 };
  };
  /** One Graph GET with the classification above, backing off within the attempt's bound. */
  async function graphGet(run: GraphRun, context: SyncAdapterContext, path: string, params: Record<string, string>, insights = false): Promise<Record<string, unknown> | { unsupported: true; permission: boolean }> {
    let transient = 0;
    for (;;) {
      while (run.gate) await run.gate;
      if (run.signal.aborted) throw run.signal.reason;
      const url = new URL(`${graph}/${path}`);
      url.search = new URLSearchParams(params).toString();
      const response = await context.oauth!.request(url.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: run.signal }, { limit: 2 * 1_048_576, timeoutMs: 20_000 });
      const body = parse(response);
      if (response.ok && !body) throw fail('provider_invalid_result', 422);
      if (response.ok && body && !body.error) return body;
      const failure = classify(response, body, insights, () => context.oauth!.invalidate());
      if (failure.kind === 'unsupported') return { unsupported: true, permission: failure.permission };
      if (failure.kind === 'transient') {
        if (transient++ >= 1 || Date.now() + 1_000 > context.deadline) throw fail('provider_error');
        await sleep(1_000, run.signal);
        continue;
      }
      // Throttled: everyone stops calling for Meta's estimate (or a back-off), only while the attempt's bound allows.
      if (!run.gate) {
        const wait = failure.regainMs ?? run.backoff;
        if (run.throttled++ >= 3 || Date.now() + wait > context.deadline - 5_000) throw fail('rate_limited', 429);
        run.backoff *= 2;
        const gate: Promise<void> = sleep(wait, run.signal).finally(() => { if (run.gate === gate) run.gate = null; });
        run.gate = gate;
      }
    }
  }
  /** Follows `paging.cursors.after` (never `paging.next`, which carries a token) until done or the post cap. */
  async function pages(run: GraphRun, context: SyncAdapterContext, path: string, params: Record<string, string>, keep: (item: Record<string, unknown>) => 'keep' | 'stop'): Promise<{ items: Record<string, unknown>[]; truncated: boolean }> {
    const items: Record<string, unknown>[] = [];
    const cursors = new Set<string>(), ids = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const body = await graphGet(run, context, path, { ...params, limit: '100', ...(after ? { after } : {}) });
      if ('unsupported' in body) throw fail('provider_error');
      if (!Array.isArray(body.data) || body.data.length > 100) throw fail('provider_invalid_result', 422);
      for (const item of body.data) {
        if (!isObject(item) || typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id)) throw fail('provider_invalid_result', 422);
        ids.add(item.id);
        if (keep(item) === 'stop') return { items, truncated: false };
        if (items.length >= window.maxPosts) return { items, truncated: true };
        items.push(item);
      }
      after = afterCursor(body, cursors);
      if (!after) return { items, truncated: false };
      if (items.length >= window.maxPosts) return { items, truncated: true };
    }
    return { items, truncated: true };
  }
  /** Per-post insights, four at a time. Values are the provider's own; a refused metric stays missing. */
  async function insightsFor(run: GraphRun, context: SyncAdapterContext, items: Record<string, unknown>[], params: Record<string, string>): Promise<MetaGraphPost[]> {
    const posts: MetaGraphPost[] = new Array(items.length);
    const allowed = params.metric!.split(',');
    let refusedForPermission = 0;
    let next = 0;
    const worker = async () => {
      while (next < items.length && !run.stop.signal.aborted) {
        const index = next++;
        const { id, ...fields } = items[index]!;
        let body: Awaited<ReturnType<typeof graphGet>>;
        // The first failure ends every worker and aborts their requests in flight: no further Graph call.
        try { body = await graphGet(run, context, `${id as string}/insights`, params, true); }
        catch (error) { if (!run.stop.signal.aborted) run.stop.abort(error); throw error; }
        if ('unsupported' in body) {
          if (body.permission) refusedForPermission++;
          posts[index] = { id: id as string, fields, insights: null, insightsStatus: 'unsupported' };
          continue;
        }
        let values: Record<string, unknown>;
        try { values = insightValues(body, allowed); }
        catch (error) { if (!run.stop.signal.aborted) run.stop.abort(error); throw error; }
        posts[index] = { id: id as string, fields, insights: values, insightsStatus: 'ok' };
      }
    };
    const settled = await Promise.allSettled(Array.from({ length: Math.min(INSIGHTS_CONCURRENCY, items.length) }, worker));
    // Report the failure that stopped the others (theirs are only "cancelled").
    if (run.stop.signal.aborted) throw run.stop.signal.reason;
    const rejected = settled.find(item => item.status === 'rejected');
    if (rejected) throw (rejected as PromiseRejectedResult).reason;
    // Every post refused for a permission: the grant lacks insights access (facts section 5, codes 10 and 200–299). The
    // token stays sealed (it still works), so a disconnect can still revoke it.
    if (items.length && refusedForPermission === items.length) throw fail('permission_missing', 403);
    return posts;
  }
  const snapshot = (value: Omit<MetaGraphSnapshot, 'schema' | 'graphVersion' | 'window'>): { json: string } =>
    ({ json: canonicalJson({ schema: META_GRAPH_SCHEMA, graphVersion: META_GRAPH_VERSION, window: { days: window.days, maxPosts: window.maxPosts }, ...value }) });
  const accountFields = (body: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.flatMap(key =>
    typeof body[key] === 'string' || (typeof body[key] === 'number' && Number.isSafeInteger(body[key])) ? [[key, body[key]]] : []));
  const since = () => Math.floor((now() - window.days * 86_400_000) / 1000);
  const derive = { source: metaGraphAdapter, csv: deriveMetaGraphCsv };

  const instagram: SyncAdapter = Object.freeze({
    syncOnConnect: true,
    automaticDailySync: true,
    id: 'instagram', label: META_LABELS.instagram, timeoutMs: META_SYNC_TIMEOUT_MS, minSyncIntervalMs: syncNowInterval, oauth, derive,
    async acquire(context: SyncAdapterContext) {
      const id = context.connection.providerAccountId;
      if (!ID.test(id)) throw fail('provider_invalid_result', 422);
      const run = graphRun(context);
      const account = await graphGet(run, context, id, { fields: 'id,username,followers_count,media_count' });
      if ('unsupported' in account || account.id !== id) throw fail('provider_invalid_result', 422);
      const start = since();
      const media = await pages(run, context, `${id}/media`, { fields: 'id,caption,timestamp,media_type,media_product_type,permalink,like_count,comments_count', since: String(start) },
        item => publicationTime(item.timestamp) < start ? 'stop' : 'keep');
      const posts = await insightsFor(run, context, media.items, { metric: META_INSTAGRAM_METRICS.join(',') });
      return snapshot({ product: 'instagram', account: { id, ...accountFields(account, ['username', 'name', 'followers_count', 'media_count']) }, truncated: media.truncated, posts });
    },
  });
  const facebook: SyncAdapter = Object.freeze({
    syncOnConnect: true,
    automaticDailySync: true,
    id: 'facebook', label: META_LABELS.facebook, timeoutMs: META_SYNC_TIMEOUT_MS, minSyncIntervalMs: syncNowInterval, oauth, derive,
    async acquire(context: SyncAdapterContext) {
      const id = context.connection.providerAccountId;
      if (!ID.test(id)) throw fail('provider_invalid_result', 422);
      const run = graphRun(context);
      const account = await graphGet(run, context, id, { fields: 'id,name,followers_count' });
      if ('unsupported' in account || account.id !== id) throw fail('provider_invalid_result', 422);
      const start = since();
      // MM-12: since/until do not filter publication time here, so paging stops at the first post older than the window.
      const posts = await pages(run, context, `${id}/published_posts`, { fields: 'id,message,created_time,permalink_url,shares' },
        item => {
          if (!(item.id as string).startsWith(`${id}_`)) throw fail('provider_invalid_result', 422);
          return publicationTime(item.created_time) < start ? 'stop' : 'keep';
        });
      const read = await insightsFor(run, context, posts.items, { metric: META_PAGE_METRICS.join(','), period: 'lifetime' });
      return snapshot({ product: 'facebook', account: { id, ...accountFields(account, ['name', 'followers_count']) }, truncated: posts.truncated, posts: read });
    },
  });
  return [instagram, facebook].filter(adapter => options.products.includes(adapter.id as MetaProduct));
}
