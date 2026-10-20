import { createHash } from 'node:crypto';
import type { Connection, ConnectionStore } from './connections.ts';
import { HarnessError } from './errors.ts';
import type { SyncAttempt, SyncAttemptOutcome, SyncAttemptStatus, SyncJobStore } from './sync-jobs.ts';
import type { TabularDatasetInput, TabularImportResult } from './tabular-datasets.ts';
import type { BoundedResponse, OAuthProviderDefinition, OAuthTokens } from './oauth.ts';
import type { SourceAdapter } from '../../data-layer/src/types.ts';
import type { MetricSource } from '../../data-layer/src/tabular/types.ts';
import type { ConnectionBroker } from './broker-connections.ts';

/** One fetched CSV snapshot. Fetched bytes are parsed by the runtime, never by the model (C5). */
export interface SyncAcquiredFile { name: string; csv: string; mapping: TabularDatasetInput['mapping'] }
/**
 * One fetched provider JSON snapshot (M8). It is kept verbatim in the raw store under the attempt's key, then the
 * adapter's fixed `derive` code turns it into a CSV imported under `<key>-t` (plan M8 pipeline steps 1–3).
 */
export interface SyncAcquiredJson { json: string }
/** What a JSON acquisition's fixed code derives: the dataset file name, its CSV (null when empty) and the mapping. */
export interface SyncDerivedCsv { name: string; csv: string | null; mapping: TabularDatasetInput['mapping']; metricSource?: MetricSource }
/** Largest provider JSON snapshot a sync keeps (bytes). */
export const SYNC_JSON_LIMIT = 10 * 1024 * 1024;
/**
 * One page of public social posts (M9, Apify), imported through the existing social path (`social.importDataset`) with
 * the attempt's key as its request ID, under the connection's own raw source `conn:<id>` and starting at `offset`. The
 * runtime keeps the page in the raw store and moves the checkpoint to `offset + records.length` when it commits.
 */
export interface SyncAcquiredSocial {
  social: {
    records: unknown[];
    platform: 'instagram' | 'facebook';
    /** The account the posts belong to, as the owner named it. */
    account: string;
    /** The provider dataset the page was read from (its locator). */
    datasetId: string;
    offset: number;
    /**
     * Dataset positions this page covered, at least `records.length` (items the adapter dropped, such as empty ones,
     * still count). The checkpoint moves to `offset + count`. Defaults to `records.length`.
     */
    count?: number;
    coverage: 'complete' | 'partial' | 'unknown';
    /** `run_superseded`: a task's newer run replaced a run that was not fully read (recorded as the attempt's message). */
    notice?: 'run_superseded';
    /** The saved dataset's name. */
    sourceName: string;
  };
}
/** A social adapter's saved position: the raw checkpoint of its connection, and the dataset that page came from. */
export interface SyncSocialCheckpoint { cursor: string | null; datasetId: string | null }
export interface SyncAdapterContext {
  connection: Readonly<Pick<Connection, 'id' | 'provider' | 'providerAccountId' | 'displayName' | 'mapping'>>;
  attempt: Readonly<Pick<SyncAttempt, 'id' | 'trigger' | 'scheduledFor' | 'attempt'>>;
  /** Aborted at the provider bound, on shutdown and on disconnect. */
  signal: AbortSignal;
  /** Epoch milliseconds at which `signal` aborts for the provider bound, so a back-off never waits past it. */
  deadline: number;
  /**
   * Present only for providers registered with `oauth` (M7). Authorized requests to the provider's pinned hosts,
   * through the connection's current OAuth session. The adapter never sees a token.
   */
  oauth?: {
    request(url: string, init?: RequestInit, limits?: { limit?: number; timeoutMs?: number }): Promise<BoundedResponse>;
    /** The provider said the grant no longer works: destroy the sealed copy so the owner is asked to reconnect. */
    invalidate(): void;
  };
  /**
   * Present only for adapters with `credential: 'api_token'` (M9): the connection's sealed API token, opened for this
   * acquisition only. The adapter sends it in a request header to its pinned host and never logs, stores or returns it.
   */
  apiToken?: () => string;
  /** Present only for social adapters (M9): where the connection's previous page ended; null before its first page. */
  checkpoint?: SyncSocialCheckpoint | null;
}
/** One account a sign-in can connect, found after the code exchange (M8). Its tokens are sealed only if picked. */
export interface SignInAccount {
  /** The sync adapter (product) this account connects through, e.g. `instagram` or `facebook`. */
  provider: string;
  /** The provider's account ID; the connection stores only its hash as the account key. */
  accountId: string;
  /** Suggested connection name from the account, e.g. "@handle · Instagram". Editable before connecting. */
  displayName: string;
  /** The credential sealed for this connection only. */
  tokens: OAuthTokens;
  /** When the person must sign in again (epoch ms), from the provider's own token facts; null when it does not expire. */
  reconnectBy: number | null;
}
/**
 * After the exchange: the accounts the person may pick (nothing is attached automatically) and the identity of the
 * provider-side grant they share, so a disconnect never revokes a grant another connection still uses.
 */
export interface SignInDiscovery { grantKey: string; accounts: SignInAccount[]; tokens: OAuthTokens }
/**
 * Sign-in for a provider whose syncs need an account (M7). Registered in code only: production registers no
 * provider in this milestone, and no environment variable or configuration value can (D-15).
 */
export interface SyncAdapterOAuth {
  /** `provider.id` must equal the adapter's ID: one fixed callback path per provider (D-4). */
  provider: OAuthProviderDefinition;
  clientId: string;
  clientSecret: string;
  /** Hosts the adapter may call with the token, beyond the authorize and token hosts. HTTPS only in hosted mode. */
  dataHosts?: readonly string[];
  /** Tests only: routes provider requests to the loopback fake OAuth server. */
  fetch?: typeof globalThis.fetch;
  /**
   * Several products behind one sign-in (Meta: Instagram and Facebook Pages). After the exchange it lists the accounts
   * the person can pick; each picked account becomes its own connection under its own adapter (D-8). Adapters that
   * share a sign-in pass the same `oauth` object, whose `provider.id` names the one callback path (D-4).
   */
  accounts?(context: { tokens: OAuthTokens; signal: AbortSignal; request(url: string, init?: RequestInit, limits?: { limit?: number; timeoutMs?: number }): Promise<BoundedResponse>; appSecretProof(token: string): string | undefined }): Promise<SignInDiscovery>;
}
/**
 * Server-side acquisition for one provider. Credentials, if any, stay inside the adapter; the
 * dispatcher stores only hashes, sizes, keys and the confirmed column mapping.
 */
export interface SyncAdapter {
  id: string;
  label: string;
  /** Server-configured pilot scope. Omitted means unrestricted; an empty list enables no workspace. */
  workspaceIds?: readonly string[];
  /** Provider-specific bound for one acquisition, 1 ms to 10 minutes. */
  timeoutMs: number;
  acquire(context: SyncAdapterContext): Promise<{ files: SyncAcquiredFile[] } | SyncAcquiredJson | SyncAcquiredSocial>;
  /**
   * Required for JSON acquisitions: the synchronous raw adapter (C5) and the fixed, deterministic CSV derivation.
   * Boot recovery re-derives from the stored JSON with the same code, so identical bytes always import identically.
   */
  derive?: { source: SourceAdapter<string>; csv(json: string): SyncDerivedCsv };
  /** "Sync now" is refused within this many milliseconds of the connection's previous attempt (provider rate limits). */
  minSyncIntervalMs?: number;
  /** Queue a first read after the person confirms an account or reconnects it. */
  syncOnConnect?: boolean;
  /** New connections get a daily job; reconnecting preserves their existing schedule. */
  automaticDailySync?: boolean;
  /** The provider needs an account sign-in; syncs then use sealed credentials through an OAuth session. */
  oauth?: SyncAdapterOAuth;
  /** Customer authorization through a collector, with a sealed per-customer grant. */
  broker?: ConnectionBroker;
  sourceProvider?: string;
  /**
   * M9: the connection needs an API token its owner enters in Settings, sealed per connection and shown only as
   * "configured". There is no installation-wide fallback: a connection without its own token never syncs.
   */
  credential?: 'api_token';
  /** M9: acquisitions are public social posts (`SyncAcquiredSocial`), versioned with `kind: 'social'`. */
  social?: true;
}
/** Installation-wide: shared by every runtime in the process (D-6). */
export interface SyncLimiter { readonly max: number; acquire(signal: AbortSignal): Promise<() => void> }

/** A pre-sync while the same connection is syncing waits this long, then uses that attempt. "Sync now" never waits. */
export const SYNC_WAIT_MS = 60_000;
const TERMINAL: readonly SyncAttemptStatus[] = ['completed', 'unchanged', 'failed', 'interrupted'];
const MESSAGES: Record<string, string> = {
  owner_not_member: 'The person who connected this source is no longer an active member, or this workspace is suspended. A workspace owner needs to reconnect it.',
  membership_unavailable: 'Workspace membership could not be verified, so the sync did not run. The next sync will try again.',
  provider_unavailable: 'This provider cannot sync in this workspace. Check which providers are enabled.',
  connection_disconnected: 'This connection was disconnected, so the sync stopped. Reconnect it to sync again.',
  provider_error: 'The provider could not be read. The next sync will try again.',
  provider_invalid_result: 'The provider returned data this workspace cannot import. Check the connection setup.',
  sync_failed: 'The sync could not finish. The next sync will try again.',
  credential_setup_required: 'Setup required: an administrator must configure the credential key before this connection can sync.',
  sign_in_required: 'The account sign-in for this connection is missing or has expired. Reconnect the account to sync again.',
  owner_not_manager: 'The person who connected this source can no longer manage connections in this workspace, so it stopped syncing. A workspace owner needs to reconnect it.',
  rate_limited: 'The provider is limiting requests for this account right now, so the sync stopped early. The next sync will try again.',
  permission_missing: 'The account did not grant a permission this connection needs, or it was removed. Reconnect the account and allow the requested access.',
  provider_blocked: 'The provider blocked this request for the account. Check the account at the provider, then reconnect it.',
  api_token_required: 'The API token for this connection is missing or was refused. Add the connection again with a current token; its synced data is kept.',
  provider_not_found: 'The provider could not find what this connection reads, or it has no finished result yet. Check the ID at the provider.',
  run_superseded: 'A newer task run finished before the previous run was fully read; the previous run\'s remaining records were skipped.',
};
/** Outcomes that need the owner at once, not after three failures in a row. */
const ATTENTION_NOW: readonly string[] = ['owner_not_member', 'owner_not_manager', 'sign_in_required', 'permission_missing', 'provider_blocked', 'api_token_required', 'provider_not_found'];
/** A provider sign-in that ends within this window moves the connection to Needs attention after each sync (facts MT-04). */
export const RECONNECT_WARNING_MS = 7 * 24 * 3600_000;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/**
 * Codes an adapter may report. Only the code is kept; the stored message is always the fixed text
 * above, so an adapter's own error text (which could carry a token or URL) never reaches an attempt.
 */
const ACQUISITION_CODES: readonly string[] = ['provider_error', 'provider_invalid_result', 'provider_unavailable', 'credential_setup_required', 'rate_limited', 'permission_missing', 'provider_blocked', 'api_token_required', 'provider_not_found'];
/** A grant that expired, was revoked or is missing during the fetch: the owner must sign in again. */
const SIGN_IN_CODES: readonly string[] = ['oauth_expired', 'oauth_not_connected', 'oauth_grant_invalid', 'credential_unreadable'];
const acquisitionOutcome = (error: unknown, credential?: 'api_token') => {
  // An API token that cannot be opened is the token's problem, not an account sign-in's (M9).
  if (credential === 'api_token' && error instanceof HarnessError && error.code === 'credential_unreadable') return { code: 'api_token_required', message: MESSAGES.api_token_required! };
  if (error instanceof HarnessError && SIGN_IN_CODES.includes(error.code)) return { code: 'sign_in_required', message: MESSAGES.sign_in_required! };
  const code = error instanceof HarnessError && ACQUISITION_CODES.includes(error.code) ? error.code : 'provider_error';
  return { code, message: MESSAGES[code]! };
};
/** Only an explicit denial means the owner lost access; anything else is an ordinary, retryable failure. */
const membershipOutcome = (error: unknown) => {
  const value = error as { status?: unknown; code?: unknown } | null;
  if (value && typeof value === 'object' && value.code === 'owner_not_manager') return 'owner_not_manager';
  return value && typeof value === 'object' && (value.status === 403 || value.code === 'workspace_denied') ? 'owner_not_member' : 'membership_unavailable';
};

export function createSyncLimiter(max = 1): SyncLimiter {
  if (!Number.isInteger(max) || max < 1 || max > 8) throw new HarnessError('Allow 1–8 concurrent syncs.', 400, 'invalid_sync_concurrency');
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => { active--; queue.shift()?.(); };
  return {
    max,
    acquire(signal: AbortSignal) {
      return new Promise<() => void>((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        let released = false;
        const grant = () => {
          signal.removeEventListener('abort', onAbort);
          active++;
          resolve(() => { if (!released) { released = true; release(); } });
        };
        const onAbort = () => { const index = queue.indexOf(grant); if (index >= 0) queue.splice(index, 1); reject(signal.reason); };
        if (active < max) { grant(); return; }
        queue.push(grant);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

function outcomeOf(error: unknown, fallback: 'provider_error' | 'sync_failed') {
  return error instanceof HarnessError && /^[a-z0-9_]{1,80}$/.test(error.code) && error.code !== 'invalid_request'
    ? { code: error.code, message: error.message } : { code: fallback, message: MESSAGES[fallback] };
}

type Acquired = { kind: 'csv'; files: SyncAcquiredFile[] } | { kind: 'json'; json: string } | { kind: 'social'; social: SyncAcquiredSocial['social'] };
/** Fixed checks on a social page; anything else is a plain invalid-result failure. */
function acquiredSocial(value: unknown): SyncAcquiredSocial['social'] {
  const page = value as Partial<SyncAcquiredSocial['social']> | null;
  const text = (item: unknown, max: number) => typeof item === 'string' && item.trim().length > 0 && item.length <= max && !/[\u0000-\u001f\u007f]/.test(item);
  if (!page || typeof page !== 'object' || Array.isArray(page) ||
      Object.keys(page).some(key => !['records', 'platform', 'account', 'datasetId', 'offset', 'count', 'coverage', 'notice', 'sourceName'].includes(key)) ||
      (page.count !== undefined && (!Number.isSafeInteger(page.count) || !Array.isArray(page.records) || (page.count as number) < page.records.length)) ||
      (page.notice !== undefined && page.notice !== 'run_superseded') ||
      !Array.isArray(page.records) || (page.platform !== 'instagram' && page.platform !== 'facebook') || !text(page.account, 120) ||
      typeof page.datasetId !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(page.datasetId) ||
      !Number.isSafeInteger(page.offset) || (page.offset as number) < 0 || !['complete', 'partial', 'unknown'].includes(page.coverage as string) ||
      !text(page.sourceName, 180) || /[/\\]/.test(page.sourceName as string)) {
    throw new HarnessError(MESSAGES.provider_invalid_result, 422, 'provider_invalid_result');
  }
  return page as SyncAcquiredSocial['social'];
}
function acquired(result: unknown, adapter: SyncAdapter): Acquired {
  const social = result as { social?: unknown } | null;
  if (social && typeof social === 'object' && !Array.isArray(social) && 'social' in social) {
    if (Object.keys(social).length !== 1 || !adapter.social) throw new HarnessError(MESSAGES.provider_invalid_result, 422, 'provider_invalid_result');
    return { kind: 'social', social: acquiredSocial(social.social) };
  }
  const value = result as { json?: unknown } | null;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'json' in value) {
    if (Object.keys(value).length !== 1 || typeof value.json !== 'string' || !value.json || Buffer.byteLength(value.json) > SYNC_JSON_LIMIT || !adapter.derive) {
      throw new HarnessError(MESSAGES.provider_invalid_result, 422, 'provider_invalid_result');
    }
    return { kind: 'json', json: value.json };
  }
  return { kind: 'csv', files: acquiredFiles(result) };
}
/** The adapter's fixed derivation, checked; any refusal is a plain invalid-result failure (no adapter text kept). */
function derived(adapter: SyncAdapter | undefined, json: string): SyncDerivedCsv {
  try {
    const value = adapter?.derive?.csv(json);
    if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 180 || /[/\\\u0000-\u001f\u007f]/.test(value.name) ||
        (value.csv !== null && typeof value.csv !== 'string') || !value.mapping || typeof value.mapping !== 'object') throw new Error();
    return value;
  } catch { throw new HarnessError(MESSAGES.provider_invalid_result, 422, 'provider_invalid_result'); }
}

function acquiredFiles(result: unknown): SyncAcquiredFile[] {
  const files = (result as { files?: unknown } | null)?.files;
  // One file per acquisition in this milestone; per-file keys for several files arrive in a later milestone.
  if (!result || typeof result !== 'object' || Object.keys(result).some(key => key !== 'files') || !Array.isArray(files) || files.length > 1) {
    throw new HarnessError(MESSAGES.provider_invalid_result, 422, 'provider_invalid_result');
  }
  return files.map(file => {
    const value = file as SyncAcquiredFile;
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['name', 'csv', 'mapping'].includes(key)) ||
        typeof value.name !== 'string' || !value.name.trim() || value.name.length > 180 || /[/\\\u0000-\u001f\u007f]/.test(value.name) ||
        typeof value.csv !== 'string' || !value.mapping || typeof value.mapping !== 'object' || Array.isArray(value.mapping)) {
      throw new HarnessError(MESSAGES.provider_invalid_result, 422, 'provider_invalid_result');
    }
    return { name: value.name.trim(), csv: value.csv, mapping: value.mapping };
  });
}

/**
 * One sync at a time per runtime (D-6): due and requested attempts run serially, and a
 * connection is never synced twice at once. Syncs never create `runs` rows, so model runs are
 * not blocked (C1). Each attempt re-checks the owner's membership before any external call.
 */
export function createSyncDispatcher(options: {
  jobs: SyncJobStore;
  connections: ConnectionStore;
  adapters: ReadonlyMap<string, SyncAdapter>;
  limiter: SyncLimiter;
  /** Throws when the stored owner is no longer an admitted member of this runtime's workspace. */
  checkOwner(connection: Connection): Promise<void>;
  importTabular(input: TabularDatasetInput, raw: { sourceId: string; idempotencyKey: string }, metricSource?: MetricSource): TabularImportResult;
  /** Keeps a JSON acquisition verbatim in the raw store under its key (a replay returns the stored receipt). */
  rawJson?(input: { adapter: SourceAdapter<string>; json: string; sourceId: string; accountId: string; idempotencyKey: string }): { receiptId: string };
  rawAcquisition(idempotencyKey: string): { receiptId: string; status: 'completed' | 'failed'; payload: string | null } | undefined;
  /**
   * For providers registered with `oauth`: whether the connection has a saved sign-in, and its session's
   * authorized request. Read only by a live acquisition, never by boot recovery (which makes no external call).
   */
  signIn?(connection: Connection): { signedIn: boolean; request(url: string, init: RequestInit | undefined, limits: { limit?: number; timeoutMs?: number; signal: AbortSignal }): Promise<BoundedResponse>; invalidate(): void };
  /**
   * M9, for adapters with `credential: 'api_token'`: whether the connection has its sealed token, and a way to open it
   * for one live acquisition. Never read by boot recovery (which makes no external call).
   */
  apiToken?(connection: Connection): { configured: boolean; open(): string };
  /** M9, for social adapters: the connection's saved position (its raw checkpoint), read before the fetch. */
  socialCheckpoint?(connection: Connection): SyncSocialCheckpoint | undefined;
  /**
   * M9: one social page through the existing social path (`social.importDataset`) with `requestId` = the attempt's key,
   * under the connection's raw source and offset. A replayed key returns the stored dataset (boot recovery).
   */
  importSocial?(input: { json: string | readonly unknown[]; platform: 'instagram' | 'facebook'; accountId: string; datasetId: string; sourceName: string;
    declaredCoverage: 'complete' | 'partial' | 'unknown'; requestId: string }, raw: { sourceId: string; offset: number }): { id: string; sourceId: string; records: number };
  now?: () => string;
  /** Rebuildable structured facts from a successful raw receipt, never caller-supplied rows. */
  projectJson?(receiptId: string, sourceId: string | null): void;
}) {
  const clock = () => options.now?.() ?? new Date().toISOString();
  const shutdown = new AbortController();
  let closing = false;
  let draining: Promise<void> | undefined;
  let current: { connectionId: string; controller: AbortController } | undefined;
  const waiters = new Map<string, Set<(closed: boolean) => void>>();
  const notify = (id: string, closed = false) => { for (const waiter of waiters.get(id) ?? []) waiter(closed); waiters.delete(id); };

  /** Connection state follows real outcomes: three consecutive failures need attention; a success recovers. */
  const reflect = (attempt: SyncAttempt) => {
    const connection = options.connections.get(attempt.connectionId);
    if (!connection || connection.status === 'disconnected') return;
    const failed = attempt.status === 'failed';
    let status = connection.status;
    // A provider sign-in that ends within a week asks for a reconnect now rather than failing silently later.
    const expiring = connection.reconnectBy !== undefined && Date.parse(connection.reconnectBy) - Date.parse(clock()) <= RECONNECT_WARNING_MS;
    if (!failed) status = expiring ? 'needs_attention' : 'active';
    else if (ATTENTION_NOW.includes(attempt.errorCode ?? '')) status = 'needs_attention';
    else {
      const recent = options.jobs.recentOutcomes(attempt.jobId, 3);
      if (recent.length === 3 && recent.every(item => item === 'failed')) status = 'needs_attention';
    }
    options.connections.update(connection.id, { version: connection.version, ...(status !== connection.status ? { status } : {}),
      lastAttempt: { id: attempt.id, status: failed ? 'failed' : 'succeeded', at: attempt.finishedAt!, ...(failed ? { errorCode: attempt.errorCode! } : {}) } });
  };
  const finish = (attempt: SyncAttempt, outcome: SyncAttemptOutcome): SyncAttempt => {
    const saved = options.jobs.finish(attempt.id, outcome);
    try { reflect(saved); }
    catch { console.error('A sync outcome was saved, but its connection status could not be updated.'); }
    finally { notify(attempt.id); }
    return saved;
  };
  const failWith = (attempt: SyncAttempt, code: string, message = MESSAGES[code] ?? MESSAGES.sync_failed) =>
    finish(attempt, { status: 'failed', errorCode: code, message });

  /** Synchronous import and version record; shared by live syncs and boot recovery, with the same keys. */
  const complete = (attempt: SyncAttempt, csv: string): SyncAttempt => {
    const file = attempt.files[0]!;
    try {
      const saved = options.importTabular({ csv, sourceName: file.name, mapping: file.mapping as unknown as TabularDatasetInput['mapping'] },
        { sourceId: `conn:${attempt.connectionId}`, idempotencyKey: file.key });
      // An identical dataset already stored (an upload or an earlier acquisition) writes no receipt.
      const receipt = saved.receiptId ?? options.rawAcquisition(file.key);
      const rawReceiptId = typeof receipt === 'string' ? receipt : receipt?.status === 'completed' ? receipt.receiptId : null;
      const recorded = options.connections.recordVersion({ id: attempt.id, connectionId: attempt.connectionId, kind: 'tabular',
        datasetId: saved.id, sourceId: saved.source.id, rawReceiptId, contentHash: file.contentHash, observedAt: file.observedAt });
      return finish(attempt, { status: recorded.unchanged ? 'unchanged' : 'completed', versionIds: recorded.unchanged ? [] : [recorded.version.id],
        bytes: file.bytes, records: saved.rowCount });
    } catch (error) {
      const { code, message } = outcomeOf(error, 'sync_failed');
      return failWith(attempt, code, message);
    }
  };

  /**
   * A JSON acquisition (M8 pipeline): 1. keep the provider JSON verbatim under the attempt's key, 2. derive the CSV with
   * the adapter's fixed code, 3. import it under `<key>-t` with raw source `conn:<id>:tabular`, 4. record the version with
   * the JSON's receipt. Shared by live syncs and boot recovery, with the same keys, so a replay writes nothing twice.
   */
  const completeJson = (attempt: SyncAttempt, json: string, connection: Connection, adapter: SyncAdapter): SyncAttempt => {
    const file = attempt.files[0]!;
    try {
      if (!options.rawJson) throw new HarnessError(MESSAGES.provider_invalid_result, 422, 'provider_invalid_result');
      const raw = options.rawJson({ adapter: adapter.derive!.source, json, sourceId: `conn:${attempt.connectionId}`, accountId: connection.accountKey, idempotencyKey: file.key });
      const csv = derived(adapter, json);
      if (csv.metricSource && (csv.metricSource.provider !== connection.provider || csv.metricSource.accountId !== connection.providerAccountId)) {
        throw new HarnessError(MESSAGES.provider_invalid_result, 422, 'provider_invalid_result');
      }
      // An empty window keeps its raw JSON but has no table to import: honest "no posts", never zero activity.
      if (csv.csv === null) {
        options.projectJson?.(raw.receiptId, null);
        return finish(attempt, { status: 'unchanged', versionIds: [], bytes: file.bytes, records: 0, message: 'No records were found in the sync window.' });
      }
      const saved = options.importTabular({ csv: csv.csv, sourceName: csv.name, mapping: csv.mapping },
        { sourceId: `conn:${attempt.connectionId}:tabular`, idempotencyKey: `${file.key}-t` }, csv.metricSource);
      options.projectJson?.(raw.receiptId, saved.source.id);
      const recorded = options.connections.recordVersion({ id: attempt.id, connectionId: attempt.connectionId, kind: 'tabular',
        datasetId: saved.id, sourceId: saved.source.id, rawReceiptId: raw.receiptId, contentHash: file.contentHash, observedAt: file.observedAt });
      return finish(attempt, { status: recorded.unchanged ? 'unchanged' : 'completed', versionIds: recorded.unchanged ? [] : [recorded.version.id],
        bytes: file.bytes, records: saved.rowCount });
    } catch (error) {
      const { code, message } = outcomeOf(error, 'sync_failed');
      return failWith(attempt, code, message);
    }
  };

  /**
   * A social page (M9): the existing social path with `requestId` = the attempt's key and the connection's raw source,
   * then a `kind: 'social'` version with the page's receipt. Shared by live syncs and boot recovery, with the same key,
   * so a replay returns the stored dataset and writes nothing twice. The checkpoint moves only when the page commits.
   */
  const completeSocial = (attempt: SyncAttempt, json: string | readonly unknown[]): SyncAttempt => {
    const file = attempt.files[0]!;
    const page = file.mapping as { platform: 'instagram' | 'facebook'; account: string; datasetId: string; offset: number; count?: number; coverage: 'complete' | 'partial' | 'unknown'; notice?: 'run_superseded' };
    try {
      if (!options.importSocial) throw new HarnessError(MESSAGES.provider_invalid_result, 422, 'provider_invalid_result');
      const saved = options.importSocial({ json, platform: page.platform, accountId: page.account, datasetId: page.datasetId, sourceName: file.name,
        declaredCoverage: page.coverage, requestId: file.key }, { sourceId: `conn:${attempt.connectionId}`, offset: page.offset, ...(page.count !== undefined ? { count: page.count } : {}) });
      const receipt = options.rawAcquisition(file.key);
      const recorded = options.connections.recordVersion({ id: attempt.id, connectionId: attempt.connectionId, kind: 'social',
        datasetId: saved.id, sourceId: saved.sourceId, rawReceiptId: receipt?.status === 'completed' ? receipt.receiptId : null,
        contentHash: file.contentHash, observedAt: file.observedAt });
      return finish(attempt, { status: recorded.unchanged ? 'unchanged' : 'completed', versionIds: recorded.unchanged ? [] : [recorded.version.id],
        bytes: file.bytes, records: saved.records, ...(page.notice ? { message: MESSAGES[page.notice]! } : {}) });
    } catch (error) {
      const { code, message } = outcomeOf(error, 'sync_failed');
      return failWith(attempt, code, message);
    }
  };

  const run = async (attempt: SyncAttempt): Promise<void> => {
    const connection = options.connections.get(attempt.connectionId);
    if (!connection || connection.status === 'disconnected') { failWith(attempt, 'connection_disconnected'); return; }
    const adapter = options.adapters.get(connection.provider);
    if (!adapter) { failWith(attempt, 'provider_unavailable'); return; }
    const controller = new AbortController();
    current = { connectionId: connection.id, controller };
    let release: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      try { release = await options.limiter.acquire(AbortSignal.any([shutdown.signal, controller.signal])); }
      catch { if (!closing) failWith(attempt, 'connection_disconnected'); return; }
      if (closing) return;
      // Membership is re-checked before every acquisition: removal, suspension or an unready workspace fail here.
      try { await abortable(options.checkOwner(connection), shutdown.signal); }
      catch (error) { if (!closing) failWith(attempt, membershipOutcome(error)); return; }
      if (closing) return;
      const fresh = options.connections.get(connection.id);
      if (!fresh || fresh.status === 'disconnected' || controller.signal.aborted) { failWith(attempt, 'connection_disconnected'); return; }
      // A provider that needs an account and has no saved sign-in fails before any external call.
      const signIn = adapter.oauth ? options.signIn?.(fresh) : undefined;
      if (adapter.oauth && !signIn?.signedIn) { failWith(attempt, 'sign_in_required'); return; }
      // M9: a provider that needs the connection's own API token fails before any external call without one. There is
      // no installation-wide fallback (APIFY_TOKEN is never used here).
      const token = adapter.credential === 'api_token' ? options.apiToken?.(fresh) : undefined;
      if (adapter.credential === 'api_token' && !token?.configured) { failWith(attempt, 'api_token_required'); return; }
      const checkpoint = adapter.social ? options.socialCheckpoint?.(fresh) ?? null : undefined;
      const started = options.jobs.start(attempt.id);
      const bound = new AbortController();
      const deadline = Date.now() + adapter.timeoutMs;
      timer = setTimeout(() => bound.abort(new HarnessError('Sync time limit reached.', 504, 'sync_timeout')), adapter.timeoutMs);
      timer.unref?.();
      // Aborted the moment the acquisition settles, so nothing it started keeps running unbounded (M8 security review).
      const settled = new AbortController();
      const signal = AbortSignal.any([shutdown.signal, controller.signal, bound.signal, settled.signal]);
      let result: Acquired;
      try {
        result = acquired(await abortable(adapter.acquire({
          connection: { id: fresh.id, provider: fresh.provider, providerAccountId: fresh.providerAccountId, displayName: fresh.displayName, ...(fresh.mapping ? { mapping: fresh.mapping } : {}) },
          attempt: { id: started.id, trigger: started.trigger, scheduledFor: started.scheduledFor, attempt: started.attempt },
          signal, deadline,
          // An adapter may narrow a request with its own signal (for example to stop its other requests); never widen it.
          ...(signIn ? { oauth: { request: (url: string, init?: RequestInit, limits: { limit?: number; timeoutMs?: number } = {}) =>
            signIn.request(url, init, { ...limits, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }), invalidate: () => signIn.invalidate() } } : {}),
          ...(token ? { apiToken: () => token.open() } : {}),
          ...(checkpoint !== undefined ? { checkpoint } : {}),
        }), signal), adapter);
      } catch (error) {
        settled.abort(new HarnessError('The acquisition ended.', 499, 'sync_settled'));
        // On shutdown the attempt stays `started`; boot recovery finishes or retries it.
        if (closing) return;
        const seconds = Math.ceil(adapter.timeoutMs / 1000);
        if (bound.signal.aborted) { failWith(started, 'sync_timeout', `The provider did not answer within ${seconds} second${seconds === 1 ? '' : 's'}. The next sync will try again.`); return; }
        if (controller.signal.aborted) { failWith(started, 'connection_disconnected'); return; }
        const { code, message } = acquisitionOutcome(error, adapter.credential);
        failWith(started, code, message);
        return;
      }
      settled.abort(new HarnessError('The acquisition ended.', 499, 'sync_settled'));
      clearTimeout(timer);
      if (closing) return;
      // A fetch can take minutes: check the owner again, and the connection, before anything is stored.
      try { await abortable(options.checkOwner(fresh), shutdown.signal); }
      catch (error) { if (!closing) failWith(started, membershipOutcome(error)); return; }
      if (closing) return;
      if (options.connections.get(connection.id)?.status === 'disconnected' || controller.signal.aborted) { failWith(started, 'connection_disconnected'); return; }
      const observedAt = new Date(clock()).toISOString();
      if (result.kind === 'social') {
        const page = result.social;
        // Nothing new since the checkpoint: no raw commit, no version, and the position stays where it was.
        // Only empty items after the checkpoint are not stored either; they are read again with whatever follows them.
        if (!page.records.length) { finish(started, { status: 'unchanged', versionIds: [], bytes: 0, records: 0, message: page.notice ? MESSAGES[page.notice]! : 'No new records since the last sync.' }); return; }
        // The social adapter keeps an array boundary as its re-serialization (payloadEncoding `reserialized`), so this
        // is the payload the raw store hashes; boot recovery compares it before replaying.
        const payload = JSON.stringify(page.records, null, 2);
        const recordedSocial = options.jobs.recordFiles(started.id, [{ key: started.idempotencyKey, name: page.sourceName, format: 'social',
          contentHash: sha256(payload), bytes: Buffer.byteLength(payload), observedAt,
          mapping: { platform: page.platform, account: page.account, datasetId: page.datasetId, offset: page.offset, count: page.count ?? page.records.length,
            coverage: page.coverage, ...(page.notice ? { notice: page.notice } : {}) } }]);
        completeSocial(recordedSocial, page.records);
        return;
      }
      if (result.kind === 'json') {
        let mapping: SyncDerivedCsv;
        try { mapping = derived(adapter, result.json); }
        catch (error) { const { code, message } = outcomeOf(error, 'provider_error'); failWith(started, code, message); return; }
        const recordedJson = options.jobs.recordFiles(started.id, [{ key: started.idempotencyKey, name: mapping.name, format: 'json',
          contentHash: sha256(result.json), bytes: Buffer.byteLength(result.json), observedAt, mapping: mapping.mapping as unknown as Record<string, unknown> }]);
        completeJson(recordedJson, result.json, fresh, adapter);
        return;
      }
      const files = result.files;
      if (!files.length) { finish(started, { status: 'unchanged', versionIds: [], bytes: 0, records: 0 }); return; }
      const recorded = options.jobs.recordFiles(started.id, files.map(file => ({ key: started.idempotencyKey, name: file.name,
        contentHash: sha256(file.csv), bytes: Buffer.byteLength(file.csv), observedAt, mapping: file.mapping as unknown as Record<string, unknown> })));
      complete(recorded, files[0]!.csv);
    } catch (error) {
      if (closing) return;
      const saved = options.jobs.attempt(attempt.id);
      if (saved && !TERMINAL.includes(saved.status)) { const { code, message } = outcomeOf(error, 'sync_failed'); failWith(saved, code, message); }
    } finally {
      if (timer) clearTimeout(timer);
      release?.();
      if (current?.controller === controller) current = undefined;
    }
  };

  const drain = (): Promise<void> => {
    if (closing) return Promise.resolve();
    draining ??= (async () => {
      for (let guard = 0; guard < 10_000 && !closing; guard++) {
        const next = options.jobs.nextPending();
        if (!next) break;
        await run(next);
        // A safety net: one attempt can never hold the queue.
        const after = closing ? undefined : options.jobs.attempt(next.id);
        if (after?.status === 'pending') failWith(after, 'sync_failed');
      }
    })().catch(() => { console.error('Sync dispatch could not finish; saved attempts will be retried.'); })
      .finally(() => {
        draining = undefined;
        // A request that arrived as the queue emptied is picked up now, not at the next tick.
        if (!closing && options.jobs.nextPending()) void drain();
      });
    return draining;
  };
  const wait = (id: string, ms = SYNC_WAIT_MS): Promise<SyncAttempt | undefined> => {
    if (closing) return Promise.resolve(undefined);
    const saved = options.jobs.attempt(id);
    if (!saved || TERMINAL.includes(saved.status)) return Promise.resolve(saved);
    return new Promise(resolve => {
      const set = waiters.get(id) ?? new Set();
      const done = (closed: boolean) => { clearTimeout(timer); set.delete(done); resolve(closed ? undefined : options.jobs.attempt(id)); };
      const timer = setTimeout(() => { done(closing); }, ms);
      timer.unref?.();
      set.add(done); waiters.set(id, set);
    });
  };

  return {
    /** Claim due slots (no catch-up), then run pending attempts serially. */
    tick(): Promise<void> {
      if (closing) return Promise.resolve();
      try { options.jobs.claimDue(clock()); }
      catch { console.error('Due syncs could not be claimed; they will be retried.'); }
      return drain();
    },
    /** "Sync now" or pre-sync: reuse the connection's pending or started attempt, else queue a new one. */
    request(connectionId: string, trigger: 'manual' | 'presync' | 'connect'): { attempt: SyncAttempt; reused: boolean } {
      if (closing) throw new HarnessError('The harness is closing.', 503, 'harness_closed');
      const job = options.jobs.forConnection(connectionId) ?? options.jobs.ensure(connectionId);
      const result = options.jobs.request(job.id, trigger, clock());
      void drain();
      return result;
    },
    /** Resolves with the attempt once it settles, or with its current state after `ms`. */
    wait,
    /**
     * Boot recovery, before the first tick. A `started` attempt whose raw acquisition committed is
     * finished with the same key and version ID; anything else is marked interrupted and retried.
     */
    recover(): { completed: string[]; interrupted: string[] } {
      const outcome = { completed: [] as string[], interrupted: [] as string[] };
      for (const attempt of options.jobs.started()) {
        // The version is written before the attempt's own outcome. If it exists, the acquisition finished;
        // this also covers identical content already stored, which writes no raw receipt.
        const written = options.connections.version(attempt.id);
        if (written && written.connectionId === attempt.connectionId) {
          const file = attempt.files[0];
          finish(attempt, { status: 'completed', versionIds: [attempt.id], ...(file ? { bytes: file.bytes } : {}) });
          outcome.completed.push(attempt.id);
          continue;
        }
        const file = attempt.files.length === 1 ? attempt.files[0] : undefined;
        const raw = file ? options.rawAcquisition(file.key) : undefined;
        const connection = options.connections.get(attempt.connectionId);
        const adapter = connection ? options.adapters.get(connection.provider) : undefined;
        if (file?.format === 'social' && raw?.status === 'completed' && raw.payload !== null && sha256(raw.payload) === file.contentHash && options.importSocial) {
          // The page committed under its own key: the social path replays it (no fetch) and the version is written.
          completeSocial(attempt, raw.payload);
          outcome.completed.push(attempt.id);
        } else if (file?.format === 'json' && raw?.status === 'completed' && raw.payload !== null && sha256(raw.payload) === file.contentHash && connection && adapter?.derive) {
          // The JSON committed under its own key: re-derive with the same fixed code and finish with the same keys.
          completeJson(attempt, raw.payload, connection, adapter);
          outcome.completed.push(attempt.id);
        } else if (file && file.format === undefined && raw?.status === 'completed' && raw.payload !== null && sha256(raw.payload) === file.contentHash) {
          complete(attempt, raw.payload);
          outcome.completed.push(attempt.id);
        } else {
          options.jobs.interrupt(attempt.id);
          notify(attempt.id);
          outcome.interrupted.push(attempt.id);
        }
      }
      return outcome;
    },
    /** Disconnect aborts an acquisition in flight for that connection. */
    abort(connectionId: string) { if (current?.connectionId === connectionId) current.controller.abort(new HarnessError(MESSAGES.connection_disconnected, 409, 'connection_disconnected')); },
    async close(): Promise<void> {
      closing = true;
      shutdown.abort(new HarnessError('The harness is closing.', 503, 'harness_closed'));
      for (const id of [...waiters.keys()]) notify(id, true);
      await draining;
    },
  };
}
