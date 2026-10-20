import { createPublicKey, verify, type KeyObject } from 'node:crypto';

export interface AccessConfig { issuer: string; audience: string; }
export interface AccessIdentity {
  /** Use issuer + subject for membership lookup. Email is display information only. */
  issuer: string;
  subject: string;
  email?: string;
  /** A username-shaped address is display only, not a notification mailbox claim. */
  emailIsDisplayOnly?: true;
  /** Display only, copied from a cryptographically verified claim. Never an authorization key. */
  displayName?: string;
}
export interface AccessAuthenticator {
  authenticate(assertion: string | string[] | undefined): Promise<AccessIdentity>;
}
export interface AccessDependencies { fetch?: typeof globalThis.fetch; now?: () => number; }

export class AccessAuthError extends Error {
  readonly status: 401 | 503;
  readonly code: 'authentication_required' | 'invalid_identity' | 'identity_unavailable';
  constructor(code: AccessAuthError['code']) {
    super(code === 'identity_unavailable' ? 'Sign-in verification is temporarily unavailable.' : 'Sign in to this workspace.');
    this.name = 'AccessAuthError';
    this.code = code;
    this.status = code === 'identity_unavailable' ? 503 : 401;
  }
}

const CACHE_MS = 5 * 60_000;
const REFRESH_COOLDOWN_MS = 30_000;
const MAX_TOKEN_BYTES = 16_384;
const MAX_CERT_BYTES = 65_536;
const invalid = () => new AccessAuthError('invalid_identity');
const unavailable = () => new AccessAuthError('identity_unavailable');

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function base64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw invalid();
  return decoded;
}

function jsonSegment(value: string): Record<string, unknown> {
  try {
    return object(JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(base64url(value))));
  } catch { throw invalid(); }
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u0020\u007f]/.test(value);
}

function numericDate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function claimsIdentity(claims: Record<string, unknown>, config: AccessConfig, nowMs: number): AccessIdentity {
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (claims.iss !== config.issuer || !Array.isArray(audiences) || !audiences.length || audiences.length > 16 ||
      !audiences.every(value => boundedString(value, 256)) || !audiences.includes(config.audience) ||
      !boundedString(claims.sub, 256) || !numericDate(claims.exp) || nowMs / 1000 >= claims.exp ||
      (claims.nbf !== undefined && (!numericDate(claims.nbf) || nowMs / 1000 < claims.nbf || claims.nbf >= claims.exp)) ||
      (claims.iat !== undefined && (!numericDate(claims.iat) || nowMs / 1000 < claims.iat || claims.iat >= claims.exp))) throw invalid();
  if (claims.email !== undefined && !boundedString(claims.email, 320)) throw invalid();
  return {issuer:config.issuer, subject:claims.sub, ...(typeof claims.email === 'string' ? {email:claims.email} : {})};
}

async function certificateKeys(response: Response): Promise<Map<string, KeyObject>> {
  if (!response.ok || response.redirected || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CERT_BYTES) {
        void reader.cancel().catch(() => {});
        throw unavailable();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const document = object(JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks))));
  if (!Array.isArray(document.keys) || document.keys.length < 1 || document.keys.length > 8) throw unavailable();
  const keys = new Map<string, KeyObject>();
  for (const value of document.keys) {
    const key = object(value);
    if (key.kty !== 'RSA' || key.alg !== 'RS256' || key.use !== 'sig' || !boundedString(key.kid, 256) || keys.has(key.kid) ||
        typeof key.n !== 'string' || typeof key.e !== 'string' ||
        (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== 'verify'))) throw unavailable();
    const modulus = base64url(key.n);
    const exponent = base64url(key.e);
    if (modulus.byteLength < 256 || modulus.byteLength > 1024 || exponent.byteLength < 1 || exponent.byteLength > 8) throw unavailable();
    const imported = createPublicKey({key:{kty:'RSA', n:key.n, e:key.e}, format:'jwk'});
    if (imported.asymmetricKeyType !== 'rsa' || (imported.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw unavailable();
    keys.set(key.kid, imported);
  }
  return keys;
}

/**
 * Verifies only Cloudflare Access RS256 application assertions. This proves
 * identity; callers must separately authorize every workspace and resource.
 * No cookies, email headers or token-supplied key URLs are authentication inputs.
 */
export function createAccessAuthenticator(config: AccessConfig, dependencies: AccessDependencies = {}): AccessAuthenticator {
  if (!config || typeof config.issuer !== 'string' ||
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(config.issuer) ||
      !boundedString(config.audience, 256)) throw new Error('Configure a canonical Cloudflare Access issuer and application audience.');
  // Copy trusted configuration: a caller mutating its object cannot change the verifier.
  const pinned = {issuer:config.issuer, audience:config.audience};
  const certUrl = `${pinned.issuer}/cdn-cgi/access/certs`;
  const fetchKeys = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  let keys = new Map<string, KeyObject>();
  let expiresAt = 0;
  let lastAttempt = -Infinity;
  let lastAttemptFailed = false;
  let pending: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    if (pending) return pending;
    if (now() - lastAttempt < REFRESH_COOLDOWN_MS) {
      if (lastAttemptFailed || now() >= expiresAt) throw unavailable();
      return;
    }
    lastAttempt = now();
    pending = (async () => {
      try {
        const response = await fetchKeys(certUrl, {
          headers:{Accept:'application/json'}, redirect:'error', credentials:'omit', signal:AbortSignal.timeout(5000),
        });
        const refreshed = await certificateKeys(response);
        keys = refreshed;
        expiresAt = now() + CACHE_MS;
        lastAttemptFailed = false;
      } catch {
        lastAttemptFailed = true;
        throw unavailable();
      }
    })();
    try { await pending; } finally { pending = undefined; }
  }

  return {
    async authenticate(assertion) {
      if (assertion === undefined || assertion === '') throw new AccessAuthError('authentication_required');
      if (typeof assertion !== 'string' || assertion.length > MAX_TOKEN_BYTES) throw invalid();
      const parts = assertion.split('.');
      if (parts.length !== 3) throw invalid();
      const header = jsonSegment(parts[0]);
      if (header.alg !== 'RS256' || !boundedString(header.kid, 256) ||
          (header.typ !== undefined && header.typ !== 'JWT') ||
          ['crit', 'b64', 'jku', 'jwk', 'x5u'].some(name => Object.hasOwn(header, name))) throw invalid();
      const claims = jsonSegment(parts[1]);
      // Reject obvious invalid claims before any network request; recheck after it.
      claimsIdentity(claims, pinned, now());
      const signature = base64url(parts[2]);
      if (signature.byteLength < 256 || signature.byteLength > 1024) throw invalid();
      if (now() >= expiresAt || !keys.has(header.kid)) await refresh();
      const key = keys.get(header.kid);
      if (!key) throw invalid();
      let valid = false;
      try { valid = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), key, signature); }
      catch { throw invalid(); }
      if (!valid) throw invalid();
      return claimsIdentity(claims, pinned, now());
    },
  };
}
