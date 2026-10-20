import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError } from './errors.ts';

/*
 * Shared OAuth core (M6). Google Drive uses the generic primitives below and keeps its own
 * global pending sign-in and plaintext file unchanged. New connectors use the per-actor
 * pending store, the mode-aware redirect and cookie helpers, and `createOAuthClient`, with
 * tokens kept only in the sealed credential vault. Nothing here logs, and no error message
 * ever includes a token, a provider response body or a local path.
 */

// ---------------------------------------------------------------------------------------------
// PKCE, state and browser binding

/** 256 random bits, URL-safe. */
export const newOAuthState = (): string => randomBytes(32).toString('base64url');
/** RFC 7636 verifier: 64 URL-safe characters from 384 random bits. */
export const newPkceVerifier = (): string => randomBytes(48).toString('base64url');
export const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');
/** Only the hash of a browser binding is kept in memory. */
export const bindingDigest = (binding: string): Buffer => createHash('sha256').update(binding).digest();
/** Constant-time comparison of a presented binding with the stored hash. */
export function bindingMatches(expected: Buffer, binding: unknown): boolean {
  return typeof binding === 'string' && timingSafeEqual(expected, bindingDigest(binding));
}

// ---------------------------------------------------------------------------------------------
// Bounded provider requests

export interface BoundedRequestErrors {
  cancelled: () => HarnessError;
  unreachable: () => HarnessError;
  unreadable: () => HarnessError;
  tooLarge: () => HarnessError;
}
export interface BoundedResponse {
  status: number; ok: boolean; body: string; truncated: boolean;
  /** Only the allowlisted rate-limit headers below, lower-cased; never a cookie or an authorization header. */
  headers?: Readonly<Record<string, string>>;
}
/** Response headers a provider client may read: rate-limit usage and retry hints only (facts MR-03). */
const KEPT_HEADERS = ['x-business-use-case-usage', 'x-app-usage', 'retry-after'] as const;

/**
 * One provider request with `redirect: 'error'`, a time bound and a byte bound. Provider
 * bodies are returned to the caller only; errors are the caller's fixed messages.
 */
export async function boundedRequest(fetcher: typeof globalThis.fetch, url: string, init: RequestInit, options: {
  limit: number; errors: BoundedRequestErrors; signal?: AbortSignal; truncate?: boolean; timeoutMs?: number;
}): Promise<BoundedResponse> {
  const { limit, errors, signal, truncate = false, timeoutMs = 15_000 } = options;
  if (signal?.aborted) throw errors.cancelled();
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: abort }); }
  catch { throw signal?.aborted ? errors.cancelled() : errors.unreachable(); }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  const cancelReader = () => { void reader?.cancel().catch(() => {}); };
  let onAbort: (() => void) | undefined;
  try {
    if (abort.aborted) { cancelReader(); throw signal?.aborted ? errors.cancelled() : errors.unreadable(); }
    if (reader) {
      // A provider may send headers then stall; cancellation must not depend on another body chunk.
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAbort = () => { cancelReader(); reject(signal?.aborted ? errors.cancelled() : errors.unreadable()); };
        abort.addEventListener('abort', onAbort, { once: true });
      });
      for (;;) {
        const { value, done } = await Promise.race([reader.read(), interrupted]);
        if (abort.aborted) throw signal?.aborted ? errors.cancelled() : errors.unreadable();
        if (done) break;
        const remaining = limit - bytes;
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining)); bytes += remaining;
          cancelReader();
          if (!truncate) throw errors.tooLarge();
          truncated = true; break;
        }
        chunks.push(value); bytes += value.byteLength;
      }
    }
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw signal?.aborted ? errors.cancelled() : errors.unreadable();
  } finally {
    if (onAbort) abort.removeEventListener('abort', onAbort);
    reader?.releaseLock();
  }
  if (signal?.aborted) throw errors.cancelled();
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = response.headers?.get?.(name);
    if (typeof value === 'string' && value.length <= 4096) headers[name] = value;
  }
  return { status: response.status, ok: response.ok, body: Buffer.concat(chunks).toString('utf8'), truncated, ...(Object.keys(headers).length ? { headers } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Single-flight refresh and epoch fencing

/** At most one task per key in flight; a caller with the same key shares the running promise. */
export function createSingleFlight<K, T>() {
  let current: { key: K; promise: Promise<T> } | null = null;
  return {
    run(key: K, task: () => Promise<T>): Promise<T> {
      if (!current || current.key !== key) {
        const entry = { key, promise: null as unknown as Promise<T> };
        entry.promise = task().finally(() => { if (current === entry) current = null; });
        current = entry;
      }
      return current.promise;
    },
  };
}

/**
 * A connection epoch. Any change (expiry, disconnect, reconnect) advances it, and work that
 * started under an older epoch is refused when it resumes after an `await`.
 */
export function createEpochFence(changed: () => HarnessError) {
  let epoch = 0;
  return {
    get current() { return epoch; },
    advance() { return ++epoch; },
    check(expected: number, signal?: AbortSignal, cancelled?: () => HarnessError) {
      if (signal?.aborted) throw (cancelled ?? changed)();
      if (expected !== epoch) throw changed();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Atomic private persistence

/**
 * Writes `content` to `directory/file` atomically with mode 0600 inside a 0700 directory
 * that must not be a symlink. On failure the temporary file is removed and a bare Error
 * (no path, no content) is thrown for the caller to translate.
 */
export function writePrivateFileAtomic(directory: string, file: string, content: string | Uint8Array, temporaryPrefix: string): void {
  const temporary = join(directory, `.${temporaryPrefix}-${randomBytes(16).toString('hex')}.tmp`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!fstatSync(dir).isDirectory()) throw new Error(); } finally { closeSync(dir); }
    chmodSync(directory, 0o700);
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(directory, file));
    chmodSync(join(directory, file), 0o600);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* Never include credentials or paths in errors. */ }
    throw new Error('Private file could not be saved.');
  }
}

// ---------------------------------------------------------------------------------------------
// Provider definitions, redirects and cookies

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,39}$/;
const RESERVED_PARAMS = new Set(['client_id', 'client_secret', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export type LocalCallbackHost = '127.0.0.1' | 'localhost';

export interface OAuthProviderDefinition {
  /** Path- and cookie-safe identifier, e.g. `meta`. */
  id: string;
  /** Plain name used in messages. */
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  /**
   * Provider-specific authorization parameters. The core never adds `scope`: most providers
   * send it here, while Meta (Facebook Login for Business) sends `config_id` and no scope
   * (CONNECTOR_PROVIDER_FACTS MT-06).
   */
  authorizeParams: Readonly<Record<string, string>>;
  /** Send an S256 PKCE challenge and verifier. */
  pkce: boolean;
  /** Local callback host. `127.0.0.1` by default; Meta uses `localhost` (facts ML-04, ML-05). */
  localHost?: LocalCallbackHost;
  /**
   * How to revoke after the local copy is deleted. Omitted means the provider has no revoke call. Several requests
   * (Meta revokes one permission per call, facts MT-09) count as revoked only when every one succeeds.
   */
  revokeRequest?: (tokens: OAuthTokens) => { url: string; init: RequestInit } | readonly { url: string; init: RequestInit }[];
  /**
   * Send `appsecret_proof` (HMAC-SHA256 of the access token, keyed with the client secret) on every authorized
   * request (Meta, facts MT-11). The token and the secret themselves are never put in a URL by the core.
   */
  appSecretProof?: boolean;
  /** Extra checks on a token response, e.g. a required granted scope. Throw a HarnessError to refuse. */
  validateTokens?: (tokens: OAuthTokens) => void;
  /** Code-owned additional data hosts, e.g. Mailchimp's numbered regional API hosts. */
  allowDataHost?: (host: string) => boolean;
  /** Mailchimp explicitly returns expires_in: 0 for a non-expiring grant. */
  nonExpiringTokens?: boolean;
  /** Some providers return bearer access tokens without a token_type field. */
  implicitBearerToken?: boolean;
  /** Mailchimp's unscoped grants may explicitly return scope: null. */
  nullableTokenScope?: boolean;
  /** When supplied, only this provider's explicit invalid-grant response destroys a failed refresh's saved tokens. */
  isInvalidRefreshGrant?: (response: BoundedResponse) => boolean;
}
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds; absent when the provider did not state a lifetime. */
  expiresAt?: number;
  scope?: string;
  obtainedAt: number;
  /** The provider's ID for the person who granted access, when the provider reports it (Meta `debug_token` user_id). */
  providerUserId?: string;
}
export type OAuthMode = { mode: 'local'; port: number } | { mode: 'hosted'; appOrigin: string };

const invalidDefinition = () => new HarnessError('This connection provider is not configured correctly.', 500, 'oauth_provider_configuration');
const requireMode = (mode: unknown): OAuthMode['mode'] => {
  if (mode !== 'local' && mode !== 'hosted') throw invalidDefinition();
  return mode;
};
/**
 * Provider endpoints use HTTPS. Plain HTTP is accepted only on loopback and only in local mode
 * (the fake OAuth server); a hosted runtime never contacts a plain-HTTP endpoint.
 */
function endpoint(value: string, mode: OAuthMode['mode']): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidDefinition(); }
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (mode === 'local' && url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) throw invalidDefinition();
  return url;
}
export function validateProviderDefinition(provider: OAuthProviderDefinition, mode: OAuthMode['mode']): OAuthProviderDefinition {
  requireMode(mode);
  if (!provider || typeof provider !== 'object' || !PROVIDER_ID.test(provider.id) || typeof provider.label !== 'string' || !provider.label.trim()
    || typeof provider.pkce !== 'boolean' || !provider.authorizeParams || typeof provider.authorizeParams !== 'object'
    || Object.entries(provider.authorizeParams).some(([key, value]) => RESERVED_PARAMS.has(key) || typeof value !== 'string' || !value || value.length > 2048)
    || (provider.localHost !== undefined && !['127.0.0.1', 'localhost'].includes(provider.localHost))
    || (provider.appSecretProof !== undefined && typeof provider.appSecretProof !== 'boolean')
    || (provider.allowDataHost !== undefined && typeof provider.allowDataHost !== 'function')
    || (provider.nonExpiringTokens !== undefined && typeof provider.nonExpiringTokens !== 'boolean')
    || (provider.implicitBearerToken !== undefined && typeof provider.implicitBearerToken !== 'boolean')
    || (provider.nullableTokenScope !== undefined && typeof provider.nullableTokenScope !== 'boolean')
    || (provider.isInvalidRefreshGrant !== undefined && typeof provider.isInvalidRefreshGrant !== 'function')) throw invalidDefinition();
  endpoint(provider.authorizeUrl, mode); endpoint(provider.tokenUrl, mode);
  return provider;
}

/**
 * Local: `http://<localHost>:<port>/api/connections/<provider>/callback`.
 * Hosted: exactly `https://<appOrigin host>/connections/<provider>/callback` (D-4).
 */
export function oauthRedirectUri(provider: Pick<OAuthProviderDefinition, 'id' | 'localHost'>, mode: OAuthMode): string {
  if (!PROVIDER_ID.test(provider.id)) throw invalidDefinition();
  if (mode.mode === 'local') {
    if (!Number.isInteger(mode.port) || mode.port < 1 || mode.port > 65_535) throw invalidDefinition();
    return `http://${provider.localHost ?? '127.0.0.1'}:${mode.port}/api/connections/${provider.id}/callback`;
  }
  let origin: URL;
  try { origin = new URL(mode.appOrigin); } catch { throw invalidDefinition(); }
  if (origin.protocol !== 'https:' || origin.origin !== mode.appOrigin || origin.username || origin.password) throw invalidDefinition();
  return `https://${origin.host}/connections/${provider.id}/callback`;
}

/** `rivetfields_oauth_<provider>` locally; `__Host-rivetfields_oauth_<provider>` hosted. */
export function oauthCookieName(providerId: string, mode: OAuthMode['mode']): string {
  if (!PROVIDER_ID.test(providerId)) throw invalidDefinition();
  return `${mode === 'hosted' ? '__Host-' : ''}rivetfields_oauth_${providerId}`;
}
/** A `Set-Cookie` value. Local: `Path=/api/connections/<provider>`. Hosted: Secure and `Path=/`. */
export function oauthCookieHeader(providerId: string, mode: OAuthMode['mode'], value: string, maxAgeSeconds: number): string {
  if (value !== '' && !/^[A-Za-z0-9_-]{43}$/.test(value)) throw invalidDefinition();
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > 3600) throw invalidDefinition();
  const name = oauthCookieName(providerId, mode);
  return mode === 'hosted'
    ? `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
    : `${name}=${value}; HttpOnly; SameSite=Lax; Path=/api/connections/${providerId}; Max-Age=${maxAgeSeconds}`;
}
/** A fresh 256-bit browser binding for the sign-in cookie. */
export const newOAuthBinding = (): string => randomBytes(32).toString('base64url');
/** The binding from a Cookie header, or `''` when absent or malformed. */
export function readOAuthCookie(cookieHeader: string | undefined, providerId: string, mode: OAuthMode['mode']): string {
  const name = oauthCookieName(providerId, mode);
  const value = cookieHeader?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

/**
 * A local sign-in must start on the provider's callback host, because a cookie set on
 * `127.0.0.1` is never sent to `localhost` (and the reverse). Returns the URL to send the
 * browser to before any cookie is set, or `undefined` when the request is already there.
 */
export function localSignInRedirect(requestHost: string | undefined, provider: Pick<OAuthProviderDefinition, 'id' | 'localHost'>, port: number, returnPath: string): string | undefined {
  if (!returnPath.startsWith('/') || returnPath.startsWith('//') || /[\u0000- \\]/.test(returnPath)) throw invalidDefinition();
  const expected = new URL(oauthRedirectUri(provider, { mode: 'local', port })).host;
  return requestHost === expected ? undefined : `http://${expected}${returnPath}`;
}

// ---------------------------------------------------------------------------------------------
// Per-actor, one-use pending sign-ins

export interface OAuthActor { issuer: string; subject: string }
export interface PendingOAuth<T> {
  provider: string;
  /** `null` in local mode. */
  actor: OAuthActor | null;
  verifier: string;
  expiresAt: number;
  attempt: number;
  /** Caller data, e.g. the workspace and connection the sign-in belongs to. Never a secret. */
  context: T;
}
interface PendingEntry<T> extends PendingOAuth<T> { key: string; bindingHash: Buffer }

const stateRefused = () => new HarnessError('This sign-in link expired or belongs to another browser session. Start again.', 403, 'oauth_state');
const actorKey = (actor: OAuthActor | null) => actor ? JSON.stringify([actor.issuer, actor.subject]) : 'local';
const stateKey = (state: string) => createHash('sha256').update(state).digest('hex');

/**
 * Pending state keyed per (actor or `local`, provider): a new sign-in replaces only that
 * actor's earlier one for the same provider. States are stored as hashes and are one-use:
 * a lookup removes the state whatever the outcome. Google Drive keeps its own global map.
 */
export function createOAuthPendingStore<T = undefined>(options: { mode: OAuthMode['mode']; ttlMs?: number; now?: () => number; maxEntries?: number }) {
  const mode = requireMode(options?.mode);
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1000;
  const byState = new Map<string, PendingEntry<T>>();
  const byKey = new Map<string, string>();
  const attempts = new Map<string, number>();
  const purge = () => {
    const time = now();
    for (const [hash, entry] of byState) if (entry.expiresAt <= time) { byState.delete(hash); if (byKey.get(entry.key) === hash) byKey.delete(entry.key); }
  };
  return {
    begin(input: { provider: string; actor: OAuthActor | null; binding: string; context: T }) {
      if (!PROVIDER_ID.test(input.provider)) throw invalidDefinition();
      if (typeof input.binding !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.binding)) throw new HarnessError('The browser sign-in session is missing.', 400, 'oauth_session');
      // Hosted sign-ins always belong to a verified actor; `null` (local) is never accepted there.
      if ((mode === 'hosted' && input.actor === null) || (input.actor !== null && (!input.actor || typeof input.actor.issuer !== 'string' || !input.actor.issuer || typeof input.actor.subject !== 'string' || !input.actor.subject))) {
        throw new HarnessError('A verified account is required to connect.', 403, 'oauth_actor_required');
      }
      purge();
      const key = `${actorKey(input.actor)}\u0000${input.provider}`;
      const previous = byKey.get(key);
      if (previous) byState.delete(previous);
      if (byState.size >= maxEntries) throw new HarnessError('Too many sign-ins are in progress. Try again in a few minutes.', 429, 'oauth_busy');
      const state = newOAuthState();
      const verifier = newPkceVerifier();
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      const hash = stateKey(state);
      byState.set(hash, { key, provider: input.provider, actor: input.actor ? { issuer: input.actor.issuer, subject: input.actor.subject } : null,
        bindingHash: bindingDigest(input.binding), verifier, expiresAt: now() + ttlMs, attempt, context: input.context });
      byKey.set(key, hash);
      return { state, verifier, codeChallenge: pkceChallenge(verifier), attempt };
    },
    /**
     * One use. Refuses an unknown, replaced or expired state, a different browser binding,
     * a different provider, or a different actor than the one who started the sign-in.
     */
    take(input: { state: unknown; binding: unknown; provider: string; actor: OAuthActor | null }): PendingOAuth<T> {
      if (typeof input.state !== 'string' || input.state.length < 20 || input.state.length > 256) throw stateRefused();
      const hash = stateKey(input.state);
      const entry = byState.get(hash);
      byState.delete(hash);
      if (entry && byKey.get(entry.key) === hash) byKey.delete(entry.key);
      if (!entry || entry.expiresAt <= now() || entry.provider !== input.provider || actorKey(entry.actor) !== actorKey(input.actor)
        || !bindingMatches(entry.bindingHash, input.binding)) throw stateRefused();
      const { key: _key, bindingHash: _hash, ...pending } = entry;
      return pending;
    },
    /** False when a newer sign-in for the same actor and provider started after this one. */
    isLatest(pending: PendingOAuth<T>): boolean {
      return attempts.get(`${actorKey(pending.actor)}\u0000${pending.provider}`) === pending.attempt;
    },
    /** Drops pending sign-ins for one actor and provider, e.g. on disconnect. */
    cancel(provider: string, actor: OAuthActor | null) {
      const key = `${actorKey(actor)}\u0000${provider}`;
      const hash = byKey.get(key);
      if (hash) { byState.delete(hash); byKey.delete(key); }
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
    },
    get size() { purge(); return byState.size; },
  };
}
export type OAuthPendingStore<T> = ReturnType<typeof createOAuthPendingStore<T>>;

// ---------------------------------------------------------------------------------------------
// Client and token sessions for connection providers

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const safeToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 16_000 && !/[\u0000- \u007f]/.test(value);
const MAX_LIFETIME_SECONDS = 400 * 24 * 3600;

/** Storage for one connection's tokens. The vault's implementation seals every save. */
export interface OAuthTokenStore {
  load(): OAuthTokens | undefined;
  save(tokens: OAuthTokens): void;
  remove(): void;
}

export function createOAuthClient(options: {
  provider: OAuthProviderDefinition; clientId: string; clientSecret: string;
  /** `hosted` refuses every plain-HTTP endpoint, loopback included. */
  mode: OAuthMode['mode'];
  fetch?: typeof globalThis.fetch; now?: () => number;
}) {
  const mode = requireMode(options.mode);
  const provider = validateProviderDefinition(options.provider, mode);
  if (typeof options.clientId !== 'string' || !options.clientId.trim() || typeof options.clientSecret !== 'string' || !options.clientSecret.trim()) {
    throw new HarnessError(`${provider.label} sign-in is not configured on this server.`, 503, 'oauth_not_configured');
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const hosts = new Set([endpoint(provider.authorizeUrl, mode).host, endpoint(provider.tokenUrl, mode).host]);
  const fail = (message: string, code: string, status: number) => new HarnessError(message, status, code);
  const errors: BoundedRequestErrors = {
    cancelled: () => fail(`The ${provider.label} request was cancelled.`, 'oauth_cancelled', 499),
    unreachable: () => fail(`${provider.label} could not be reached. Try again.`, 'oauth_unavailable', 502),
    unreadable: () => fail(`The ${provider.label} response could not be read. Try again.`, 'oauth_unavailable', 502),
    tooLarge: () => fail(`${provider.label} returned a response larger than the allowed limit.`, 'oauth_response_limit', 502),
  };
  /** Every request goes to a host this provider declared; a data request names its own pinned hosts. */
  const pinned = (url: string, allowed: ReadonlySet<string>) => {
    let parsed: URL;
    try { parsed = endpoint(url, mode); } catch { throw fail(`That ${provider.label} address is not allowed.`, 'oauth_host_denied', 400); }
    if (!allowed.has(parsed.host) && !(parsed.protocol === 'https:' && provider.allowDataHost?.(parsed.host))) throw fail(`That ${provider.label} address is not allowed.`, 'oauth_host_denied', 400);
    return parsed.toString();
  };
  const json = (body: string): Json => {
    try { const parsed: unknown = JSON.parse(body); if (isObject(parsed)) return parsed; } catch { /* Provider text is never an error message. */ }
    throw fail(`${provider.label} returned an invalid response.`, 'oauth_invalid_response', 502);
  };
  /** RFC 6749 token response. `token_type` is compared case-insensitively (Meta sends `bearer`). */
  const tokens = (value: Json, previous?: OAuthTokens): OAuthTokens => {
    const bearer = value.token_type === undefined && provider.implicitBearerToken || typeof value.token_type === 'string' && value.token_type.toLowerCase() === 'bearer';
    const scope = value.scope === null && provider.nullableTokenScope ? undefined : value.scope;
    if (!safeToken(value.access_token) || !bearer
      || (value.expires_in !== undefined && !(provider.nonExpiringTokens && value.expires_in === 0) && (typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in < 1 || value.expires_in > MAX_LIFETIME_SECONDS))
      || (value.refresh_token !== undefined && !safeToken(value.refresh_token))
      || (scope !== undefined && (typeof scope !== 'string' || scope.length > 4096))) {
      throw fail(`${provider.label} did not grant the required access. Connect again.`, 'oauth_grant_invalid', 403);
    }
    const result: OAuthTokens = {
      accessToken: value.access_token, obtainedAt: now(),
      ...(typeof value.expires_in === 'number' && value.expires_in > 0 ? { expiresAt: now() + value.expires_in * 1000 } : {}),
      ...(typeof value.refresh_token === 'string' ? { refreshToken: value.refresh_token } : previous?.refreshToken ? { refreshToken: previous.refreshToken } : {}),
      ...(typeof scope === 'string' ? { scope } : previous?.scope ? { scope: previous.scope } : {}),
      ...(previous?.providerUserId ? { providerUserId: previous.providerUserId } : {}),
    };
    provider.validateTokens?.(result);
    return result;
  };
  const tokenRequest = (body: Record<string, string>, signal?: AbortSignal) => boundedRequest(fetcher, pinned(provider.tokenUrl, hosts), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, ...body }),
  }, { limit: 32_768, errors, signal });

  /** HMAC-SHA256 of the token keyed with the client secret, hex (facts MT-11). */
  const proof = (token: string) => createHmac('sha256', options.clientSecret).update(token).digest('hex');
  const withProof = (target: string, token: string) => {
    if (!provider.appSecretProof) return target;
    const url = new URL(target);
    url.searchParams.set('appsecret_proof', proof(token));
    return url.toString();
  };
  return {
    provider,
    /**
     * An unauthenticated, bounded request to one of this provider's own hosts (token, authorize or the session data
     * hosts named here), for provider-specific sign-in steps such as Meta's long-lived token exchange. The caller
     * supplies any credential itself; nothing here logs or keeps it.
     */
    pinnedRequest(url: string, init: RequestInit = {}, limits: { limit?: number; signal?: AbortSignal; timeoutMs?: number; dataHosts?: readonly string[] } = {}): Promise<BoundedResponse> {
      const allowed = new Set([...hosts, ...(limits.dataHosts ?? []).map(host => endpoint(`https://${host}/`, mode).host)]);
      return boundedRequest(fetcher, pinned(url, allowed), init, { limit: limits.limit ?? 1_048_576, errors, signal: limits.signal, timeoutMs: limits.timeoutMs });
    },
    /** `appsecret_proof` for a token, for provider-specific sign-in steps (only when the provider asks for it). */
    appSecretProof(token: string): string | undefined { return provider.appSecretProof ? proof(token) : undefined; },
    /** The provider's authorization URL. Only this provider's own parameters are added. */
    authorizationUrl(input: { state: string; redirectUri: string; codeChallenge?: string }): string {
      if (provider.pkce && !input.codeChallenge) throw invalidDefinition();
      const url = new URL(provider.authorizeUrl);
      url.search = new URLSearchParams({
        ...Object.fromEntries(url.searchParams), ...provider.authorizeParams,
        client_id: options.clientId, redirect_uri: input.redirectUri, response_type: 'code', state: input.state,
        ...(provider.pkce ? { code_challenge: input.codeChallenge!, code_challenge_method: 'S256' } : {}),
      }).toString();
      return url.toString();
    },
    /** Exchanges a one-use authorization code. The redirect URI must equal the one sent to authorize. */
    async exchangeCode(input: { code: unknown; verifier: string; redirectUri: string }, signal?: AbortSignal): Promise<OAuthTokens> {
      if (typeof input.code !== 'string' || !input.code || input.code.length > 4096 || /[\u0000- \u007f]/.test(input.code)) throw stateRefused();
      const response = await tokenRequest({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
        ...(provider.pkce ? { code_verifier: input.verifier } : {}) }, signal);
      if (!response.ok) throw fail(`${provider.label} sign-in could not be completed. Start again.`, 'oauth_failed', 400);
      return tokens(json(response.body));
    },
    /**
     * Token use for one connection: single-flight refresh, one refresh-and-retry after a 401,
     * expiry on an authentication failure, and revoke-after-local-delete on disconnect.
     */
    session(store: OAuthTokenStore, hooks: { onExpired?: (code: 'oauth_expired') => void; dataHosts?: readonly string[] } = {}) {
      const fence = createEpochFence(() => fail(`The ${provider.label} connection changed. Reconnect or retry.`, 'oauth_connection_changed', 409));
      const refresh = createSingleFlight<number, string>();
      const dataHosts = new Set([...hosts, ...(hooks.dataHosts ?? []).map(host => endpoint(`https://${host}/`, mode).host)]);
      const expired = () => fail(`${provider.label} authorization expired or was revoked. Reconnect the account.`, 'oauth_expired', 401);
      const expire = (epoch: number) => {
        if (epoch !== fence.current) return;
        fence.advance();
        store.remove();
        hooks.onExpired?.('oauth_expired');
      };
      async function accessToken(signal?: AbortSignal, force = false): Promise<string> {
        const epoch = fence.current;
        fence.check(epoch, signal, errors.cancelled);
        const saved = store.load();
        if (!saved) throw fail(`Connect ${provider.label} before syncing.`, 'oauth_not_connected', 401);
        if (!force && (saved.expiresAt === undefined || saved.expiresAt > now() + 30_000)) return saved.accessToken;
        if (!saved.refreshToken) { expire(epoch); throw expired(); }
        const refreshToken = saved.refreshToken;
        const token = await refresh.run(epoch, async () => {
          const response = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
          fence.check(epoch);
          if (!response.ok) {
            const rejected = provider.isInvalidRefreshGrant ? provider.isInvalidRefreshGrant(response) : [400, 401, 403].includes(response.status);
            if (rejected) { expire(epoch); throw expired(); }
            throw fail(`${provider.label} authorization could not be refreshed. Try again.`, 'oauth_unavailable', 502);
          }
          let fields: OAuthTokens;
          try { fields = tokens(json(response.body), saved); }
          catch (error) { if (error instanceof HarnessError && error.code === 'oauth_grant_invalid') expire(epoch); throw error; }
          fence.check(epoch);
          store.save(fields);
          return fields.accessToken;
        });
        fence.check(epoch, signal, errors.cancelled);
        return token;
      }
      return {
        get epoch() { return fence.current; },
        accessToken,
        /** An authorized GET or POST to a pinned host. A 401 refreshes once and retries once. */
        async request(url: string, init: RequestInit = {}, limits: { limit?: number; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<BoundedResponse> {
          const target = pinned(url, dataHosts);
          const epoch = fence.current;
          const send = async (token: string) => {
            const headers = new Headers(init.headers);
            headers.set('Authorization', `Bearer ${token}`);
            const result = await boundedRequest(fetcher, withProof(target, token), { ...init, headers }, { limit: limits.limit ?? 1_048_576, errors, signal: limits.signal, timeoutMs: limits.timeoutMs });
            fence.check(epoch, limits.signal, errors.cancelled);
            return result;
          };
          let result = await send(await accessToken(limits.signal));
          if (result.status === 401) {
            result = await send(await accessToken(limits.signal, true));
            if (result.status === 401) { expire(epoch); throw expired(); }
          }
          return result;
        },
        /**
         * The provider said the saved grant no longer works (for example Meta error 190): the sealed copy is
         * destroyed, exactly as on an expiry, so the owner is asked to reconnect instead of retrying a dead token.
         */
        invalidate() { expire(fence.current); },
        /**
         * Deletes the local copy first, then asks the provider to revoke. The local delete always
         * runs, even when the saved tokens cannot be opened (missing key, tampered row); revoke is
         * attempted only with tokens that opened. Remote failure is reported, never retried silently.
         * `revoke: false` deletes the local copy only: a grant other connections still use stays live (Meta).
         */
        async disconnect(signal?: AbortSignal, disconnectOptions: { revoke?: boolean } = {}): Promise<{ revoked: boolean | null }> {
          fence.advance();
          let saved: OAuthTokens | undefined;
          let unreadable = false;
          try { saved = store.load(); }
          catch { unreadable = true; }
          finally { store.remove(); }
          if (unreadable) return { revoked: false };
          if (!saved || !provider.revokeRequest || disconnectOptions.revoke === false) return { revoked: null };
          try {
            const planned = provider.revokeRequest(saved);
            const requests = Array.isArray(planned) ? planned : [planned as { url: string; init: RequestInit }];
            if (!requests.length || requests.length > 20) return { revoked: false };
            let revoked = true;
            for (const { url, init } of requests) {
              // The provider's own revoke request carries whatever credential and proof it needs.
              const result = await boundedRequest(fetcher, pinned(url, dataHosts), init, { limit: 4096, errors, signal });
              revoked &&= result.ok;
            }
            return { revoked };
          } catch { return { revoked: false }; }
        },
      };
    },
  };
}
export type OAuthClient = ReturnType<typeof createOAuthClient>;
