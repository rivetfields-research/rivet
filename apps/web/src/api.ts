import type { DataDiagnostic } from '../../../packages/data-layer/src/errors';
import { localResetTime } from './run-allowance';
import { workspaceApiPath, workspaceBrowserStorage, workspaceRequestHeaders } from './workspace-scope';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly diagnostics: readonly DataDiagnostic[] = []) { super(message); }
}
export const accessErrorEvent = 'rivetfields:access-error';
export const apiReadTimingEvent = 'rivetfields:api-read-timing';
type ReadOutcome = 'success' | 'http-error' | 'network-error' | 'timeout' | 'cancelled' | 'invalid-response' | 'error';
export interface ApiReadTiming {
  route: string;
  durationMs: number;
  outcome: ReadOutcome;
  phase: 'headers' | 'body' | 'backoff';
  attempts: { durationMs: number; headersMs: number | null; status: number | null; redirected: boolean | null; outcome: ReadOutcome }[];
}
const sourceAccessCodes = new Set(['permission_missing', 'sign_in_required', 'oauth_expired', 'oauth_not_connected',
  'shared_source_denied', 'sharing_denied', 'oauth_grant_invalid', 'credential_unreadable', 'credential_setup_required', 'provider_blocked', 'api_token_required']);

function timingRoute(path: string): string {
  const route = path.split('?')[0];
  if (['/api/session', '/api/workspace', '/api/runs', '/api/tables', '/api/reports'].includes(route)) return route;
  if (/^\/api\/runs\/[^/]+$/.test(route)) return '/api/runs/:id';
  if (/^\/api\/runs\/[^/]+\/session$/.test(route)) return '/api/runs/:id/session';
  return 'other';
}

function readOutcome(error: unknown, signal: AbortSignal): ReadOutcome {
  const cause = signal.aborted ? signal.reason : error;
  if (cause instanceof Error && cause.name === 'TimeoutError') return 'timeout';
  if (signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) return 'cancelled';
  if (error instanceof ApiError) return 'http-error';
  if (error instanceof TypeError) return 'network-error';
  if (error instanceof SyntaxError) return 'invalid-response';
  return 'error';
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Only retry reads: replaying a run, sync or other write can duplicate work.
  const read = ['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase());
  // A navigation signal must not remove the read deadline or reset it on retry.
  const signal = read && options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : options.signal ?? AbortSignal.timeout(15000);
  const request = { ...options, signal };
  const url = workspaceApiPath(path);
  const startedAt = performance.now();
  const timing: ApiReadTiming = { route: timingRoute(path), durationMs: 0, outcome: 'error', phase: 'headers', attempts: [] };
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const headers = new Headers(options.headers);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      for (const [key, value] of Object.entries(workspaceRequestHeaders())) headers.set(key, value);
      const attemptStartedAt = performance.now();
      let response: Response | undefined;
      let headersMs: number | null = null;
      let outcome: ReadOutcome = 'error';
      timing.phase = 'headers';
      try {
        response = await fetch(url, { ...request, headers });
        headersMs = Math.round(performance.now() - attemptStartedAt);
        signal.throwIfAborted();
        if (read && attempt === 0 && [502, 503, 504].includes(response.status)) {
          outcome = 'http-error';
          try { await response.body?.cancel(); }
          catch { /* A failed discard does not change the retryable HTTP status. */ }
          signal.throwIfAborted();
        } else {
          timing.phase = 'body';
          const body = await response.json().catch(error => {
            signal.throwIfAborted();
            // A broken successful response can be retried; an HTTP denial must stay a denial.
            if (response!.ok && !(error instanceof SyntaxError)) throw error;
            return null;
          });
          signal.throwIfAborted();
          if (!response.ok) {
            if ((response.status === 401 || response.status === 403) && !sourceAccessCodes.has(body?.error?.code) && typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent(accessErrorEvent, { detail: { status: response.status } }));
            }
            throw new ApiError(body?.error?.message ?? `Request failed (${response.status}).`, response.status, body?.error?.code, Array.isArray(body?.error?.diagnostics) ? body.error.diagnostics : []);
          }
          if (body === null) throw new SyntaxError('The server returned an unreadable response.');
          timing.outcome = outcome = 'success';
          return body as T;
        }
      } catch (error) {
        outcome = readOutcome(error, signal);
        signal.throwIfAborted();
        if (!read || attempt === 1 || !(error instanceof TypeError) || (response && !response.ok)) throw error;
      } finally {
        if (read) timing.attempts.push({ durationMs: Math.round(performance.now() - attemptStartedAt), headersMs,
          status: response?.status ?? null, redirected: response?.redirected ?? null, outcome });
      }
      timing.phase = 'backoff';
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 250);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
  } catch (error) {
    timing.outcome = readOutcome(error, signal);
    throw error;
  } finally {
    if (read && typeof window !== 'undefined') {
      timing.durationMs = Math.round(performance.now() - startedAt);
      // No URL, identity, header, response content or exception text enters diagnostics.
      try { window.dispatchEvent(new CustomEvent(apiReadTimingEvent, { detail: timing })); }
      catch { /* Optional diagnostics must not change the request result. */ }
    }
  }
}

export function message(error: unknown): string {
  if (error instanceof ApiError && error.code === 'daily_run_limit') {
    const timestamp = error.message.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)?.[0];
    const reset = timestamp ? localResetTime(timestamp) : null;
    return `The workspace has used today's run allowance.${reset ? ` New runs are available after ${reset}.` : ' Refresh the workspace to check the reset time.'} Your draft is still here.`;
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export function readSaved<T>(key: string, fallback: T): T {
  try { const value = workspaceBrowserStorage().getItem(key); return value === null ? fallback : JSON.parse(value) as T; }
  catch { return fallback; }
}

export function saveLocal(key: string, value: unknown): void {
  try { const storage = workspaceBrowserStorage(); value === null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); }
  catch { /* A blocked browser store must not prevent a task from running. */ }
}
