import { useEffect, useState } from 'react';
import type { SchedulePin } from '../../../packages/core/src/workflow-schedules';
import { api } from './api';
import { localTime } from './connections';

/**
 * `connectionId`, `displayName` and `connections` are returned only to people who can manage connections. Several
 * connections can share one content-addressed dataset; `connections` names every one of them, newest first.
 */
export interface SourceFreshness { sourceId: string; observedAt: string; connectionId?: string; displayName?: string; connections?: { connectionId: string; displayName: string }[] }

/** Who supplied a connected source: one name, up to three names, or "N connections"; null when not shown to this person. */
export function connectionNames(fresh: SourceFreshness): string | null {
  const names = fresh.connections?.length ? fresh.connections.map(item => item.displayName) : fresh.displayName ? [fresh.displayName] : [];
  if (!names.length) return null;
  if (names.length === 1) return names[0]!;
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.length} connections`;
}
/** `GET /api/runs/:id/freshness`: a scheduled run's stored pin, never re-resolved, plus its inputs' freshness. */
export interface RunFreshness {
  runId: string; scheduleAttemptId: string | null;
  presync: SchedulePin['presync'] | null; resolvedSources: SchedulePin['resolvedSources'] | null; sources: SourceFreshness[];
}
/** `failedSyncs` failed before the run; `skippedSyncs` were not attempted (the connection was disconnected or missing). */
export interface DataAsOfSummary { observedAt: string; sources: number; failedSyncs: number; skippedSyncs: number; presyncConnections: number }
export type FreshnessState = 'off' | 'loading' | 'loaded' | 'failed';

const oldest = (times: string[]) => times.reduce((min, value) => (value < min ? value : min));

/**
 * The time a run's data is "as of": the pinned versions when the run came from a schedule with
 * connections, otherwise the freshness of its selected inputs. Several sources show the oldest,
 * so the line never overstates how current the data is.
 */
export function runDataAsOf(freshness: RunFreshness | null | undefined): DataAsOfSummary | null {
  if (!freshness) return null;
  const pinned = freshness.resolvedSources ?? [];
  const times = (pinned.length ? pinned : freshness.sources).map(item => item.observedAt).filter(value => Number.isFinite(new Date(value).getTime()));
  if (!times.length) return null;
  const outcomes = freshness.presync?.connections ?? [];
  const refreshed = (status: string) => status === 'completed' || status === 'unchanged';
  const skipped = (status: string) => status === 'disconnected' || status === 'unavailable';
  const unsuccessful = freshness.presync && ['failed', 'partial'].includes(freshness.presync.status);
  const failedSyncs = unsuccessful ? outcomes.filter(item => !refreshed(item.status) && !skipped(item.status)).length : 0;
  const skippedSyncs = unsuccessful ? outcomes.filter(item => skipped(item.status)).length : 0;
  return { observedAt: oldest(times), sources: times.length, failedSyncs, skippedSyncs, presyncConnections: outcomes.length };
}

/**
 * "Data as of <local time>", then "· latest sync failed" when a pre-sync before this run failed, or "· not
 * refreshed" when it was not attempted because the connection was disconnected or missing.
 */
export function dataAsOfSuffix(summary: DataAsOfSummary): string {
  const total = summary.presyncConnections;
  const part = (count: number) => total > 1 && count < total ? ` for ${count} of ${total} connections` : '';
  if (summary.failedSyncs) return ` · latest sync failed${part(summary.failedSyncs)}`;
  if (summary.skippedSyncs) return ` · not refreshed${part(summary.skippedSyncs)}`;
  return summary.sources > 1 ? ` (oldest of ${summary.sources} connected sources)` : '';
}

export function DataAsOfText({ summary, label = true }: { summary: DataAsOfSummary; label?: boolean }) {
  return <>{label && 'Data as of '}<time dateTime={summary.observedAt}>{localTime(summary.observedAt)}</time>{dataAsOfSuffix(summary)}</>;
}

/**
 * Freshness for connection-backed sources, only when the runtime serves connections (`WorkspaceStatus.connectionsEnabled`);
 * otherwise nothing is requested. Supplementary: a failure keeps whatever was shown before and reports `failed`.
 */
export function useSourceFreshness(sourceIds: readonly string[], enabled: boolean, revision = 0): { freshness: ReadonlyMap<string, SourceFreshness>; state: FreshnessState } {
  const key = [...new Set(sourceIds)].sort().join(',');
  const [freshness, setFreshness] = useState<ReadonlyMap<string, SourceFreshness>>(() => new Map());
  const [state, setState] = useState<FreshnessState>(enabled ? 'loading' : 'off');
  useEffect(() => {
    if (!enabled) { setFreshness(new Map()); setState('off'); return; }
    if (!key) { setFreshness(new Map()); setState('loaded'); return; }
    let disposed = false;
    setState('loading');
    void (async () => {
      const ids = key.split(','), found = new Map<string, SourceFreshness>();
      for (let index = 0; index < ids.length && !disposed; index += 50) {
        const page = await api<{ sources: SourceFreshness[] }>(`/api/sources/freshness?ids=${encodeURIComponent(ids.slice(index, index + 50).join(','))}`);
        for (const item of page.sources) found.set(item.sourceId, item);
      }
      if (!disposed) { setFreshness(found); setState('loaded'); }
    })().catch(() => { if (!disposed) setState('failed'); });
    return () => { disposed = true; };
  }, [key, enabled, revision]);
  return { freshness, state };
}

/** A finished run's freshness, only when the runtime serves connections. Nothing is shown until it is read. */
export function useRunFreshness(runId: string | null | undefined, ready: boolean, enabled: boolean): DataAsOfSummary | null {
  const [value, setValue] = useState<DataAsOfSummary | null>(null);
  useEffect(() => {
    setValue(null);
    if (!runId || !ready || !enabled) return;
    let disposed = false;
    void api<RunFreshness>(`/api/runs/${encodeURIComponent(runId)}/freshness`)
      .then(freshness => { if (!disposed && freshness.runId === runId) setValue(runDataAsOf(freshness)); })
      .catch(() => { /* No line is better than a guessed one. */ });
    return () => { disposed = true; };
  }, [runId, ready, enabled]);
  return value;
}
