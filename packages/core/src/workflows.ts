import { validateSourceIds } from './source-scope.ts';
import { HarnessError } from './errors.ts';
import { CONNECTION_ID } from './connections.ts';
import type { Workflow, WorkflowInput } from './types.ts';

const FIELD_LIMITS = { name: 160, instructions: 2400, output: 800, review: 400 } as const;

export function validateWorkflow(input: unknown, update = false): WorkflowInput & { version?: number; requestId?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HarnessError('Provide a workflow configuration.', 400, 'invalid_workflow');
  const value = input as Record<string, unknown>;
  const allowed = [...Object.keys(FIELD_LIMITS), 'sourceIds', 'weeklyReview', update ? 'version' : 'requestId'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new HarnessError('Workflows accept instructions, an output, review criteria and selected files. Tools stay read-only.', 400, 'invalid_workflow');
  const config: WorkflowInput = { name: '', instructions: '', output: '', review: '' };
  for (const key of Object.keys(FIELD_LIMITS) as (keyof typeof FIELD_LIMITS)[]) {
    const field = value[key];
    if (typeof field !== 'string' || !field.trim() || field.length > FIELD_LIMITS[key]) throw new HarnessError(`Workflow ${key} must contain 1–${FIELD_LIMITS[key].toLocaleString('en-US')} characters.`, 400, 'invalid_workflow');
    config[key] = field.trim();
  }
  if (update && (!Number.isSafeInteger(value.version) || (value.version as number) < 1)) throw new HarnessError('Provide the current workflow version before updating it.', 400, 'invalid_workflow_version');
  if (!update && (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.requestId))) throw new HarnessError('Provide a creation request ID of 16–80 letters, digits, underscores or dashes.', 400, 'invalid_request_id');
  const sourceIds = validateSourceIds(value.sourceIds);
  if (value.weeklyReview !== undefined) {
    const weekly = value.weeklyReview as { connectionIds?: unknown } | null;
    if (!weekly || typeof weekly !== 'object' || Array.isArray(weekly) || Object.keys(weekly).length !== 1 ||
        !Array.isArray(weekly.connectionIds) || weekly.connectionIds.length < 1 || weekly.connectionIds.length > 5 ||
        weekly.connectionIds.some(id => typeof id !== 'string' || !CONNECTION_ID.test(id)) || new Set(weekly.connectionIds).size !== weekly.connectionIds.length) {
      throw new HarnessError('Choose 1-5 different valid connections for a weekly review.', 400, 'invalid_weekly_review');
    }
    if (sourceIds.length) throw new HarnessError('Weekly reviews use latest connection data, without fixed source inputs.', 400, 'invalid_weekly_review');
    config.weeklyReview = { connectionIds: [...weekly.connectionIds].sort() };
  }
  return { ...config, sourceIds, ...(update ? { version: value.version as number } : { requestId: value.requestId as string }) };
}

export function workflowTask(workflow: Workflow): string {
  return `Workflow: ${workflow.name}\n\nInstructions:\n${workflow.instructions}\n\nRequired output:\n${workflow.output}\n\nHuman review criteria (do not claim a person has reviewed the result):\n${workflow.review}`;
}
