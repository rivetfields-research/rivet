/**
 * Internal tool identifiers are stable, namespaced and machine-facing. They are never shown
 * to a person: chat, traces and the UI render `label` instead. The mapping lives here so a
 * namespaced id cannot drift into user-facing copy by accident.
 */
export const TOOL_IDS = Object.freeze({
  socialWeekly: 'social.weekly_performance',
  socialPeriod: 'social.period_comparison',
  financialSummary: 'financial.period_summary',
  financialMargins: 'financial.margin_changes',
});

export type InternalToolId = typeof TOOL_IDS[keyof typeof TOOL_IDS];

/** Plain sentences, as a person would read them in a trace or chat. */
export const TOOL_LABELS: Readonly<Record<InternalToolId, string>> = Object.freeze({
  [TOOL_IDS.socialWeekly]: 'Summarized weekly post performance',
  [TOOL_IDS.socialPeriod]: 'Compared weekly post performance',
  [TOOL_IDS.financialSummary]: 'Summarized recognized revenue and cost',
  [TOOL_IDS.financialMargins]: 'Calculated margin changes',
});

export function labelFor(toolId: InternalToolId): string {
  return TOOL_LABELS[toolId];
}

/** A guard for tests and review: a user-facing label never leaks an internal identifier. */
export function isUserFacingLabel(value: string): boolean {
  return Boolean(value) && !value.includes('.') && !value.includes('_') && !(Object.values(TOOL_IDS) as readonly string[]).includes(value);
}
