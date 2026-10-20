import { createHash } from 'node:crypto';
import { HarnessError } from './errors.ts';
import { validateSourceAnalysis, type SourceAnalysisRequest, type analyzeSources } from '../../data-layer/src/source-semantics.ts';
import type { SourceDocument } from './types.ts';

export interface SourceAnalysis {
  kind: 'source'; sourceId: string; result: ReturnType<typeof analyzeSources>;
}

/** Narrow English claim check: email counters alone cannot establish website outcomes. */
export function validateSourceNarrative(content: string, analysis: SourceAnalysis): void {
  if (!analysis.result.observations.every(observation => observation.provider === 'mailchimp')) return;
  for (const sentence of content.toLowerCase().split(/[.!?\n]+/)) {
    const claim = /\b(?:drove|drives?|driving|generated|caused|brought|led to|resulted in)\s+(?:(?:the|most|more|our|a)\s+)*(?:website|site|web)\s+(?:traffic|visits?|sessions?|conversions?)\b/.exec(sentence);
    if (!claim) continue;
    const prefix = sentence.slice(0, claim.index);
    if (/\b(?:not|never|cannot|can't|doesn't|didn't|whether|if|hypothesis|hypothetical)\b[^,;]{0,80}$/.test(prefix)) continue;
    throw new HarnessError('Email clicks are not measured website visits or campaign attribution. Describe recorded email counts; do not say an email drove website traffic without verified outcome evidence.', 422, 'invalid_source_narrative');
  }
}
export function sourceAnalysisObservationIds(request: SourceAnalysisRequest): string[] {
  return request.operation === 'review' ? [request.observationId] : request.operation === 'compare' ? [request.before, request.after]
    : [request.left.observationId, request.right.observationId];
}

const cell = (value: unknown) => String(value ?? 'Unknown').replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').slice(0, 280);
const recordLink = (value: unknown) => {
  if (typeof value !== 'string' || value.length > 2000) return 'Unavailable';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return 'Unavailable';
    return `[Open](${url.href.replace(/[()|]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)})`;
  } catch { return 'Unavailable'; }
};
export function sourceAnalysisText(result: SourceAnalysis['result']): string {
  const observation = result.observations[0]!;
  const lines = ['## Checked source review', '', `Source: ${cell(observation.provider)} · Collected ${observation.observedAt}`, ''];
  if (result.operation === 'review') {
    lines.push(`Metric: ${cell(result.metric.label)} (${result.metric.unit}). ${result.counts.includedRecords} of ${result.counts.inputRecords} collected records included.`,
      result.request.dateRange ? `Dates: ${result.request.dateRange.from} to ${result.request.dateRange.to} (end exclusive).` : 'Dates: all records in this saved observation.',
      `Dates refer to ${result.dateBasis === 'provider_period' ? 'reporting days' : 'publication dates'}; timezone: ${result.timezone ?? 'Unknown'}.`,
      `Total: ${result.totals.value ?? 'Unknown or not additive'}.`, '',
      '| Record / group | Value | Missing records | Original |', '| --- | ---: | ---: | --- |',
      ...result.rows.slice(0, 20).map(row => `| ${cell('text' in row && row.text ? row.text : row.group)} | ${row.value ?? 'Unknown'} | ${row.missingRecords} | ${'url' in row ? recordLink(row.url) : '-'} |`));
    lines.push('', `Showing ${Math.min(result.rows.length, 20)} of ${result.counts.totalGroups} groups, ranked by known values. Totals and evidence retain the full filtered cohort.`);
  } else if (result.operation === 'compare') {
    lines.push(`Metric: ${cell(result.metric.label)}. Matched net change: ${result.matchedNetChange ?? 'Unknown'} (${result.matchedRecords} matched records).`, '',
      '| Record | Before | After | Net change | Status |', '| --- | ---: | ---: | ---: | --- |',
      ...result.rows.slice(0, 20).map(row => `| ${cell(row.recordId)} | ${row.before ?? 'Unknown'} | ${row.after ?? 'Unknown'} | ${row.delta ?? 'Unknown'} | ${row.status} |`));
    lines.push('', `Showing ${Math.min(result.rows.length, 20)} of ${result.rows.length} records.`);
  } else {
    lines.push(`Paired metrics: ${result.metrics.map(metric => cell(metric.label)).join(' / ')}. ${result.eligiblePairs} complete pairs; ${result.missingPairs} missing pairs.`,
      `Unmatched records: ${result.unmatchedLeft} on the left; ${result.unmatchedRight} on the right. Unmatched records are excluded, not zero-filled.`,
      ...('correlation' in result ? [`Pearson correlation: ${result.correlation ?? 'Not calculable'}; ${result.status}.`] : []), '',
      '| Left record | Right record | Left value | Right value |', '| --- | --- | ---: | ---: |',
      ...result.rows.slice(0, 20).map(row => `| ${cell(row.leftRecordId)} | ${cell(row.rightRecordId)} | ${row.left ?? 'Unknown'} | ${row.right ?? 'Unknown'} |`));
    lines.push('', `Showing ${Math.min(result.rows.length, 20)} of ${result.rows.length} pairs.`);
  }
  lines.push('', '### Evidence and limits', '', ...result.warnings.map(warning => `- ${warning}`), '',
    ...result.observations.map(item => `- Observation ${item.id}; original batch ${item.rawBatchId}; SHA-256 ${item.sourceHash}.`));
  return lines.join('\n');
}

export function prepareSourceAnalysis(result: SourceAnalysis['result']): { analysis: SourceAnalysis; source: SourceDocument; context: string } {
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw new HarnessError('Source analysis exceeds the saved-result limit. Select a smaller observation.', 413, 'source_analysis_limit');
  const content = sourceAnalysisText(result);
  const sourceId = `source_${createHash('sha256').update(JSON.stringify(result)).digest('hex')}`;
  return { analysis: { kind: 'source', sourceId, result },
    source: { id: sourceId, title: 'Checked source review', path: `calculations/${result.id}/receipt.md`, bytes: Buffer.byteLength(content), content },
    context: content.slice(0, 12_000) };
}

export function sourceAnalysisArguments(args: Record<string, unknown>, base?: SourceAnalysis): SourceAnalysisRequest {
  if (Object.hasOwn(args, 'baseAnalysisId') || Object.hasOwn(args, 'changes')) {
    if (!base || args.baseAnalysisId !== base.result.id || Object.keys(args).some(key => !['baseAnalysisId', 'changes'].includes(key)) ||
        !args.changes || typeof args.changes !== 'object' || Array.isArray(args.changes)) throw new HarnessError('Use the current source baseAnalysisId and changes only.', 422, 'invalid_tool_arguments');
    const changes = args.changes as Record<string, unknown>;
    const keys = base.result.operation === 'review' ? ['metric', 'groupBy', 'dateRange', 'limit'] : base.result.operation === 'compare' ? ['metric'] : [];
    if (Object.keys(changes).some(key => !keys.includes(key))) throw new HarnessError('A follow-up cannot change its pinned observations or join keys. Select new sources in a new conversation.', 422, 'invalid_tool_arguments');
    const request = { ...base.result.request, ...changes };
    if (changes.dateRange === null) delete (request as { dateRange?: unknown }).dateRange;
    return validateSourceAnalysis(request);
  }
  if (Object.keys(args).length !== 1 || !Object.hasOwn(args, 'request')) throw new HarnessError('Source analysis takes only request, or current baseAnalysisId and changes.', 422, 'invalid_tool_arguments');
  const request = validateSourceAnalysis(args.request);
  if (base && sourceAnalysisObservationIds(base.result.request).every(id => sourceAnalysisObservationIds(request).includes(id))) {
    throw new HarnessError(`Use baseAnalysisId ${base.result.id} and changes to preserve the current filters.`, 422, 'invalid_tool_arguments');
  }
  return request;
}
