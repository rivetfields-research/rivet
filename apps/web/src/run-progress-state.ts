import type { RunEvent, RunStatus } from '../../../packages/core/src/types';
import { streamingNarrative } from './model-stream-presentation';

export const progressLabels = ['Prepare request', 'Analyze', 'Prepare answer'] as const;
export type ProgressState = 'pending' | 'active' | 'complete' | 'failed' | 'stopped' | 'interrupted';
export type ProgressStep = { label: typeof progressLabels[number]; state: ProgressState; description: string };

const descriptions: Record<ProgressState, string> = {
  pending: 'Not started', active: 'Working', complete: 'Completed',
  failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted',
};
const terminalTypes = new Set<RunEvent['type']>(['completed', 'failed', 'cancelled', 'interrupted']);

/** A recorded terminal event takes effect before the next run-status refresh. */
export function runProgressStatus(events: RunEvent[], status: RunStatus, error?: string | null): RunStatus {
  const terminal = events.reduce<RunEvent | undefined>((latest, event) => terminalTypes.has(event.type)
    && (!latest || event.sequence >= latest.sequence) ? event : latest, undefined);
  const current = status === 'queued' || status === 'running' || status === 'completed'
    ? (terminal?.type as RunStatus | undefined) ?? status : status;
  return error && ['queued', 'running', 'completed'].includes(current) ? 'failed' : current;
}

/** Recorded execution progress only, never a claim about answer accuracy. */
export function runProgressSteps(events: RunEvent[], status: RunStatus, error?: string | null, example = false): ProgressStep[] {
  if (example) return progressLabels.map(label => ({ label, state: 'pending', description: 'Example' }));
  const ids = new Set<string>();
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence).filter(event => {
    if (ids.has(event.id)) return false;
    ids.add(event.id);
    return true;
  });
  const terminal = ordered.filter(event => terminalTypes.has(event.type)).at(-1);
  const current = runProgressStatus(ordered, status, error);
  const records = terminal ? ordered.filter(event => event.sequence < terminal.sequence) : ordered;
  const analyzing = records.some(event => ['model', 'model_delta', 'tool_call', 'tool_result'].includes(event.type));
  const answering = Boolean(streamingNarrative(records, 'running'));
  const phase = answering ? 2 : analyzing ? 1 : 0;
  return progressLabels.map((label, index) => {
    const state: ProgressState = current === 'completed' ? 'complete'
      : current === 'queued' ? 'pending'
      : index < phase ? 'complete' : index > phase ? 'pending'
      : current === 'running' ? 'active'
      : current === 'cancelled' ? 'stopped' : current;
    return { label, state, description: current === 'queued' && index === 0 ? 'Queued' : descriptions[state] };
  });
}
