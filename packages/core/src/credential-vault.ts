import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HarnessError } from './errors.ts';
import type { Connection } from './connections.ts';
import type { OAuthTokens, OAuthTokenStore } from './oauth.ts';

/*
 * Sealed connection credentials (M6, D-2). AES-256-GCM with a fresh 96-bit nonce per seal. The
 * additional authenticated data binds each row to its workspace, owner, provider, account,
 * connection and key version, so a row copied to another connection, or relabelled with another
 * key version, fails to open. The key lives in a file outside every data directory and is never
 * written to the database, a backup, a log, an API response or a model message. There is no
 * plaintext fallback: without a usable key the connector reports "Setup required".
 */

export interface CredentialKey { version: number; key: Buffer }
export type CredentialSetupReason = 'key_not_configured' | 'key_path' | 'key_location' | 'key_missing' | 'key_permissions' | 'key_size' | 'key_version' | 'key_unreadable';
export interface CredentialSetupStatus {
  ready: boolean;
  /** Present when not ready. */
  code?: 'credential_setup_required';
  reason?: CredentialSetupReason;
  /** A plain message with the next step. Never a key, a token or a file path. */
  message: string;
  currentVersion?: number;
}
export interface CredentialKeyProvider {
  /** The key new seals use. Throws `credential_setup_required` (503) when it is unusable. */
  current(): CredentialKey;
  /** The key for rows sealed with `version`. Throws `credential_setup_required` when not configured. */
  get(version: number): CredentialKey;
  /** Side-effect free: never creates the local key. */
  status(): CredentialSetupStatus;
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT = 1;
const MAX_SECRET_BYTES = 32 * 1024;
const MAX_VERSION = 1000;

class SetupRequired extends HarnessError {
  constructor(public reason: CredentialSetupReason, message: string) { super(`Setup required: ${message}`, 503, 'credential_setup_required'); }
}
const setup = {
  key_not_configured: 'an administrator must set HARNESS_CREDENTIAL_KEY_FILE before accounts can be connected.',
  key_path: 'HARNESS_CREDENTIAL_KEY_FILE must be an absolute path.',
  key_location: 'keep the credential key file outside the workspace data directory.',
  key_missing: 'the credential key file is missing. Restore it, or reconnect accounts with a new key.',
  key_permissions: 'the credential key file must be a regular file readable only by its owner (mode 0600 or 0400).',
  key_size: 'the credential key file must contain exactly 32 bytes, raw or base64.',
  key_version: 'a key version used by saved connections is not configured. Add HARNESS_CREDENTIAL_KEY_FILE_V<n> for it.',
  key_unreadable: 'the credential key file could not be read.',
} satisfies Record<CredentialSetupReason, string>;
const required = (reason: CredentialSetupReason) => new SetupRequired(reason, setup[reason]);

/** A key supplied in code (tests, or a future Key Vault client). Never from configuration text. */
export function credentialKeysFromBuffers(keys: Readonly<Record<number, Buffer>>, currentVersion: number): CredentialKeyProvider {
  const copies = new Map<number, Buffer>();
  for (const [version, key] of Object.entries(keys)) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw required('key_size');
    copies.set(Number(version), Buffer.from(key));
  }
  const get = (version: number): CredentialKey => {
    const key = copies.get(version);
    if (!key) throw version === currentVersion ? required('key_not_configured') : required('key_version');
    return { version, key };
  };
  return {
    current: () => get(currentVersion),
    get,
    status: () => copies.has(currentVersion) ? { ready: true, message: 'Credential sealing is ready.', currentVersion }
      : { ready: false, code: 'credential_setup_required', reason: 'key_not_configured', message: `Setup required: ${setup.key_not_configured}`, currentVersion },
  };
}

const inside = (child: string, parent: string) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};
/** Resolves symlinks in the longest existing prefix, so a link cannot hide a key inside a data directory. */
function resolved(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    // `.native` returns the on-disk case, so a case-variant path on a case-insensitive volume cannot slip past the check.
    try { return join(realpathSync.native(current), ...rest.reverse()); }
    catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(current.slice(parent.length).replace(/^[/\\]+/, ''));
      current = parent;
    }
  }
}

/** Reads exactly 32 key bytes, raw or base64 (standard or URL-safe), from a private regular file. */
function readKeyFile(path: string, dataDirs: readonly string[]): Buffer {
  if (!isAbsolute(path) || normalize(path) !== path || path.endsWith(sep)) throw required('key_path');
  const real = resolved(path);
  if (dataDirs.some(directory => inside(path, directory) || inside(real, resolved(directory)))) throw required('key_location');
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw required(code === 'ENOENT' ? 'key_missing' : code === 'ELOOP' ? 'key_permissions' : 'key_unreadable');
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw required('key_permissions');
    if (info.size > 128) throw required('key_size');
    const content = readFileSync(fd);
    if (content.length === KEY_BYTES) return content;
    const text = content.toString('latin1').trim();
    if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) throw required('key_size');
    const decoded = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length !== KEY_BYTES) throw required('key_size');
    return decoded;
  } finally { closeSync(fd); }
}

/**
 * The D-2 key provider:
 * - `HARNESS_CREDENTIAL_KEY_FILE` names the current key; `HARNESS_CREDENTIAL_KEY_VERSION` (default 1) is its version.
 * - `HARNESS_CREDENTIAL_KEY_FILE_V<n>` names older keys, used only to open rows sealed with version n until rotation.
 * - Local mode defaults to `~/.config/rivetfields/credentials.key`, created with mode 0600 on first use.
 * - Hosted mode has no default. Every file must be absolute, outside every data directory, mode `& 0o077 == 0`, and 32 bytes.
 * Problems are reported as "Setup required" when a connector needs the key; there is never a plaintext fallback.
 */
export function credentialKeysFromEnv(env: Readonly<Record<string, string | undefined>>, options: { mode: 'local' | 'hosted'; dataDirs: readonly string[]; homeDir?: string }): CredentialKeyProvider {
  const dataDirs = options.dataDirs.map(directory => resolve(directory));
  const configured = env.HARNESS_CREDENTIAL_KEY_FILE?.trim() || undefined;
  const versionText = env.HARNESS_CREDENTIAL_KEY_VERSION?.trim() || '1';
  const currentVersion = /^[1-9][0-9]{0,3}$/.test(versionText) && Number(versionText) <= MAX_VERSION ? Number(versionText) : NaN;
  const localDefault = options.mode === 'local' && !configured ? join(options.homeDir ?? homedir(), '.config', 'rivetfields', 'credentials.key') : undefined;
  const currentPath = configured ?? localDefault;
  const older = new Map<number, string>();
  let configurationProblem: CredentialSetupReason | undefined = Number.isNaN(currentVersion) ? 'key_version' : undefined;
  for (const [name, value] of Object.entries(env)) {
    const match = /^HARNESS_CREDENTIAL_KEY_FILE_V([1-9][0-9]{0,3})$/.exec(name);
    if (!match || !value?.trim()) continue;
    const version = Number(match[1]);
    // One file per version: naming the current version twice is ambiguous, so it is refused.
    if (version === currentVersion || version > MAX_VERSION) configurationProblem = 'key_version';
    else older.set(version, value.trim());
  }
  const cache = new Map<number, Buffer>();
  const load = (version: number, create: boolean): CredentialKey => {
    if (configurationProblem) throw required(configurationProblem);
    const cached = cache.get(version);
    if (cached) return { version, key: cached };
    const path = version === currentVersion ? currentPath : older.get(version);
    if (!path) throw required(version === currentVersion ? 'key_not_configured' : 'key_version');
    if (create && path === localDefault) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, randomBytes(KEY_BYTES), { mode: 0o600, flag: 'wx' });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw required('key_unreadable'); }
    }
    const key = readKeyFile(path, dataDirs);
    cache.set(version, key);
    return { version, key };
  };
  return {
    current: () => load(currentVersion, true),
    get: version => load(version, false),
    status(): CredentialSetupStatus {
      try {
        if (configurationProblem) throw required(configurationProblem);
        if (currentPath === localDefault && localDefault) {
          // The local key is created on first use; report ready without creating it here.
          try { load(currentVersion, false); }
          catch (error) { if (!(error instanceof SetupRequired && error.reason === 'key_missing')) throw error; }
        } else load(currentVersion, false);
        return { ready: true, message: 'Credential sealing is ready.', currentVersion };
      } catch (error) {
        if (!(error instanceof SetupRequired)) throw error;
        return { ready: false, code: 'credential_setup_required', reason: error.reason, message: error.message, ...(Number.isNaN(currentVersion) ? {} : { currentVersion }) };
      }
    },
  };
}

const unreadable = () => new HarnessError('The saved sign-in for this connection could not be verified. Reconnect the account.', 409, 'credential_unreadable');
const notFound = () => new HarnessError('That connection was not found.', 404, 'connection_not_found');

/** `workspaceId|issuer|subject|provider|accountKey|connectionId|keyVersion`; issuer and subject are empty locally. */
export function credentialAad(connection: Pick<Connection, 'id' | 'workspaceId' | 'owner' | 'provider' | 'accountKey'>, keyVersion: number): Buffer {
  const fields = [connection.workspaceId, connection.owner?.issuer ?? '', connection.owner?.subject ?? '', connection.provider, connection.accountKey, connection.id, String(keyVersion)];
  // The separator must be unambiguous: a field containing it could shift the binding to another row.
  if (fields.some(field => typeof field !== 'string' || field.includes('|'))) {
    throw new HarnessError('This connection\'s identity cannot be bound to sealed credentials. Ask an administrator to review the account issuer.', 500, 'credential_binding_invalid');
  }
  return Buffer.from(fields.join('|'), 'utf8');
}

function seal(key: CredentialKey, aad: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT]), nonce, cipher.getAuthTag(), ciphertext]);
}
function open(key: CredentialKey, aad: Buffer, sealed: Uint8Array): Buffer {
  const blob = Buffer.from(sealed);
  if (blob.length < 1 + NONCE_BYTES + TAG_BYTES + 1 || blob[0] !== FORMAT) throw unreadable();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, blob.subarray(1, 1 + NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(blob.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(blob.subarray(1 + NONCE_BYTES + TAG_BYTES)), decipher.final()]);
  } catch { throw unreadable(); }
}

/**
 * The `connection_credentials` table in `harness.sqlite`. Rows hold only `{keyVersion, nonce,
 * ciphertext, tag}`: the stored blob is `format(1) | nonce(12) | tag(16) | ciphertext`, with the
 * key version in its own column. The binding comes from the saved connection row, never from
 * the caller. Persistence only: the harness enforces role, membership and ownership.
 */
export function createCredentialVault(db: DatabaseSync, options: {
  keys?: CredentialKeyProvider;
  connectionOf: (id: string) => Connection | undefined;
  now?: () => string;
}) {
  const keys = options.keys;
  const now = options.now ?? (() => new Date().toISOString());
  db.exec(`CREATE TABLE IF NOT EXISTS connection_credentials (
    connection_id TEXT PRIMARY KEY REFERENCES connections(id),
    key_version INTEGER NOT NULL,
    sealed BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  const requireKeys = (): CredentialKeyProvider => {
    if (!keys) throw required('key_not_configured');
    return keys;
  };
  const row = (id: string) => db.prepare('SELECT key_version, sealed FROM connection_credentials WHERE connection_id=?').get(id) as { key_version: number; sealed: Uint8Array } | undefined;
  const remove = (id: string) => Number(db.prepare('DELETE FROM connection_credentials WHERE connection_id=?').run(id).changes) > 0;
  const write = (connection: Connection, key: CredentialKey, secret: Buffer) => {
    db.prepare(`INSERT INTO connection_credentials(connection_id,key_version,sealed,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(connection_id) DO UPDATE SET key_version=excluded.key_version, sealed=excluded.sealed, updated_at=excluded.updated_at`)
      .run(connection.id, key.version, seal(key, credentialAad(connection, key.version), secret), now());
  };
  const plaintext = (secret: unknown): Buffer => {
    if (!secret || typeof secret !== 'object' || Array.isArray(secret)) throw new HarnessError('Provide the sign-in to save as an object.', 400, 'invalid_credentials');
    const bytes = Buffer.from(JSON.stringify(secret), 'utf8');
    if (bytes.length > MAX_SECRET_BYTES) throw new HarnessError('This sign-in is larger than the 32 KiB limit.', 413, 'invalid_credentials');
    return bytes;
  };
  const opened = (connection: Connection, saved: { key_version: number; sealed: Uint8Array }): Record<string, unknown> => {
    if (!Number.isSafeInteger(saved.key_version) || saved.key_version < 1) throw unreadable();
    const key = requireKeys().get(saved.key_version);
    const bytes = open(key, credentialAad(connection, saved.key_version), saved.sealed);
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw unreadable(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw unreadable();
    return value as Record<string, unknown>;
  };
  /*
   * Credential generations (in memory, per runtime). A disconnect, a reconnect or a new sign-in
   * supersedes the connection's generation. A token store captures the generation when it is
   * created and refuses to load, save or delete once superseded, so a refresh still in flight
   * from an old grant can never write its tokens over a newer sign-in (or delete them).
   */
  const generations = new Map<string, number>();
  const generationOf = (id: string) => generations.get(id) ?? 0;
  const supersede = (id: string) => { generations.set(id, generationOf(id) + 1); };
  const superseded = () => new HarnessError('This connection was disconnected or reconnected while a request was running. Retry.', 409, 'credential_superseded');
  const sealSecret = (id: string, secret: Record<string, unknown>): void => {
    const bytes = plaintext(secret);
    const key = requireKeys().current();
    const connection = options.connectionOf(id);
    if (!connection) throw notFound();
    if (connection.status === 'disconnected') throw new HarnessError('Reconnect this account before saving its sign-in.', 409, 'connection_disconnected');
    write(connection, key, bytes);
  };
  const openSecret = (id: string): Record<string, unknown> | undefined => {
    const saved = row(id);
    if (!saved) return undefined;
    const connection = options.connectionOf(id);
    if (!connection) throw unreadable();
    if (connection.status === 'disconnected') { remove(id); return undefined; }
    return opened(connection, saved);
  };
  return {
    /** Whether a connector can seal and open credentials now. Never creates the local key. */
    status(): CredentialSetupStatus { return keys ? keys.status() : { ready: false, code: 'credential_setup_required', reason: 'key_not_configured', message: `Setup required: ${setup.key_not_configured}` }; },
    has(id: string): boolean { return Boolean(row(id)); },
    /** Obtains the key new seals use (creating the local default key if needed); throws "Setup required" otherwise. */
    requireCurrentKey(): void { requireKeys().current(); },
    /** Seals and stores (or replaces) a connection's secret with the current key: a new grant supersedes older token stores. */
    seal(id: string, secret: Record<string, unknown>): void { supersede(id); sealSecret(id, secret); },
    /**
     * The secret, or `undefined` when none is saved. A disconnected connection's row is
     * destroyed instead of opened. Tampering or the wrong key gives `credential_unreadable`.
     */
    open: openSecret,
    /** Destroys a connection's credentials and supersedes its token stores. Returns whether a row existed. */
    remove(id: string): boolean { supersede(id); return remove(id); },
    /** Marks a reconnect: token stores created before it can no longer write. */
    supersede,
    /** OAuth tokens for one connection, sealed on every save (used by `createOAuthClient().session`). */
    tokenStore(id: string): OAuthTokenStore {
      const captured = generationOf(id);
      const current = () => generationOf(id) === captured;
      return {
        load(): OAuthTokens | undefined {
          if (!current()) throw superseded();
          const value = openSecret(id);
          if (!value) return undefined;
          const valid = typeof value.accessToken === 'string' && typeof value.obtainedAt === 'number'
            && (value.refreshToken === undefined || typeof value.refreshToken === 'string')
            && (value.expiresAt === undefined || typeof value.expiresAt === 'number')
            && (value.scope === undefined || typeof value.scope === 'string');
          if (!valid) throw unreadable();
          return value as unknown as OAuthTokens;
        },
        save(tokens: OAuthTokens) {
          if (!current()) throw superseded();
          sealSecret(id, { ...tokens });
        },
        /**
         * Expiry or the session's own disconnect. A superseded store deletes nothing: the row now
         * belongs to a newer sign-in or is already gone. This store stays current, so it reports
         * "not connected" afterwards; a later sign-in (`seal`) supersedes it.
         */
        remove() {
          if (!current()) return;
          remove(id);
        },
      };
    },
    /** D-9: credentials of disconnected connections are destroyed (also run at startup). */
    purgeDisconnected(): number {
      return Number(db.prepare("DELETE FROM connection_credentials WHERE connection_id IN (SELECT id FROM connections WHERE status='disconnected')").run().changes);
    },
    /**
     * Re-seals every row not on the current key version. Rows are rotated one at a time, so
     * older keys keep opening the rows not yet rotated. A row that cannot be opened is left
     * unchanged and reported; nothing is deleted. Rows of disconnected connections are skipped
     * (they are destroyed, never re-sealed). Operator/CLI use only: no HTTP route exposes rotation.
     */
    rotate(): { currentVersion: number; resealed: number; unchanged: number; skipped: number; failed: string[] } {
      const key = requireKeys().current();
      const rows = db.prepare('SELECT connection_id, key_version, sealed FROM connection_credentials ORDER BY connection_id').all() as { connection_id: string; key_version: number; sealed: Uint8Array }[];
      let resealed = 0; let unchanged = 0; let skipped = 0;
      const failed: string[] = [];
      for (const saved of rows) {
        const connection = options.connectionOf(saved.connection_id);
        if (connection?.status === 'disconnected') { skipped++; continue; }
        if (saved.key_version === key.version) { unchanged++; continue; }
        try {
          if (!connection) throw unreadable();
          const secret = opened(connection, saved);
          db.exec('BEGIN IMMEDIATE');
          try {
            const current = row(saved.connection_id);
            // Replace only the exact row that was opened; a concurrent re-seal wins.
            if (current && current.key_version === saved.key_version && Buffer.compare(Buffer.from(current.sealed), Buffer.from(saved.sealed)) === 0) {
              write(connection, key, Buffer.from(JSON.stringify(secret), 'utf8'));
              resealed++;
            } else unchanged++;
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        } catch { failed.push(saved.connection_id); }
      }
      return { currentVersion: key.version, resealed, unchanged, skipped, failed };
    },
  };
}
export type CredentialVault = ReturnType<typeof createCredentialVault>;
