import type { Run, RunSummary } from '../../../packages/core/src/types';

export const MAX_SIDEBAR_PINS = 12;
export const sidebarPinKey = (profile: string) => `rivetfields.sidebar-pins.${profile}.v1`;

export function parseSidebarPins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)))].slice(0, MAX_SIDEBAR_PINS);
}

export const conversationId = (run: Pick<RunSummary, 'id' | 'sessionId'>) => run.sessionId ?? run.id;

export function sidebarSummary(run: Run): RunSummary {
  const { events, result, reply, savedCalculation, savedSourceAnalysis, ...summary } = run;
  return { ...summary, artifactTitle: result?.title ?? null, hasReply: Boolean(reply) };
}

export function sidebarConversations(runs: RunSummary[]): RunSummary[] {
  const conversations = new Map<string, RunSummary>();
  for (const run of runs) {
    const id = conversationId(run), previous = conversations.get(id);
    if (!previous || run.parentRunId === previous.id || run.createdAt > previous.createdAt ||
      (run.id === previous.id && run.updatedAt >= previous.updatedAt)) conversations.set(id, run);
  }
  return [...conversations.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
