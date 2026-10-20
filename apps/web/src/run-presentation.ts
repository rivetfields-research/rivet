import type { RunSummary } from '../../../packages/core/src/types';

const followupPrefixes = [
  'Respond to this follow-up. Use approved workspace sources for factual document work.\n\n',
  'Use the approved workspace sources to answer this follow-up.\n\n',
];

export function taskTitle(run: Pick<RunSummary, 'task' | 'workflowId'>): string {
  if (run.workflowId) return run.task.split('\n')[0].replace(/^Workflow: /, '');
  // Only unwrap prompts produced by the follow-up composer. Keep the full task
  // untouched for audit, and leave ordinary or incomplete prompts unchanged.
  const prefix = followupPrefixes.find(candidate => run.task.startsWith(candidate));
  if (!prefix) return run.task;
  const previousTask = run.task.indexOf('\n\nPrevious task:\n', prefix.length);
  if (previousTask < 0) return run.task;
  return run.task.slice(prefix.length, previousTask).split('\n').map(line => line.trim()).find(Boolean) ?? run.task;
}
export function runTitle(run: Pick<RunSummary, 'task' | 'workflowId' | 'artifactTitle'>): string {
  return run.artifactTitle ?? taskTitle(run);
}
