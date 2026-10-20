import { createHash } from 'node:crypto';
import { HarnessError } from './errors.ts';
import type { BoundedResponse, OAuthProviderDefinition, OAuthTokens } from './oauth.ts';
import type { SyncAdapterOAuth } from './sync-dispatch.ts';
import { isGoogleInvalidRefreshGrant } from './google-oauth.ts';

export type ProviderObject = Record<string, unknown>;
export type ProviderRequest = (url: string, init?: RequestInit, limits?: { limit?: number; timeoutMs?: number }) => Promise<BoundedResponse>;
export type DiscoveryContext = Parameters<NonNullable<SyncAdapterOAuth['accounts']>>[0];
export const invalidProviderData = () => new HarnessError('The source returned an unexpected response. Try syncing again.', 502, 'provider_invalid_result');
export const isObject = (value: unknown): value is ProviderObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function asObject(value: unknown): ProviderObject { if (!isObject(value)) throw invalidProviderData(); return value; }
export function objectList(value: unknown): ProviderObject[] {
  if (!Array.isArray(value) || value.some(item => !isObject(item))) throw invalidProviderData();
  return value as ProviderObject[];
}
export function providerText(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) throw invalidProviderData();
  return value;
}
export function providerCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) throw invalidProviderData();
  return number;
}
export async function providerJson(request: ProviderRequest, url: string, init?: RequestInit): Promise<ProviderObject> {
  const response = await request(url, init, { limit: 2 * 1024 * 1024, timeoutMs: 20_000 });
  if (response.status === 401) throw new HarnessError('Reconnect this account to continue syncing.', 401, 'oauth_expired');
  if (response.status === 429) throw new HarnessError('The source is limiting requests. Sync will retry later.', 429, 'rate_limited');
  if (response.status === 403) throw new HarnessError('Access was refused. Review the account permissions.', 403, 'permission_missing');
  if (!response.ok || response.truncated) throw new HarnessError('The source could not be read. Sync will retry later.', 502, 'provider_error');
  let value: unknown;
  try { value = JSON.parse(response.body); } catch { throw invalidProviderData(); }
  return asObject(value);
}
export function endpoint(base: string, path: string, query: Record<string, string> = {}): string {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}
/** Discovery is before a sealed session exists, so it supplies authorization explicitly. */
export function discoveryRequest(context: DiscoveryContext, scheme = 'Bearer'): ProviderRequest {
  return (url, init = {}, limits) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `${scheme} ${context.tokens.accessToken}`);
    return context.request(url, { ...init, headers }, limits);
  };
}
export function grantKey(provider: string, clientId: string, identity: string): string {
  return createHash('sha256').update(JSON.stringify([provider, clientId, identity])).digest('hex').slice(0, 32);
}
export const reconnectBy = (tokens: OAuthTokens) => tokens.refreshToken ? null : tokens.expiresAt ?? null;
export function googleProvider(id: string, label: string, scope: string): OAuthProviderDefinition {
  return { id, label, pkce: true, authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
    isInvalidRefreshGrant: isGoogleInvalidRefreshGrant,
    authorizeParams: { scope, access_type: 'offline', prompt: 'consent' },
    validateTokens(tokens) {
      if (!tokens.scope?.split(' ').includes(scope)) throw new HarnessError(`Allow read access to ${label}.`, 403, 'permission_missing');
    } };
}
export function nextToken(value: unknown, seen: Set<string>): string {
  if (value === undefined || value === '') return '';
  const token = providerText(value, 2048);
  if (seen.has(token)) throw invalidProviderData();
  seen.add(token);
  return token;
}
