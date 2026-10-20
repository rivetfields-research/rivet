import type { DatabaseSync } from 'node:sqlite';
import type { Connection } from './connections.ts';
import { HarnessError } from './errors.ts';
import type { BoundedResponse } from './oauth.ts';
import { abortable, type SyncLimiter } from './sync-dispatch.ts';
import { revalidateYouTubeSnapshot } from './youtube-connector.ts';

const WEEK = 7 * 24 * 60 * 60_000;
const RETRY = 60 * 60_000;
export interface YouTubeDataCheck {
  batchId: string; connectionId: string; attemptedAt: string; checkedAt: string | null;
  nextCheckAt: number; status: 'checked' | 'resources_unavailable' | 'channel_unavailable' | 'failed';
  unavailableVideoIds: string[]; errorCode: string | null;
}
const ERROR_CODES = new Set(['oauth_expired', 'oauth_not_connected', 'oauth_grant_invalid', 'credential_unreadable',
  'credential_setup_required', 'provider_blocked', 'provider_error', 'provider_invalid_result', 'rate_limited',
  'owner_not_member', 'owner_not_manager', 'workspace_denied', 'permission_missing']);

/** Checks are separate from immutable acquisitions: neither a report nor its evidence is rewritten. */
export function createYouTubeRevalidationStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS youtube_revalidation_checks (
    batch_id TEXT PRIMARY KEY REFERENCES raw_batches(id), connection_id TEXT NOT NULL,
    attempted_at TEXT NOT NULL, checked_at TEXT, next_check_at INTEGER NOT NULL,
    status TEXT NOT NULL, unavailable_video_ids TEXT NOT NULL, error_code TEXT
  ); CREATE INDEX IF NOT EXISTS youtube_checks_connection_attempt ON youtube_revalidation_checks(connection_id, attempted_at)`);
  const parse = (row: Record<string, unknown>): YouTubeDataCheck => ({ batchId: String(row.batch_id), connectionId: String(row.connection_id),
    attemptedAt: String(row.attempted_at), checkedAt: row.checked_at as string | null, nextCheckAt: Number(row.next_check_at),
    status: row.status as YouTubeDataCheck['status'], unavailableVideoIds: JSON.parse(String(row.unavailable_video_ids)), errorCode: row.error_code as string | null });
  return {
    next(connection: Connection, now: number): { id: string; json: string } | undefined {
      // Spread historical checks across hours rather than spending a channel's quota in one burst.
      const last = db.prepare('SELECT MAX(attempted_at) AS at FROM youtube_revalidation_checks WHERE connection_id=?').get(connection.id)?.at;
      if (typeof last === 'string' && Date.parse(last) + RETRY > now) return undefined;
      // Read one bounded payload, including historical batches outside the current uploads window.
      const row = db.prepare(`SELECT b.id, CASE WHEN length(CAST(b.payload AS BLOB)) <= 10485760 THEN b.payload ELSE NULL END AS payload
        FROM raw_batches b LEFT JOIN youtube_revalidation_checks c ON c.batch_id=b.id
        WHERE b.source_id=? AND b.account_id=? AND b.adapter='youtube'
          AND (c.batch_id IS NULL OR c.next_check_at<=?)
        ORDER BY COALESCE(c.next_check_at,unixepoch(b.first_seen_at)*1000,0), b.first_seen_at, b.id LIMIT 1`)
        .get(`conn:${connection.id}`, connection.accountKey, now);
      return row ? { id: String(row.id), json: typeof row.payload === 'string' ? row.payload : '' } : undefined;
    },
    save(check: YouTubeDataCheck) {
      db.prepare(`INSERT INTO youtube_revalidation_checks
        (batch_id,connection_id,attempted_at,checked_at,next_check_at,status,unavailable_video_ids,error_code)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(batch_id) DO UPDATE SET
        attempted_at=excluded.attempted_at,checked_at=excluded.checked_at,next_check_at=excluded.next_check_at,
        status=excluded.status,unavailable_video_ids=excluded.unavailable_video_ids,error_code=excluded.error_code`)
        .run(check.batchId, check.connectionId, check.attemptedAt, check.checkedAt, check.nextCheckAt,
          check.status, JSON.stringify(check.unavailableVideoIds), check.errorCode);
    },
    list(connectionId: string): YouTubeDataCheck[] {
      return db.prepare('SELECT * FROM youtube_revalidation_checks WHERE connection_id=? ORDER BY attempted_at DESC,batch_id LIMIT 500')
        .all(connectionId).map(parse);
    },
  };
}

/** A paused collection schedule does not disable retained-resource checks. No cleanup decisions are executed. */
export function createYouTubeRevalidationDispatcher(options: {
  store: ReturnType<typeof createYouTubeRevalidationStore>;
  connections(): Connection[];
  get(id: string): Connection | undefined;
  checkOwner(connection: Connection): Promise<void>;
  session(connection: Connection): {
    request(url: string, init?: RequestInit, limits?: { limit?: number; timeoutMs?: number }): Promise<BoundedResponse>;
    assertCurrent(): void;
  };
  limiter: SyncLimiter;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let closed = false, pending: Promise<void> | undefined;
  const shutdown = new AbortController();
  const controllers = new Map<string, AbortController>();
  const check = async (connection: Connection) => {
    if (closed || connection.provider !== 'youtube' || connection.status === 'disconnected') return;
    const batch = options.store.next(connection, now());
    if (!batch) return;
    const controller = new AbortController(); controllers.set(connection.id, controller);
    const signal = AbortSignal.any([controller.signal, shutdown.signal, AbortSignal.timeout(180_000)]);
    let release: (() => void) | undefined;
    let assertSessionCurrent: (() => void) | undefined;
    const sameConnection = () => {
      signal.throwIfAborted();
      const current = options.get(connection.id);
      if (!current || current.status === 'disconnected' || current.grantKey !== connection.grantKey ||
          current.providerAccountId !== connection.providerAccountId || JSON.stringify(current.owner) !== JSON.stringify(connection.owner)) {
        throw new HarnessError('The connection changed while checking saved data.', 409, 'connection_changed');
      }
    };
    try {
      await abortable(options.checkOwner(connection), signal); sameConnection();
      release = await options.limiter.acquire(signal); sameConnection();
      const session = options.session(connection);
      assertSessionCurrent = session.assertCurrent;
      session.assertCurrent();
      const result = await abortable(revalidateYouTubeSnapshot({ json: batch.json, accountId: connection.providerAccountId,
        signal, request: (url, init, limits) => session.request(url, init, limits) }), signal);
      await abortable(options.checkOwner(connection), signal); sameConnection(); session.assertCurrent();
      const at = now();
      options.store.save({ batchId: batch.id, connectionId: connection.id, attemptedAt: new Date(at).toISOString(),
        checkedAt: new Date(at).toISOString(), nextCheckAt: at + WEEK,
        status: result.status === 'channel_unavailable' ? 'channel_unavailable' : result.unavailableVideoIds.length ? 'resources_unavailable' : 'checked',
        unavailableVideoIds: result.status === 'checked' ? result.unavailableVideoIds : [], errorCode: null });
    } catch (error) {
      // Shutdown, disconnect and superseded work never write a result after cancellation.
      if (closed || controller.signal.aborted || shutdown.signal.aborted) return;
      const current = options.get(connection.id);
      if (!current || current.status === 'disconnected' || current.grantKey !== connection.grantKey ||
          current.providerAccountId !== connection.providerAccountId || JSON.stringify(current.owner) !== JSON.stringify(connection.owner)) return;
      if (error instanceof HarnessError && ['connection_changed', 'credential_superseded'].includes(error.code)) return;
      try { assertSessionCurrent?.(); } catch (sessionError) {
        if (sessionError instanceof HarnessError && ['connection_changed', 'credential_superseded'].includes(sessionError.code)) return;
      }
      const at = now();
      options.store.save({ batchId: batch.id, connectionId: connection.id, attemptedAt: new Date(at).toISOString(), checkedAt: null,
        nextCheckAt: at + RETRY, status: 'failed', unavailableVideoIds: [],
        errorCode: signal.aborted ? 'timeout' : error instanceof HarnessError && ERROR_CODES.has(error.code) ? error.code : 'provider_error' });
    } finally { release?.(); controllers.delete(connection.id); }
  };
  return {
    tick(): Promise<void> {
      if (closed) return Promise.resolve();
      return pending ??= (async () => {
        for (const connection of options.connections()) {
          if (closed) break;
          await check(structuredClone(connection));
        }
      })().finally(() => { pending = undefined; });
    },
    abort(connectionId: string) { controllers.get(connectionId)?.abort(); },
    async close() { closed = true; shutdown.abort(); await pending; },
  };
}
