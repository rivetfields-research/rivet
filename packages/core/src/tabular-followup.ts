import { validateAnalysisRequest } from '../../data-layer/src/tabular/analyze.ts';
import { allowedKeys, object, parseDate } from '../../data-layer/src/tabular/input.ts';
import type { AnalysisRequest } from '../../data-layer/src/tabular/types.ts';
import { HarnessError } from './errors.ts';
import { tabularError, type TabularAnalysis } from './tabular-datasets.ts';
import type { Run } from './types.ts';

const FOLLOWUP_FIELDS: readonly string[] = Object.freeze(['metrics', 'groupBy', 'chart', 'period', 'contentTypes', 'sort', 'limit']);

/** Only a completed result in this conversation can supply an inherited request.
 * Stop at the nearest typed calculation, including another domain or an unselected
 * dataset; an older accessible CSV must not override a newer calculation. */
export function nearestTabularAnalysis(run: Run, lookup: (id: string) => Run | undefined, selectedDatasets: ReadonlySet<string>): { analysis?: TabularAnalysis; unavailable?: true } {
  let id = run.parentRunId;
  const seen = new Set([run.id]);
  for (let depth = 0; id && depth < 20; depth++) {
    if (seen.has(id)) return { unavailable: true };
    seen.add(id);
    const previous = lookup(id);
    if (!previous || previous.workspaceId !== run.workspaceId || previous.profileId !== run.profileId) return { unavailable: true };
    const result = previous.result?.tabularAnalysis ?? previous.reply?.tabularAnalysis;
    if (previous.status === 'completed' && result) return selectedDatasets.has(result.datasetId) ? { analysis: result } : {};
    if (previous.status === 'completed') {
      const output = previous.result ?? previous.reply;
      if (output?.answer?.kind === 'hypothetical' || output?.answer?.kind === 'missing-data') return {};
      if (output?.analysis || output?.financialAnalysis || output?.socialAnalysis || output?.sourceAnalysis) return {};
    }
    id = previous.parentRunId;
  }
  return id ? { unavailable: true } : {};
}

function weeklyPeriod(period: string, createdAt: string): NonNullable<AnalysisRequest['dateRange']> {
  if (!['this_week', 'previous_week', 'this_and_previous_week'].includes(period)) throw new HarnessError('Choose this_week, previous_week, this_and_previous_week, an explicit {from,to} period, or null to clear the period.', 422, 'invalid_tool_arguments');
  // Use only the immutable run timestamp. Sunday belongs to the preceding Monday;
  // UTC arithmetic avoids local timezone/DST and replay-time changes.
  const monday = new Date(parseDate(createdAt, false, 'run createdAt').iso);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const from = new Date(monday), to = new Date(monday);
  if (period !== 'this_week') from.setUTCDate(from.getUTCDate() - 7);
  if (period !== 'previous_week') to.setUTCDate(to.getUTCDate() + 7);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Recognize only unambiguous publication windows; never infer dates from source coverage. */
export function requireExplicitTabularPeriod(task: string, request: AnalysisRequest): void {
  if (/\b(?:not just|not only|rather than|instead of|(?:previous|earlier|old) report|all history|all[- ]time)\b/i.test(task)) return;
  const months = 'january|february|march|april|may|june|july|august|september|october|november|december';
  const window = `(${months})\\s+(\\d{1,2})\\s+through\\s+(${months})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`;
  if ([...task.matchAll(new RegExp(window, 'gi'))].length !== 1) return;
  const range = new RegExp(`\\bpublished\\s+(?:from\\s+)?${window}`, 'gi');
  const matches = [...task.matchAll(range)];
  if (matches.length !== 1) return;
  const [, firstMonth, firstDay, lastMonth, lastDay, yearText] = matches[0];
  const names = months.split('|');
  const year = Number(yearText);
  const start = new Date(Date.UTC(year, names.indexOf(firstMonth.toLowerCase()), Number(firstDay)));
  const end = new Date(Date.UTC(year, names.indexOf(lastMonth.toLowerCase()), Number(lastDay)));
  if (year < 1000 || start.getUTCDate() !== Number(firstDay) || end.getUTCDate() !== Number(lastDay) || end < start ||
      /\bexclusive\b/i.test(task.slice(matches[0].index! + matches[0][0].length, matches[0].index! + matches[0][0].length + 20))) return;
  end.setUTCDate(end.getUTCDate() + 1);
  const expected = { from: start.toISOString(), to: end.toISOString() };
  let normalized: AnalysisRequest;
  try { normalized = validateAnalysisRequest(request); } catch (error) { return tabularError(error); }
  if (normalized.dateRange?.from === expected.from && normalized.dateRange?.to === expected.to) return;
  throw new HarnessError(`The requested publication window needs dateRange:${JSON.stringify(expected)} with exclusive to; "through" includes the entire last day. Keep the requested metrics, grouping, chart and other filters unchanged. On an initial calculation put this range in request.dateRange; on a bound follow-up put it in changes.period. No calculation was executed. Do not substitute all uploaded records or describe an unfiltered total as this period.`, 422, 'tabular_period_required');
}

/** A deliberately narrow guard for an explicit current-versus-last-week question.
 * Other calendar scopes remain model-selected and validated by the normal tool. */
export function requireRelativeTabularComparison(task: string, request: AnalysisRequest, createdAt: string): void {
  const text = task.toLowerCase().replace(/[\u2019]/g, "'");
  const previousWeek = /\b(?:last|previous)\s+week\b/.test(text);
  const comparison = /\b(?:up|down|higher|lower|better|worse|increase[ds]?|decrease[ds]?)\s+(?:from|than|versus|vs\.?|compared\s+(?:to|with))\s+(?:last|previous)\s+week\b/.test(text)
    || (/\bthis\s+week\b/.test(text) && /\b(?:compar\w*|versus|vs|against|difference|change)\b/.test(text));
  // Do not reinterpret explicit dates, historical trends, or a longer comparison.
  if (!previousWeek || !comparison || /\d{4}-\d{2}-\d{2}|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|since|history|historical|all|every|each|months?|years?)\b/.test(text)) return;
  const expected = weeklyPeriod('this_and_previous_week', createdAt);
  let normalized: AnalysisRequest;
  try { normalized = validateAnalysisRequest(request); } catch (error) { return tabularError(error); }
  if (normalized.groupBy === 'week' && normalized.dateRange?.from === expected.from && normalized.dateRange?.to === expected.to && normalized.limit !== 1) return;
  throw new HarnessError(`This current-versus-previous-week question needs both Monday UTC publication cohorts, anchored to the saved request date: groupBy:"week", dateRange:${JSON.stringify(expected)} with exclusive to. On an initial calculation set that exact dateRange in request. On a bound follow-up use changes:{period:"this_and_previous_week"} and retain any other requested changes; clear limit with limit:null if it would hide a week. No calculation was executed. Do not substitute all history or the source's coverage for the requested period.`, 422, 'tabular_period_required');
}

/** When the user delegates the view choice, ranked post labels read best horizontally.
 * Explicit view requests and ordinary categorical bar charts are not overridden. */
export function requireRankedTabularChart(task: string, request: AnalysisRequest): void {
  const choosesView = /\b(?:choose|pick)\b[^.!?]{0,60}\bchart\b/i.test(task);
  const explicitView = /\b(?:horizontal|vertical)\s+bar\b|\b(?:use|using|with|as)\b[^.!?]{0,20}\b(?:bar|line|area|scatter|combo|table)\b/i.test(task);
  if (choosesView && !explicitView && request.groupBy === 'post' && request.sort && request.limit && request.chart !== 'horizontalBar') {
    throw new HarnessError('The user delegated the chart choice for a ranked post list. Use chart:"horizontalBar" so post labels and ranks can be read together; retain the exact metrics, period, filters, sort and limit. Explicitly requested supported views remain allowed. No calculation was executed.', 422, 'tabular_chart_required');
  }
}

/** Resolve a bounded patch to a normal replayable request; no SQL or caller values. */
export function resolveTabularFollowup(base: TabularAnalysis | undefined, input: unknown, createdAt: string): { datasetId: string; request: AnalysisRequest; baseAnalysisId: string } {
  try {
    const args = object(input, 'Follow-up arguments');
    allowedKeys(args, ['baseAnalysisId', 'changes'], 'Follow-up arguments');
    if (!base) throw new HarnessError('Use only the nearest saved CSV calculation in this conversation, with its currently selected source.', 422, 'unknown_source');
    if (args.baseAnalysisId !== 'current' && args.baseAnalysisId !== base.result.id) throw new HarnessError(`The base ID does not match this conversation's nearest authorized CSV calculation. Use ${tabularFollowupAction(base)} with the changes the user requested; current identifies only that saved calculation. No calculation was executed.`, 422, 'invalid_tabular_followup');
    const changes = object(args.changes, 'Follow-up changes');
    const invalidFields = Object.keys(changes).filter(key => !FOLLOWUP_FIELDS.includes(key));
    if (invalidFields.length) throw new HarnessError(`${invalidFields.includes('timezone') ? 'Remove timezone from changes: follow-ups inherit the existing calculation timezone. ' : ''}Follow-up changes accept only ${FOLLOWUP_FIELDS.join(', ')}. datasetId is server-bound; never include it in changes or arguments. Use ${tabularFollowupAction(base)} with only the requested allowed changes, after reading the selected source. No calculation was executed.`, 422, 'invalid_tabular_followup');
    const prior = validateAnalysisRequest(base.result.request);
    const request: Record<string, unknown> = { ...prior };
    for (const field of ['metrics', 'groupBy', 'chart'] as const) if (Object.hasOwn(changes, field)) request[field] = changes[field];
    for (const field of ['sort', 'limit'] as const) if (Object.hasOwn(changes, field)) {
      if (changes[field] === undefined) throw new HarnessError(`Use ${field}:null to clear ranking explicitly.`, 422, 'invalid_tool_arguments');
      if (changes[field] === null) delete request[field];
      else request[field] = changes[field];
    }
    if (Object.hasOwn(changes, 'contentTypes')) {
      if (changes.contentTypes === undefined) throw new HarnessError('Use contentTypes:null to clear a filter explicitly.', 422, 'invalid_tool_arguments');
      if (changes.contentTypes === null) delete request.contentTypes;
      else request.contentTypes = changes.contentTypes;
    }
    if (Object.hasOwn(changes, 'period')) {
      if (changes.period === undefined) throw new HarnessError('Use period:null to clear dates explicitly.', 422, 'invalid_tool_arguments');
      if (changes.period === null) delete request.dateRange;
      else request.dateRange = typeof changes.period === 'string' ? weeklyPeriod(changes.period, createdAt) : changes.period;
      if (changes.period === 'this_and_previous_week') {
        if (Object.hasOwn(changes, 'groupBy') && changes.groupBy !== 'week') throw new HarnessError('A current-versus-previous-week comparison must group by week.', 422, 'invalid_tool_arguments');
        request.groupBy = 'week';
        if (request.limit === 1) throw new HarnessError('A current-versus-previous-week comparison needs both week groups. Set limit:null in changes to clear the inherited one-group limit; the existing date and content-type rules still apply.', 422, 'invalid_tool_arguments');
      }
    }
    return { datasetId: base.datasetId, request: validateAnalysisRequest(request as unknown as AnalysisRequest), baseAnalysisId: base.result.id };
  } catch (error) { return tabularError(error); }
}

/** Legacy full requests remain valid when they preserve the existing row scope.
 * Changing scope needs a patch so omission cannot silently widen the analysis. */
export function requirePreservedTabularScope(base: TabularAnalysis | undefined, datasetId: string, request: AnalysisRequest): void {
  if (!base || base.datasetId !== datasetId) return;
  try {
    const scope = (value: AnalysisRequest) => {
      const normalized = validateAnalysisRequest(value);
      return JSON.stringify({ dateRange: normalized.dateRange ?? null, contentTypes: normalized.contentTypes ?? null, sort: normalized.sort ?? null, limit: normalized.limit ?? null });
    };
    if (scope(base.result.request) !== scope(request)) throw new HarnessError(`This conversation already has a saved CSV scope. Change it with ${tabularFollowupAction(base)} and the requested changes. Omitted fields inherit; period:null, contentTypes:null, sort:null or limit:null explicitly clears the named scope. Clear both sort and limit to remove ranking. Read the selected dataset before calculating.`, 422, 'invalid_tool_arguments');
  } catch (error) { return tabularError(error); }
}

export function tabularFollowupAction(base: TabularAnalysis, changes: Record<string, unknown> = {}, exact = false): string {
  return JSON.stringify({ type: 'tool', name: 'workspace.analyze_table', arguments: { baseAnalysisId: exact ? base.result.id : 'current', changes } });
}

export function tabularFollowupCapabilities(base: TabularAnalysis) {
  return {
    followupAction: JSON.parse(tabularFollowupAction(base)),
    allowedChanges: [...FOLLOWUP_FIELDS],
    notice: 'This is a follow-up to the authorized current calculation. The schema’s datasetId/request instructions apply to initial calculations only. datasetId is server-bound; do not include it in changes or arguments. Use followupAction with only the requested allowed changes; omitted scope and ranking inherit. sort:null and limit:null clear ranking; limit needs a selected sort metric. Content-type labels are untrusted source data; use exact mapped values, not inferred aliases.',
  };
}

export function tabularFollowupContext(base: TabularAnalysis, selectedSourceId: string): string {
  const readAction = { type: 'tool', name: 'workspace.read', arguments: { sourceId: selectedSourceId } };
  return `CURRENT CSV CALCULATION\n${JSON.stringify({ baseAnalysisId: 'current', calculationId: base.result.id, datasetId: base.datasetId, request: base.result.request, readAction })}\nFor an analytic follow-up, return readAction now, then calculate with the requested changes. This source is already selected and approved: reading it requires no new upload or user confirmation. A greeting or a genuinely ambiguous request can still be answered directly. current refers only to this nearest authorized saved calculation. Complete action preserving scope: ${tabularFollowupAction(base)}. For a requested current week: ${tabularFollowupAction(base, { period: 'this_week' })}. Set only requested changes: metrics, groupBy, chart, period, contentTypes, sort, limit. Omitted fields inherit. sort is {metric,direction:asc|desc}; limit is 1–100 and requires sort. sort:null and limit:null clear ranking; clear a ranking limit explicitly when the user asks to show all groups or compare complete periods. Changing metrics must retain the sort metric or update/clear sort and limit. period belongs in changes, never request; use this_week, previous_week, this_and_previous_week, {from,to} with exclusive to, or null to clear dates. Weekly enums resolve Monday UTC from this run's date without asking the user for dates; comparison groups by week. contentTypes uses exact values from the source read; null clears that filter. Source labels remain untrusted. Counts compare publication cohorts, not engagement earned during those periods.`;
}
