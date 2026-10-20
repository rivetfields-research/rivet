import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceStatus } from '../../../packages/core/src/types';

type Budget = WorkspaceStatus['runBudget'];

export function watchRunAllowance(refresh: () => Promise<void>, browser: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setInterval' | 'clearInterval'>, page: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>) {
  let busy = false, disposed = false;
  const check = async () => {
    if (disposed || busy || page.visibilityState === 'hidden') return;
    busy = true;
    try { await refresh(); } catch { /* Manual refresh remains available after connection failures. */ }
    finally { busy = false; }
  };
  const timer = browser.setInterval(() => void check(), 10_000);
  browser.addEventListener('focus', check); page.addEventListener('visibilitychange', check);
  return () => { disposed = true; browser.clearInterval(timer); browser.removeEventListener('focus', check); page.removeEventListener('visibilitychange', check); };
}

export function remainingRuns(budget: Budget): number | null {
  if (!budget || !Number.isInteger(budget.limit) || !Number.isInteger(budget.used) || budget.limit < 0 || budget.used < 0) return null;
  return Math.max(0, budget.limit - budget.used);
}

export function localResetTime(value: string): string | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : null;
}

export function RunAllowance({ budget, onRefresh, onlyWhenBlocked = false }: { budget: Budget; onRefresh: () => Promise<void>; onlyWhenBlocked?: boolean }) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const remaining = remainingRuns(budget);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setRefreshing(true); setError('');
    try { await onRefresh(); } catch { setError('Could not refresh the allowance. Try again.'); }
    finally { inFlight.current = false; setRefreshing(false); }
  }, [onRefresh]);

  useEffect(() => remaining === 0 ? watchRunAllowance(refresh, window, document) : undefined, [remaining, refresh]);
  useEffect(() => {
    if (!budget || !Number.isFinite(Date.parse(budget.resetsAt))) return;
    // Re-read the server at reset; never grant an allowance using the client clock.
    const timer = window.setTimeout(() => { void refresh(); }, Math.min(2_147_483_647, Math.max(0, Date.parse(budget.resetsAt) - Date.now()) + 1000));
    return () => window.clearTimeout(timer);
  }, [budget?.resetsAt, refresh]);

  if (!budget || remaining === null || (onlyWhenBlocked && remaining > 0 && !error)) return null;
  const reset = localResetTime(budget.resetsAt);
  return <div className="composer-allowance" aria-label="Workspace run allowance">
    {!onlyWhenBlocked && <p role="status"><span>{remaining} of {budget.limit} runs remaining today</span><span>{reset ? <>Resets <time dateTime={budget.resetsAt}>{reset}</time></> : 'Reset time unavailable'}</span></p>}
    {remaining === 0 && <div><span>Daily workspace allowance reached. Your draft is still here.</span><button type="button" className="text-button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh allowance'}</button></div>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
