import { APIFY_DATASET_ID, APIFY_LIMITS, APIFY_TASK_ID, ApifyProviderError, createApifyConnector } from './apify-connector.ts';
import { HarnessError } from './errors.ts';
import type { SyncAdapter, SyncAdapterContext, SyncAcquiredSocial } from './sync-dispatch.ts';

/*
 * Apify as a per-connection scheduled pull (M9). Each connection reads one Apify dataset, or the default dataset of a
 * task's newest successful run, with the API token its owner entered in Settings. The token is sealed per connection
 * (M6 vault); there is no installation-wide fallback, so `APIFY_TOKEN` is never used by a connection.
 *
 *   - Transport: the existing Apify connector, pinned to https://api.apify.com, redirects refused, token in a header.
 *   - Position: each sync starts at the connection's checkpoint (the `runSync` cursor of its raw source) and reads at most
 *     one page. The checkpoint belongs to the dataset its last page came from: a task's new run starts again at 0.
 *   - Pipeline: the existing social path (`social.importDataset`), versioned with `kind: 'social'`.
 *
 * Nothing here logs. Errors are fixed codes; a provider's own text or body never leaves this module.
 */

export const APIFY_PROVIDER_ID = 'apify';
export const APIFY_LABEL = 'Apify dataset or task';
/** One acquisition: at most a task-run lookup and one dataset page, each bounded to 20 seconds. */
export const APIFY_SYNC_TIMEOUT_MS = 60_000;
export type ApifySourceKind = 'dataset' | 'task';
export type ApifyPlatform = 'instagram' | 'facebook';
/** What an owner enters in Settings → Add connection. The token is sealed and never returned. */
export interface ApifyConnectionSetup { token: string; source: ApifySourceKind; id: string; platform: ApifyPlatform; account: string }

const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const ACCOUNT = /^[^/\\\u0000-\u001f\u007f]{1,120}$/;
const PLATFORM_LABELS: Record<ApifyPlatform, string> = { instagram: 'Instagram', facebook: 'Facebook' };
const invalid = (message: string): never => { throw new HarnessError(message, 400, 'invalid_connection'); };

/**
 * Validates the Add-connection fields for Apify. Messages name the field, never repeat a value, so a mistyped token is
 * never echoed back.
 */
export function apifyConnectionSetup(input: unknown): ApifyConnectionSetup {
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['token', 'source', 'id', 'platform', 'account'].includes(key))) {
    return invalid('Provide the Apify API token, whether it is a dataset or a task, its ID, the platform and the account.');
  }
  const token = typeof value.token === 'string' ? value.token.trim() : '';
  if (!TOKEN.test(token)) return invalid('Paste the Apify API token from Apify Console → Settings → API & Integrations.');
  if (value.source !== 'dataset' && value.source !== 'task') return invalid('Choose whether this connection reads a dataset or a task.');
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (value.source === 'dataset' ? !APIFY_DATASET_ID.test(id) : !APIFY_TASK_ID.test(id)) {
    return invalid(value.source === 'dataset' ? 'Enter the Apify dataset ID: 1–64 letters or digits.' : 'Enter the Apify task ID, or owner~task-name.');
  }
  if (value.platform !== 'instagram' && value.platform !== 'facebook') return invalid('Choose Instagram or Facebook: their post fields differ and are never guessed.');
  const account = typeof value.account === 'string' ? value.account.trim() : '';
  if (!ACCOUNT.test(account)) return invalid('Name the account these posts belong to, in 1–120 characters without slashes.');
  return { token, source: value.source, id, platform: value.platform, account };
}

/** The connection's saved, non-secret data: the dataset or task it reads (its account identity) and the post mapping. */
export function apifyConnectionData(setup: ApifyConnectionSetup): { providerAccountId: string; mapping: { platform: ApifyPlatform; account: string } } {
  return { providerAccountId: `${setup.source}:${setup.id}`, mapping: { platform: setup.platform, account: setup.account } };
}

/** The saved target and mapping, checked again before every fetch (saved data is never trusted blindly). */
function savedTarget(connection: SyncAdapterContext['connection']) {
  const [kind, ...rest] = connection.providerAccountId.split(':');
  const id = rest.join(':');
  const mapping = connection.mapping as { platform?: unknown; account?: unknown } | undefined;
  if ((kind !== 'dataset' && kind !== 'task') || !(kind === 'dataset' ? APIFY_DATASET_ID : APIFY_TASK_ID).test(id) ||
      (mapping?.platform !== 'instagram' && mapping?.platform !== 'facebook') || typeof mapping.account !== 'string' || !ACCOUNT.test(mapping.account)) {
    throw new HarnessError('This connection setup cannot be read.', 422, 'provider_invalid_result');
  }
  return { kind: kind as ApifySourceKind, id, platform: mapping.platform as ApifyPlatform, account: mapping.account };
}

/** Apify's answer, as a fixed sync outcome code. A refused or missing token asks the owner for a current one. */
function classify(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason;
  if (error instanceof ApifyProviderError) {
    if (error.providerStatus === 401 || error.providerStatus === 403) return new HarnessError('Apify refused the token.', 401, 'api_token_required');
    if (error.providerStatus === 404) return new HarnessError('Apify could not find the dataset or task.', 404, 'provider_not_found');
    if (error.providerStatus === 429) return new HarnessError('Apify is limiting requests.', 429, 'rate_limited');
    return new HarnessError('Apify could not be read.', 502, 'provider_error');
  }
  if (error instanceof HarnessError) {
    if (['credential_unreadable', 'credential_setup_required', 'api_token_required'].includes(error.code)) return error;
    if (error.code === 'apify_not_configured') return new HarnessError('No Apify token.', 401, 'api_token_required');
    if (['apify_invalid_response', 'apify_response_too_large', 'apify_record_limit', 'provider_invalid_result'].includes(error.code)) return new HarnessError('Apify returned data this workspace cannot import.', 422, 'provider_invalid_result');
  }
  return new HarnessError('Apify could not be read.', 502, 'provider_error');
}

export interface ApifyAdapterOptions {
  /** Tests only: the fetch the transport uses; URLs are still built for the pinned https://api.apify.com. */
  fetch?: typeof globalThis.fetch;
  /** Records per sync, 1–1,000 (default 1,000). A larger dataset continues at the next sync. */
  pageSize?: number;
}

/** The Apify sync adapter. Registered only when HARNESS_CONNECTOR_APIFY is 1 (default 0), or by tests in code. */
export function createApifyAdapter(options: ApifyAdapterOptions = {}): SyncAdapter {
  const pageSize = options.pageSize ?? APIFY_LIMITS.records;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > APIFY_LIMITS.records) throw new HarnessError('Read 1–1,000 Apify records per sync.', 400, 'invalid_connections');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new HarnessError('Pass a fetch function for tests only.', 400, 'invalid_connections');
  return Object.freeze({
    id: APIFY_PROVIDER_ID, label: APIFY_LABEL, timeoutMs: APIFY_SYNC_TIMEOUT_MS, credential: 'api_token' as const, social: true as const,
    async acquire(context: SyncAdapterContext): Promise<SyncAcquiredSocial> {
      const target = savedTarget(context.connection);
      if (!context.apiToken) throw new HarnessError('No Apify token.', 401, 'api_token_required');
      try {
        // Opened for this acquisition only; it lives in this closure and the connector's request header, nowhere else.
        const connector = createApifyConnector({ token: context.apiToken(), ...(options.fetch ? { fetch: options.fetch } : {}) });
        const datasetId = target.kind === 'dataset' ? target.id : (await connector.lastTaskRun({ taskId: target.id, signal: context.signal })).datasetId;
        // The checkpoint is a position in the dataset its last page came from. Another dataset (a task's newer run)
        // starts at 0; an unreadable cursor also starts at 0 rather than guessing.
        const saved = context.checkpoint;
        const cursor = saved && saved.cursor !== null && /^(0|[1-9][0-9]{0,14})$/.test(saved.cursor) ? Number(saved.cursor) : null;
        const offset = saved && saved.datasetId === datasetId && cursor !== null ? cursor : 0;
        // A task's newer run replaced the dataset the checkpoint points into. If that run still had records after the
        // checkpoint, they are skipped: say so on the attempt rather than silently. An unreadable answer says nothing.
        let notice: 'run_superseded' | undefined;
        if (target.kind === 'task' && saved?.datasetId && saved.datasetId !== datasetId && APIFY_DATASET_ID.test(saved.datasetId) && cursor !== null) {
          try {
            const rest = await connector.fetchDataset({ datasetId: saved.datasetId, offset: cursor, limit: 1, skipEmpty: false, signal: context.signal });
            if (rest.records.length || (rest.total !== null && rest.total > cursor)) notice = 'run_superseded';
          } catch (error) { if (context.signal.aborted) throw error; }
        }
        // `skipEmpty: false` (skipHidden only): every item in the window comes back, so the page's position count is
        // exact. Empty items are dropped here, but still counted, so the checkpoint never falls behind and repeats posts.
        const fetched = await connector.fetchDataset({ datasetId, offset, limit: pageSize, skipEmpty: false, signal: context.signal });
        const records = fetched.records.filter(item => !(item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0));
        const count = fetched.records.length;
        // Complete only when this page read the whole dataset from its start: by Apify's total when it gives one,
        // otherwise by a page shorter than requested.
        const complete = offset === 0 && (fetched.total !== null ? count >= fetched.total : count < pageSize);
        return { social: {
          records, platform: target.platform, account: target.account, datasetId, offset, count,
          coverage: complete ? 'complete' : 'partial', ...(notice ? { notice } : {}),
          sourceName: `Apify ${PLATFORM_LABELS[target.platform]} · ${target.account}`,
        } };
      } catch (error) { throw classify(error, context.signal); }
    },
  });
}
