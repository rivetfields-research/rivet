import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HarnessError } from './errors.ts';

export type ConnectionStatus = 'active' | 'needs_attention' | 'disconnected';
export type ConnectionVersionKind = 'tabular' | 'social';
export interface ConnectionOwner { issuer: string; subject: string }
/** Bounded diagnostic record of the last acquisition; never a credential or payload. */
export interface ConnectionAttemptRecord { id: string; status: 'succeeded' | 'failed'; at: string; errorCode?: string }
export interface Connection {
  id: string;
  workspaceId: string;
  /** NULL in local mode; a verified issuer/subject in hosted mode. Never returned by the API. */
  owner: ConnectionOwner | null;
  provider: string;
  accountKey: string;
  status: ConnectionStatus;
  version: number;
  displayName: string;
  providerAccountId: string;
  mapping?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastAttempt?: ConnectionAttemptRecord;
  /** When the provider sign-in must be renewed (M8, Meta's ~60-day user token or data-access expiry). Not secret. */
  reconnectBy?: string;
  /**
   * Hash of the provider-side grant (Meta: the person's app-scoped user ID). Connections from one grant share it, so a
   * disconnect never revokes a grant another connection still uses. Never returned by the API.
   */
  grantKey?: string;
}
export interface ConnectionInput {
  workspaceId: string;
  owner: ConnectionOwner | null;
  provider: string;
  displayName: string;
  /** Drop-box connections have no provider account; the connection's own ID is used. */
  providerAccountId?: string;
  mapping?: Record<string, unknown>;
  /** Account sign-in facts saved with a sign-in (M8); a reconnect replaces them. */
  signIn?: { grantKey: string; reconnectBy: string | null };
}
export interface ConnectionUpdateInput {
  version: number;
  status?: ConnectionStatus;
  displayName?: string;
  /** `null` clears the saved mapping. */
  mapping?: Record<string, unknown> | null;
  /** `null` clears the saved attempt record. */
  lastAttempt?: ConnectionAttemptRecord | null;
}
export interface ConnectionVersion {
  /** The sync attempt ID that produced it: one version per successful acquisition. */
  id: string;
  connectionId: string;
  kind: ConnectionVersionKind;
  datasetId: string;
  sourceId: string;
  /** The data-layer receipt when one was written; null when the dataset already existed. */
  rawReceiptId: string | null;
  contentHash: string;
  /** When the provider data was acquired. Never the dataset's createdAt (C15). */
  observedAt: string;
}
export interface ConnectionVersionInput extends Omit<ConnectionVersion, 'rawReceiptId'> { rawReceiptId?: string | null }
export interface ConnectionLimits { connections: number; versions: number }

export const CONNECTION_ID = /^conn_[0-9a-f]{24}$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,39}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,159}$/;
const CONTENT_HASH = /^[a-f0-9]{64}$/;
const STATUSES: readonly ConnectionStatus[] = ['active', 'needs_attention', 'disconnected'];
const KINDS: readonly ConnectionVersionKind[] = ['tabular', 'social'];
/** Defaults; every runtime may configure them (N-1). */
export const CONNECTION_LIMITS: ConnectionLimits = { connections: 25, versions: 500 };

const fail = (message: string, status = 400, code = 'invalid_connection'): never => { throw new HarnessError(message, status, code); };
const iso = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 40) return fail('Provide an ISO observation time for this connection.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return fail('Provide an ISO observation time for this connection.');
  return date.toISOString();
};
const label = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) return fail(`Give this connection a ${field} of 1–160 readable characters.`);
  return value.trim();
};
const signInOf = (value: unknown): { grantKey: string; reconnectBy: string | null } | undefined => {
  if (value === undefined) return undefined;
  const signIn = value as { grantKey?: unknown; reconnectBy?: unknown };
  if (!signIn || typeof signIn !== 'object' || Array.isArray(signIn) || Object.keys(signIn).some(key => !['grantKey', 'reconnectBy'].includes(key)) ||
      typeof signIn.grantKey !== 'string' || !/^[a-f0-9]{32}$/.test(signIn.grantKey) || (signIn.reconnectBy !== null && typeof signIn.reconnectBy !== 'string')) {
    return fail('Record the account sign-in facts for this connection.');
  }
  return { grantKey: signIn.grantKey, reconnectBy: signIn.reconnectBy === null ? null : iso(signIn.reconnectBy) };
};
const mappingOf = (value: unknown): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 8192) return fail('Provide a column mapping object of at most 8 KiB for this connection.');
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
};

/** `conn_` plus 24 lowercase hex characters, so routes never collide with `/api/connections/google-drive/*`. */
export function newConnectionId(): string { return `conn_${randomBytes(12).toString('hex')}`; }
/** Provider account identities are hashed: the API accepts wider values than a source ID allows (C14). */
export function connectionAccountKey(providerAccountId: string): string {
  return createHash('sha256').update(providerAccountId).digest('hex').slice(0, 32);
}

function ownerOf(value: unknown): ConnectionOwner | null {
  if (value === null) return null;
  const owner = value as ConnectionOwner | undefined;
  const valid = (item: unknown): item is string => typeof item === 'string' && item.length > 0 && item.length <= 256 && !/[\u0000- \u007f]/.test(item);
  if (!owner || typeof owner !== 'object' || Array.isArray(owner) || Object.keys(owner).length !== 2 || !valid(owner.issuer) || !valid(owner.subject)) {
    return fail('A hosted connection requires a server-verified owner.', 403, 'connection_owner_required');
  }
  return { issuer: owner.issuer, subject: owner.subject };
}

function attemptOf(value: unknown): ConnectionAttemptRecord | undefined {
  if (value === undefined) return undefined;
  const attempt = value as ConnectionAttemptRecord;
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt) ||
      Object.keys(attempt).some(key => !['id', 'status', 'at', 'errorCode'].includes(key)) ||
      typeof attempt.id !== 'string' || !VERSION_ID.test(attempt.id) || !['succeeded', 'failed'].includes(attempt.status) ||
      (attempt.errorCode !== undefined && (typeof attempt.errorCode !== 'string' || !/^[a-z0-9_]{1,80}$/.test(attempt.errorCode)))) {
    return fail('Record a bounded connection attempt outcome.');
  }
  return { id: attempt.id, status: attempt.status, at: iso(attempt.at), ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}) };
}

function versionOf(input: unknown): ConnectionVersion {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Provide the acquired version to record.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['id', 'connectionId', 'kind', 'datasetId', 'sourceId', 'rawReceiptId', 'contentHash', 'observedAt'].includes(key))) {
    return fail('A connection version records its attempt, dataset, source, receipt, content hash and observation time.');
  }
  if (typeof value.id !== 'string' || !VERSION_ID.test(value.id)) return fail('A connection version needs its acquisition attempt ID.');
  if (typeof value.connectionId !== 'string' || !CONNECTION_ID.test(value.connectionId)) return fail('Choose the connection this version belongs to.');
  if (typeof value.kind !== 'string' || !KINDS.includes(value.kind as ConnectionVersionKind)) return fail('A connection version is tabular or social.');
  if (typeof value.datasetId !== 'string' || !IDENTIFIER.test(value.datasetId)) return fail('A connection version needs the stored dataset ID.');
  if (typeof value.sourceId !== 'string' || !IDENTIFIER.test(value.sourceId)) return fail('A connection version needs its workspace source ID.');
  if (value.rawReceiptId !== undefined && value.rawReceiptId !== null && (typeof value.rawReceiptId !== 'string' || !IDENTIFIER.test(value.rawReceiptId))) return fail('A connection version receipt must be a data-layer receipt ID or null.');
  if (typeof value.contentHash !== 'string' || !CONTENT_HASH.test(value.contentHash)) return fail('A connection version needs the SHA-256 hash of the acquired bytes.');
  return {
    id: value.id, connectionId: value.connectionId, kind: value.kind as ConnectionVersionKind,
    datasetId: value.datasetId, sourceId: value.sourceId,
    rawReceiptId: (value.rawReceiptId as string | null | undefined) ?? null,
    contentHash: value.contentHash, observedAt: iso(value.observedAt),
  };
}

/**
 * Persistence only. The caller enforces role, current membership, feature flags and
 * provider access; no credential, token or payload is stored here. Observation time
 * lives in `connection_versions`, never inside a normalized dataset (C15).
 */
export function createConnectionStore(db: DatabaseSync, options: { now?: () => string; limits?: Partial<ConnectionLimits> } = {}) {
  const limits: ConnectionLimits = { ...CONNECTION_LIMITS, ...options.limits };
  if (!Number.isInteger(limits.connections) || limits.connections < 1 || limits.connections > 200 ||
      !Number.isInteger(limits.versions) || limits.versions < 1 || limits.versions > 10_000) {
    throw new HarnessError('Configure connection limits of 1–200 connections and 1–10,000 saved versions.', 400, 'invalid_connection_limits');
  }
  const now = () => iso(options.now?.() ?? new Date().toISOString());
  db.exec(`CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    owner_issuer TEXT,
    owner_subject TEXT,
    provider TEXT NOT NULL,
    account_key TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    UNIQUE (workspace_id, provider, account_key)
  );
  CREATE TABLE IF NOT EXISTS connection_versions (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES connections(id),
    kind TEXT NOT NULL,
    dataset_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    raw_receipt_id TEXT,
    content_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS connection_versions_latest ON connection_versions (connection_id, observed_at);
  CREATE INDEX IF NOT EXISTS connection_versions_source ON connection_versions (source_id);`);
  const transaction = <T>(action: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const stored = (id: string): Connection | undefined => {
    const row = db.prepare('SELECT data FROM connections WHERE id=?').get(id);
    return row ? JSON.parse(row.data as string) as Connection : undefined;
  };
  const write = (connection: Connection) => db.prepare('UPDATE connections SET status=?,version=?,data=? WHERE id=?')
    .run(connection.status, connection.version, JSON.stringify(connection), connection.id);
  const parseVersion = (row: Record<string, unknown>): ConnectionVersion => ({
    id: row.id as string, connectionId: row.connection_id as string, kind: row.kind as ConnectionVersionKind,
    datasetId: row.dataset_id as string, sourceId: row.source_id as string,
    rawReceiptId: (row.raw_receipt_id as string | null) ?? null,
    contentHash: row.content_hash as string, observedAt: row.observed_at as string,
  });
  /** Greatest `observed_at`, ties broken by the greatest `id`. */
  const ordered = (connectionId: string, limit: number): ConnectionVersion[] =>
    db.prepare('SELECT * FROM connection_versions WHERE connection_id=? ORDER BY observed_at DESC, id DESC LIMIT ?')
      .all(connectionId, limit).map(row => parseVersion(row as Record<string, unknown>));
  return {
    limits: { ...limits },
    get(id: string): Connection | undefined { return typeof id === 'string' && CONNECTION_ID.test(id) ? stored(id) : undefined; },
    list(workspaceId: string): Connection[] {
      return db.prepare('SELECT data FROM connections WHERE workspace_id=? ORDER BY rowid').all(workspaceId)
        .map(row => JSON.parse(row.data as string) as Connection);
    },
    /**
     * A reconnect reuses the existing row: status returns to active and the version increments. `inTransaction` runs
     * inside the same transaction once the row is written (M9: sealing its credential); if it throws, the new row is
     * never created and a reused row keeps its previous state.
     */
    create(input: ConnectionInput, options: { inTransaction?: (connection: Connection) => void } = {}): Connection {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['workspaceId', 'owner', 'provider', 'displayName', 'providerAccountId', 'mapping', 'signIn'].includes(key))) {
        return fail('Provide the workspace, owner, provider and display name for this connection.');
      }
      if (typeof input.workspaceId !== 'string' || !WORKSPACE_ID.test(input.workspaceId)) return fail('A connection belongs to one fixed workspace.');
      if (typeof input.provider !== 'string' || !PROVIDER.test(input.provider)) return fail('Choose a supported connection provider.');
      const owner = ownerOf(input.owner === undefined ? null : input.owner);
      const displayName = label(input.displayName, 'name');
      const mapping = mappingOf(input.mapping);
      const signIn = signInOf(input.signIn);
      const id = newConnectionId();
      if (input.providerAccountId !== undefined && (typeof input.providerAccountId !== 'string' || !input.providerAccountId.trim() || input.providerAccountId.length > 200 || /[\u0000-\u001f\u007f]/.test(input.providerAccountId))) {
        return fail('Provide the provider account identifier this connection reads.');
      }
      const providerAccountId = input.providerAccountId?.trim() ?? id;
      const accountKey = connectionAccountKey(providerAccountId);
      return transaction(() => {
        const existing = db.prepare('SELECT data FROM connections WHERE workspace_id=? AND provider=? AND account_key=?')
          .get(input.workspaceId, input.provider, accountKey);
        const stamp = now();
        if (existing) {
          const saved = JSON.parse(existing.data as string) as Connection;
          // A reconnect is the original owner's action. Transferring a connection to another
          // admitted owner would leave sealed credentials and membership checks (M3, M6) bound
          // to the stored owner, so it must be an explicit action, never a side effect here.
          if (saved.owner && (saved.owner.issuer !== owner?.issuer || saved.owner.subject !== owner?.subject)) {
            return fail('Another workspace owner already connected this account. Ask them to reconnect it, or connect a different account.', 403, 'connection_owner_mismatch');
          }
          const reconnected: Connection = { ...saved, status: 'active', version: saved.version + 1, displayName, updatedAt: stamp, ...(mapping ? { mapping } : {}),
            ...(signIn ? { grantKey: signIn.grantKey } : {}), ...(signIn?.reconnectBy ? { reconnectBy: signIn.reconnectBy } : {}) };
          if (signIn && !signIn.reconnectBy) delete reconnected.reconnectBy;
          write(reconnected);
          options.inTransaction?.(reconnected);
          return reconnected;
        }
        if ((db.prepare('SELECT count(*) AS n FROM connections WHERE workspace_id=?').get(input.workspaceId)!.n as number) >= limits.connections) {
          return fail(`This workspace supports ${limits.connections} connections. Disconnect one, or raise HARNESS_CONNECTION_LIMIT for this installation.`, 409, 'connection_limit');
        }
        const connection: Connection = {
          id, workspaceId: input.workspaceId, owner, provider: input.provider, accountKey,
          status: 'active', version: 1, displayName, providerAccountId, ...(mapping ? { mapping } : {}),
          createdAt: stamp, updatedAt: stamp,
          ...(signIn ? { grantKey: signIn.grantKey } : {}), ...(signIn?.reconnectBy ? { reconnectBy: signIn.reconnectBy } : {}),
        };
        db.prepare('INSERT INTO connections(id,workspace_id,owner_issuer,owner_subject,provider,account_key,status,version,data) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(connection.id, connection.workspaceId, owner?.issuer ?? null, owner?.subject ?? null, connection.provider, connection.accountKey, connection.status, connection.version, JSON.stringify(connection));
        options.inTransaction?.(connection);
        return connection;
      });
    },
    update(id: string, input: ConnectionUpdateInput): Connection {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['version', 'status', 'displayName', 'mapping', 'lastAttempt'].includes(key)) ||
          !Number.isSafeInteger(input.version) || input.version < 1) return fail('Provide the current connection version to change it.');
      if (input.status !== undefined && !STATUSES.includes(input.status)) return fail('A connection is active, needs attention, or disconnected.');
      const displayName = input.displayName === undefined ? undefined : label(input.displayName, 'name');
      // `null` clears a stored mapping or attempt record; `undefined` leaves it as saved.
      const mapping = input.mapping === null ? null : mappingOf(input.mapping);
      const lastAttempt = input.lastAttempt === null ? null : attemptOf(input.lastAttempt);
      return transaction(() => {
        const saved = typeof id === 'string' && CONNECTION_ID.test(id) ? stored(id) : undefined;
        if (!saved) return fail('That connection was not found.', 404, 'connection_not_found');
        if (saved.version !== input.version) return fail('This connection changed. Reload before saving.', 409, 'connection_version_conflict');
        const next: Connection = {
          ...saved, version: saved.version + 1, updatedAt: now(),
          ...(input.status ? { status: input.status } : {}), ...(displayName ? { displayName } : {}),
          ...(mapping ? { mapping } : {}), ...(lastAttempt ? { lastAttempt } : {}),
        };
        if (mapping === null) delete next.mapping;
        if (lastAttempt === null) delete next.lastAttempt;
        write(next);
        return next;
      });
    },
    versions(connectionId: string, limit = Math.min(50, limits.versions)): ConnectionVersion[] {
      if (typeof connectionId !== 'string' || !CONNECTION_ID.test(connectionId)) return [];
      if (!Number.isInteger(limit) || limit < 1 || limit > limits.versions) return fail(`Request 1–${limits.versions} saved connection versions.`);
      return ordered(connectionId, limit);
    },
    snapshots(connectionId: string): Pick<ConnectionVersion, 'id' | 'sourceId' | 'observedAt'>[] {
      if (typeof connectionId !== 'string' || !CONNECTION_ID.test(connectionId)) return [];
      return ordered(connectionId, limits.versions).map(({ id, sourceId, observedAt }) => ({ id, sourceId, observedAt }));
    },
    /**
     * One row per successful acquisition. Unchanged content (the same hash as the latest
     * version) writes nothing; content repeating an older version writes a new row that
     * points at the existing dataset, so it becomes latest again.
     */
    recordVersion(input: ConnectionVersionInput): { version: ConnectionVersion; created: boolean; unchanged: boolean } {
      const value = versionOf(input);
      return transaction(() => {
        if (!stored(value.connectionId)) return fail('That connection was not found.', 404, 'connection_not_found');
        const existing = db.prepare('SELECT * FROM connection_versions WHERE id=?').get(value.id);
        if (existing) {
          const saved = parseVersion(existing as Record<string, unknown>);
          if (JSON.stringify(saved) !== JSON.stringify(value)) return fail('That acquisition attempt already recorded a different version.', 409, 'connection_version_conflict');
          return { version: saved, created: false, unchanged: false };
        }
        const [latest] = ordered(value.connectionId, 1);
        if (latest && latest.contentHash === value.contentHash) return { version: latest, created: false, unchanged: true };
        if ((db.prepare('SELECT count(*) AS n FROM connection_versions WHERE connection_id=?').get(value.connectionId)!.n as number) >= limits.versions) {
          return fail(`This connection has reached its ${limits.versions} saved versions. Raise HARNESS_CONNECTION_VERSION_LIMIT for this installation before syncing again.`, 409, 'connection_version_limit');
        }
        db.prepare('INSERT INTO connection_versions(id,connection_id,kind,dataset_id,source_id,raw_receipt_id,content_hash,observed_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(value.id, value.connectionId, value.kind, value.datasetId, value.sourceId, value.rawReceiptId, value.contentHash, value.observedAt);
        return { version: value, created: true, unchanged: false };
      });
    },
    /** One version by its acquisition attempt ID (boot recovery). */
    version(id: string): ConnectionVersion | undefined {
      if (typeof id !== 'string' || !VERSION_ID.test(id)) return undefined;
      const row = db.prepare('SELECT * FROM connection_versions WHERE id=?').get(id) as Record<string, unknown> | undefined;
      return row ? parseVersion(row) : undefined;
    },
    /** The newest acquisition of one workspace source by a connection in this workspace ("Data as of"). */
    latestForSource(workspaceId: string, sourceId: string): { connection: Connection; version: ConnectionVersion } | undefined {
      if (typeof sourceId !== 'string' || !IDENTIFIER.test(sourceId)) return undefined;
      const row = db.prepare(`SELECT v.*, c.data AS connection_data FROM connection_versions v JOIN connections c ON c.id=v.connection_id
        WHERE v.source_id=? AND c.workspace_id=? ORDER BY v.observed_at DESC, v.id DESC LIMIT 1`).get(sourceId, workspaceId) as Record<string, unknown> | undefined;
      return row ? { connection: JSON.parse(row.connection_data as string) as Connection, version: parseVersion(row) } : undefined;
    },
    /**
     * Every connection in this workspace whose syncs produced this source, newest acquisition first. Identical content
     * from several connections (or an upload) resolves to one content-addressed dataset, so a source can have several.
     */
    connectionsForSource(workspaceId: string, sourceId: string): Connection[] {
      if (typeof sourceId !== 'string' || !IDENTIFIER.test(sourceId)) return [];
      return (db.prepare(`SELECT c.data AS data, max(v.observed_at) AS newest FROM connection_versions v JOIN connections c ON c.id=v.connection_id
        WHERE v.source_id=? AND c.workspace_id=? GROUP BY c.id ORDER BY newest DESC, c.id`).all(sourceId, workspaceId) as Record<string, unknown>[])
        .map(row => JSON.parse(row.data as string) as Connection);
    },
    /**
     * The newest usable version: greatest `observed_at` (ties by greatest `id`) whose stored
     * dataset still exists and whose source is not archived. `usable` is required and supplies
     * exactly those checks, which live in the tabular/social stores and the source archive; a
     * caller cannot lose them by omission.
     */
    resolveLatest(connectionId: string, usable: (version: ConnectionVersion) => boolean): ConnectionVersion | undefined {
      // A plain Error, not a 400: only untyped in-process callers can reach this, never a request.
      if (typeof usable !== 'function') throw new Error('Resolving the latest version needs its dataset and archive checks.');
      if (typeof connectionId !== 'string' || !CONNECTION_ID.test(connectionId)) return undefined;
      for (const version of ordered(connectionId, limits.versions)) if (usable(version)) return version;
      return undefined;
    },
  };
}
export type ConnectionStore = ReturnType<typeof createConnectionStore>;
