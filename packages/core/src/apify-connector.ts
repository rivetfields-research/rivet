import { HarnessError } from './errors.ts';

/**
 * Acquisition boundary for public social posts held in an Apify dataset.
 *
 * The connector only *fetches*: parsing, normalization and summarization stay in the social data
 * layer, so a dataset obtained here is handled exactly like one the operator supplied by hand.
 * Transport is pinned to the canonical Apify host over HTTPS, redirects are refused, and the token
 * travels in a request header — it never appears in a URL, an error message or a trace.
 */

export const APIFY_LIMITS = Object.freeze({ records: 1_000, bytes: 10 * 1024 * 1024, timeoutMs: 20_000 });
const APIFY_HOST = 'api.apify.com';
const APIFY_BASE = `https://${APIFY_HOST}/v2`;
const DATASET_ID = /^[a-zA-Z0-9]{1,64}$/;
/** An Apify task: its ID, or `owner~task-name` (M9). Never a URL or a path. */
export const APIFY_TASK_ID = /^(?:[a-zA-Z0-9]{1,64}|[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}~[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})$/;
export const APIFY_DATASET_ID = DATASET_ID;

/**
 * Apify answered with a non-success status. The message carries the status only, never the body; `providerStatus`
 * lets a sync classify it (token refused, not found, rate limited) without parsing text (M9).
 */
export class ApifyProviderError extends HarnessError {
  constructor(public providerStatus: number) {
    super(`Apify refused the dataset request (HTTP ${providerStatus}). Check the dataset id and token, then retry.`, 502, 'apify_error');
  }
}

export interface ApifyFetchRequest {
  readonly datasetId: string;
  readonly offset: number;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

/** Injected so a test never needs a socket, a token or a paid call. */
export type ApifyFetch = (request: ApifyFetchRequest) => Promise<readonly unknown[]>;

export interface ApifyConnectorConfig {
  /** Read from `APIFY_TOKEN` when not passed. Absent means the connector is not configured. */
  readonly token?: string | null;
  /** Defaults to the canonical Apify API. Any replacement must still be that pinned host. */
  readonly baseUrl?: string;
  readonly maxRecords?: number;
  readonly timeoutMs?: number;
  /** Tests only: the fetch the transport uses (it still builds the pinned https://api.apify.com URL). */
  readonly fetch?: typeof globalThis.fetch;
}

/** The newest successful run of an Apify task (M9). */
export interface ApifyTaskRun { readonly runId: string; readonly datasetId: string; readonly finishedAt: string | null }

export interface FetchedPublicPosts {
  readonly datasetId: string;
  readonly records: readonly unknown[];
  readonly fetchedAt: string;
  /** True only when this call actually reached a provider; an injected fetcher reports false. */
  readonly network: boolean;
  /** Items in the whole dataset, from `X-Apify-Pagination-Total`; null when Apify did not say (or a fetcher was injected). */
  readonly total: number | null;
}

export interface ApifyConnector {
  readonly configured: boolean;
  /** The pinned origin this connector will talk to, for a review or a diagnostic line. */
  readonly origin: string;
  /** `offset` (default 0) is the first record to read: a scheduled pull continues from its checkpoint (M9). */
  fetchDataset(input: { datasetId: string; limit?: number; offset?: number; signal?: AbortSignal; skipEmpty?: boolean }): Promise<FetchedPublicPosts>;
  /** The task's newest successful run and its default dataset (M9). Needs the HTTP transport, not an injected fetcher. */
  lastTaskRun(input: { taskId: string; signal?: AbortSignal }): Promise<ApifyTaskRun>;
}

/** One bounded GET to the pinned host with the token in a header; redirects are refused and only the status is kept. */
async function pinnedGet(config: { token: string; timeoutMs: number; fetch: typeof globalThis.fetch }, url: URL, signal?: AbortSignal): Promise<{ value: unknown; headers: Headers }> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await config.fetch(url, {
      headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
      redirect: 'error',
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new HarnessError('The Apify dataset could not be reached. Check connectivity and retry.', 502, 'apify_unreachable');
  }
  if (!response.ok) {
    // Status only: a provider body can echo request details back.
    await response.body?.cancel().catch(() => {});
    throw new ApifyProviderError(response.status);
  }
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > APIFY_LIMITS.bytes) {
    throw new HarnessError('The Apify dataset response is larger than this connector accepts; request fewer records.', 413, 'apify_response_too_large');
  }
  const text = await readBounded(response);
  try { return { value: JSON.parse(text), headers: response.headers }; }
  catch { throw new HarnessError('Apify returned a response that is not a dataset array.', 502, 'apify_invalid_response'); }
}

type HttpConfig = { token: string; origin: string; timeoutMs: number; fetch: typeof globalThis.fetch };
/**
 * One page of dataset items. `skipEmpty` (the operator route's `clean=true`) lets Apify drop empty items *after* the
 * offset is applied, so a page can hold fewer items than it covers. A scheduled pull (M9) therefore asks for
 * `skipHidden=true` only: every item in the window comes back, and its position count is exact. `total` is Apify's
 * `X-Apify-Pagination-Total` when present.
 */
async function httpPage(config: HttpConfig, request: ApifyFetchRequest & { skipEmpty: boolean }): Promise<{ items: unknown[]; total: number | null }> {
  const url = new URL(`${config.origin}/datasets/${request.datasetId}/items`);
  url.searchParams.set('format', 'json');
  if (request.skipEmpty) url.searchParams.set('clean', 'true');
  else url.searchParams.set('skipHidden', 'true');
  url.searchParams.set('offset', String(request.offset));
  url.searchParams.set('limit', String(request.limit));
  const { value, headers } = await pinnedGet(config, url, request.signal);
  if (!Array.isArray(value)) throw new HarnessError('Apify returned a response that is not a dataset array.', 502, 'apify_invalid_response');
  const header = headers.get('x-apify-pagination-total');
  const total = header !== null && /^(0|[1-9][0-9]{0,14})$/.test(header.trim()) ? Number(header.trim()) : null;
  return { items: value, total };
}


async function readBounded(response: Response): Promise<string> {
  if (!response.body) throw new HarnessError('Apify returned an empty response body.', 502, 'apify_invalid_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > APIFY_LIMITS.bytes) {
        await reader.cancel().catch(() => {});
        throw new HarnessError('The Apify dataset response is larger than this connector accepts; request fewer records.', 413, 'apify_response_too_large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError('The Apify response could not be read as UTF-8 JSON.', 502, 'apify_invalid_response');
  }
  return text;
}

export function createApifyConnector(config: ApifyConnectorConfig = {}, fetcher?: ApifyFetch): ApifyConnector {
  const token = typeof config.token === 'string' ? config.token.trim() : '';
  const origin = (config.baseUrl ?? APIFY_BASE).replace(/\/+$/, '');
  const parsed = (() => { try { return new URL(origin); } catch { return null; } })();
  // A replacement origin must still be the canonical host over HTTPS: the token is only ever sent
  // to the provider it belongs to.
  if (!parsed || parsed.protocol !== 'https:' || parsed.hostname !== APIFY_HOST || parsed.username || parsed.password) {
    throw new HarnessError(`Use the canonical https://${APIFY_HOST} API for public social fetching.`, 400, 'apify_invalid_endpoint');
  }
  const maxRecords = config.maxRecords ?? APIFY_LIMITS.records;
  const transport = { token, origin, timeoutMs: config.timeoutMs ?? APIFY_LIMITS.timeoutMs, fetch: config.fetch ?? ((input: URL | RequestInfo, init?: RequestInit) => globalThis.fetch(input, init)) };
  const notConfigured = () => new HarnessError('Public social fetching is not configured. Set APIFY_TOKEN for this process, or pass an Apify connector with a token, before fetching a dataset.', 503, 'apify_not_configured');
  return {
    configured: Boolean(token),
    origin,
    /**
     * `skipEmpty` (default true, as the operator route always did) sends `clean=true`. A scheduled pull passes false:
     * every item in the window is returned, so `records.length` is the number of positions the page covers (M9).
     */
    async fetchDataset(input: { datasetId: string; limit?: number; offset?: number; signal?: AbortSignal; skipEmpty?: boolean }): Promise<FetchedPublicPosts> {
      // An unconfigured connector refuses with what to do about it, and never opens a socket.
      if (!token) throw notConfigured();
      const datasetId = typeof input?.datasetId === 'string' ? input.datasetId.trim() : '';
      if (!DATASET_ID.test(datasetId)) {
        throw new HarnessError('Provide the Apify dataset id: 1–64 letters or digits, as shown on the completed run.', 400, 'invalid_dataset_id');
      }
      const limit = input.limit ?? maxRecords;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxRecords) {
        throw new HarnessError(`Request between 1 and ${maxRecords.toLocaleString('en-US')} records; page the dataset for more.`, 400, 'invalid_limit');
      }
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + limit)) {
        throw new HarnessError('Start the dataset read at a whole, non-negative record offset.', 400, 'invalid_offset');
      }
      const request = { datasetId, offset, limit, ...(input.signal ? { signal: input.signal } : {}) };
      const page = fetcher ? { items: await fetcher(request), total: null } : await httpPage(transport, { ...request, skipEmpty: input.skipEmpty !== false });
      const records = page.items;
      if (!Array.isArray(records)) throw new HarnessError('The Apify fetcher must resolve to an array of dataset records.', 502, 'apify_invalid_response');
      if (records.length > maxRecords) {
        throw new HarnessError(`The dataset returned more than ${maxRecords.toLocaleString('en-US')} records; request a bounded window.`, 413, 'apify_record_limit');
      }
      return { datasetId, records, fetchedAt: new Date().toISOString(), network: fetcher === undefined, total: page.total };
    },
    async lastTaskRun(input: { taskId: string; signal?: AbortSignal }): Promise<ApifyTaskRun> {
      if (!token) throw notConfigured();
      const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : '';
      if (!APIFY_TASK_ID.test(taskId)) throw new HarnessError('Provide the Apify task ID, or owner~task-name, as shown in Apify Console.', 400, 'invalid_task_id');
      if (fetcher) throw new HarnessError('Reading an Apify task needs the HTTP transport.', 500, 'apify_invalid_endpoint');
      // GET /v2/actor-tasks/{task}/runs/last?status=SUCCEEDED: the newest finished, successful run only. A run still in
      // progress, failed or aborted is never read, so a sync never imports a partial collection.
      const url = new URL(`${origin}/actor-tasks/${encodeURIComponent(taskId)}/runs/last`);
      url.searchParams.set('status', 'SUCCEEDED');
      const value = (await pinnedGet(transport, url, input.signal)).value as { data?: Record<string, unknown> } | null;
      const run = value && typeof value === 'object' && value.data && typeof value.data === 'object' ? value.data : undefined;
      if (!run || run.status !== 'SUCCEEDED' || typeof run.id !== 'string' || !DATASET_ID.test(run.id) ||
          typeof run.defaultDatasetId !== 'string' || !DATASET_ID.test(run.defaultDatasetId)) {
        throw new HarnessError('Apify returned a task run this connector cannot read.', 502, 'apify_invalid_response');
      }
      const finished = typeof run.finishedAt === 'string' && Number.isFinite(Date.parse(run.finishedAt)) ? new Date(run.finishedAt).toISOString() : null;
      return { runId: run.id, datasetId: run.defaultDatasetId, finishedAt: finished };
    },
  };
}

/** The runtime configuration: `APIFY_TOKEN`, read at call time rather than baked into a build. */
export function apifyConnectorFromEnv(env: Record<string, string | undefined> = process.env): ApifyConnector {
  return createApifyConnector({ token: env.APIFY_TOKEN ?? '' });
}
