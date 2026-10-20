import type { ProviderStatus, Run, RunEvent, RunSummary, RunUpdate } from '../../../packages/core/src/types.ts';

export function customerError(code: string | undefined, message: string | undefined): string | undefined {
  if (!code?.startsWith('invalid_model_') && ![
    'provider_error', 'provider_unavailable', 'provider_content_filter', 'provider_refusal',
    'provider_output_truncated', 'provider_response_limit', 'provider_rate_limited',
    'provider_stream_configuration', 'provider_stream_incomplete', 'provider_action_format', 'provider_empty_response',
  ].includes(code ?? '')) return message;
  if (code === 'provider_content_filter' || code === 'provider_refusal') return 'Rivet could not complete this request. Your saved data is unchanged.';
  if (code === 'provider_output_truncated' || code === 'provider_response_limit') return 'The response exceeded its limit. Try a shorter request. Your saved data is unchanged.';
  if (code === 'provider_rate_limited') return 'Rivet is busy. Please try again shortly. Your saved data is unchanged.';
  return 'Rivet could not finish this request. Try again or contact your workspace owner. Your saved data is unchanged.';
}

/** Project operational metadata at the HTTP boundary; saved records stay intact. */
export function customerProvider(provider: ProviderStatus): ProviderStatus {
  return {
    configured: provider.configured, available: provider.available,
    model: null, kind: 'unknown', label: 'Rivet',
    message: provider.available ? 'Rivet is available.' : 'Rivet is unavailable. Try again or contact your workspace owner.',
  };
}

const RUN_FIELDS = [
  'id', 'requestId', 'requestWithdrawn', 'task', 'responseMode', 'parentRunId', 'sessionId',
  'workspaceId', 'actor', 'profileId', 'status', 'createdAt', 'updatedAt', 'workflowId', 'workflowVersion',
  'projectId', 'projectSourceIds', 'projectBrief', 'limits', 'usage', 'error', 'errorCode',
  'savedCalculation', 'savedSourceAnalysis', 'explanationRetryOf', 'result', 'reply',
  'sourceIds', 'requestedSourceIds', 'selectedSourceIds', 'sources', 'sourceRevision',
  'artifactTitle', 'hasReply', 'hasSavedCalculation',
] as const satisfies readonly (keyof (Run & RunSummary))[];

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function tokenUsage(value: unknown): unknown {
  if (!object(value)) return typeof value === 'number' || value === null ? value : undefined;
  return Object.fromEntries(['inputTokens', 'outputTokens'].filter(key => typeof value[key] === 'number' || value[key] === null).map(key => [key, value[key]]));
}

/** Model requests are internal diagnostics; response text and recorded evidence are public activity. */
export function customerRunEvent(event: RunEvent): RunEvent {
  const projected: RunEvent = { id: event.id, sequence: event.sequence, type: event.type, createdAt: event.createdAt, summary: event.summary,
    ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
    ...(event.streamPhase !== undefined ? { streamPhase: event.streamPhase } : {}) };
  if (event.type !== 'model' && event.type !== 'model_delta') {
    if (event.type === 'failed') {
      const code = object(event.output) && typeof event.output.errorCode === 'string' ? event.output.errorCode : undefined;
      projected.summary = customerError(code, event.summary) ?? event.summary;
    }
    return { ...projected,
      ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
      ...(event.input !== undefined ? { input: event.input } : {}),
      ...(event.output !== undefined ? { output: event.output } : {}) };
  }
  projected.summary = event.type === 'model_delta' ? 'Received response text.' : event.streamPhase === 'started'
    ? 'Rivet requested the next action.' : event.streamPhase === 'completed' ? 'Rivet received a response.' : 'Recorded Rivet activity.';
  if (event.type === 'model_delta' && typeof event.delta === 'string') projected.delta = event.delta;
  if (object(event.output)) {
    const output: Record<string, unknown> = {};
    for (const key of ['response', 'content'] as const) if (typeof event.output[key] === 'string') output[key] = event.output[key];
    if (typeof event.output.truncated === 'boolean') output.truncated = event.output.truncated;
    if (typeof event.output.validationCode === 'string') output.validationCode = event.output.validationCode;
    if (Array.isArray(event.output.sourceIds) && event.output.sourceIds.every(id => typeof id === 'string')) output.sourceIds = event.output.sourceIds;
    if (typeof event.output.validationError === 'string') output.validationError = customerError(typeof event.output.validationCode === 'string' ? event.output.validationCode : undefined, event.output.validationError);
    for (const key of ['reportedUsage', 'reportedUsageThroughPreviousResponse'] as const) {
      const usage = tokenUsage(event.output[key]);
      if (usage !== undefined) output[key] = usage;
    }
    if (Object.keys(output).length) projected.output = output;
  }
  return projected;
}

/** Explicit envelopes protect older saved rows; nested user answers and sources stay intact. */
export function customerRun<T extends { model: string | null; events?: RunEvent[]; error?: string | null; errorCode?: string }>(run: T): T {
  const projected = Object.fromEntries(RUN_FIELDS.filter(key => Object.hasOwn(run, key)).map(key => [key, (run as unknown as Record<string, unknown>)[key]]));
  if (run.error) projected.error = customerError(run.errorCode, run.error);
  return { ...projected, model: null, ...(run.events ? { events: run.events.map(customerRunEvent) } : {}) } as T;
}

export function customerRunUpdate(update: RunUpdate): RunUpdate {
  return { run: customerRun(update.run), events: update.events.map(customerRunEvent), cursor: update.cursor, hasMore: update.hasMore };
}
