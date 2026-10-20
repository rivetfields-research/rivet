import { HarnessError } from './errors.ts';
import type { AnalysisResult } from '../../data-layer/src/tabular/types.ts';
import { hasAmbiguousRankedTotal, rankedScopeCorrection } from './tabular-ranked-scope.ts';

export const TABULAR_REPORT_GUIDANCE = 'The interface supplies the full calculated table and chart, including when the user requests them. Finish content must contain only ## Key takeaway, ## What it means, and ## Next step with concise prose and source links. Do not write a second numeric table in Markdown. Preserve missing-versus-zero explanations and the exact calculation citation.';

/** Detect a repeated numeric metric table; do not rewrite saved text or reject qualitative action tables. */
export function validateTabularReportTables(content: string, columns: readonly { id: string; label: string; type: string }[]): void {
  const normalize = (value: string) => value.replace(/[*_`]/g, '').replace(/\([^)]*\)/g, '').trim().toLowerCase();
  const metrics = new Set(columns.filter(column => column.type === 'number').flatMap(column => [normalize(column.id), normalize(column.label)]));
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim());
  const lines = content.split(/\r?\n/);
  for (let index = 0; index + 2 < lines.length; index++) {
    if (!lines[index].includes('|')) continue;
    const headers = cells(lines[index]), separator = cells(lines[index + 1]);
    if (headers.length < 2 || headers.length !== separator.length || !separator.every(cell => /^:?-+:?$/.test(cell))) continue;
    const metricIndexes = headers.flatMap((header, column) => metrics.has(normalize(header)) ? [column] : []);
    for (let row = index + 2; row < lines.length && lines[row].includes('|'); row++) {
      const values = cells(lines[row]);
      if (values.length !== headers.length) break;
      if (metricIndexes.some(column => /^(?:[−+-]?\d[\d,.]*(?:\s*%)?|[—–-]|n\/?a|null|missing)$/i.test(values[column].replace(/[*_`]/g, '').trim()))) {
        throw new HarnessError('A numeric metric table repeats the saved table already attached to this report.', 422, 'duplicate_tabular_report_table');
      }
    }
  }
}

/** These facts describe the executed CSV tool, independent of any source-file labels. */
export const TABULAR_NARRATIVE_GUIDANCE = 'If read capabilities establish metricCountingPeriod:lifetime and metricSource, use that provider counting basis for one account snapshot. Dates select content published then, not engagement earned then; never add snapshots. Otherwise describe the supplied CSV with its user-confirmed platform mapping, not a verified native export. Its counting period and capture time are unknown. Do not label the data or counts as lifetime totals. Publication dates do not establish counting periods; import time is not capture time. Completeness is unknown. Preserve synthetic/example labels. The CSV download contains only the grouped table of calculated values; it does not contain formulas or original source rows. Definitions and row references are in the saved calculation evidence; the original file is a separate source. Answer concisely, retain the exact calculation citation, and do not promise additional download contents.';

export type TabularNarrativeIssue = 'unsupported_lifetime_basis' | 'unverified_export_origin' | 'unknown_capture_time' | 'unsupported_csv_contents' | 'unsupported_period_activity' | 'measured_zero_as_missing';

const MESSAGES: Record<TabularNarrativeIssue, string> = {
  unsupported_lifetime_basis: 'The supplied CSV does not establish that its values are lifetime counts. Use qualified language such as "counts may be lifetime totals; their counting period and capture time are unknown".',
  unverified_export_origin: 'A confirmed platform mapping does not verify a native platform export. Refer to the supplied CSV and keep any synthetic/example label.',
  unknown_capture_time: 'Counter capture time is unknown. Publication dates and upload time cannot establish when the counters were observed.',
  unsupported_csv_contents: 'The CSV download contains the grouped values table only. Formula definitions and source-row references belong to the saved calculation evidence, not that CSV.',
  unsupported_period_activity: 'This calculation uses lifetime counters for content selected by publication date. It cannot say how much engagement was earned last week or during another activity period. Describe the recorded totals for content published in the requested window; do not relabel them as period activity.',
  measured_zero_as_missing: 'This saved table contains measured zero counts. Zero is a recorded count, not missing, unknown or unreported data. Only null cells indicate missing values; incomplete coverage is separate. Preserve that distinction without changing the calculation or its evidence.',
};

const LIFETIME = /\b(?:lifetime|all[- ]time)\s+(?:historical\s+)?(?:counts?|counters?|totals?|metrics?|figures?|values?|data)\b|\b(?:counts?|counters?|totals?|metrics?|figures?|values?)\s+(?:are|represent|reflect)\s+lifetime\b/g;
const ORIGIN = /\b(?:native|official|verified)\s+(?:(?:platform|instagram|facebook|linkedin)\s+)?(?:csv\s+)?export\b|\b(?:sourced|taken|obtained|comes?|came|originates?)\s+(?:directly\s+)?from\s+(?:an?\s+|the\s+)?(?:platform|instagram|facebook|linkedin)(?:'s)?\s+(?:csv\s+)?export\b|\b(?:is|was)\s+(?:an?\s+|the\s+)(?:platform|instagram|facebook|linkedin)(?:'s)?\s+(?:csv\s+)?export\b|\b(?:exported|downloaded|retrieved|pulled|fetched)\s+(?:directly\s+)?from\s+(?:the\s+)?(?:platform|instagram|facebook|linkedin)\b/g;
const CAPTURE = /\b(?:captured|collected|observed|fetched|measured)\s+(?:at|on|as of|during|when)\s+(?:\d|today\b|yesterday\b|(?:the\s+)?(?:upload|import)\b|january\b|february\b|march\b|april\b|may\b|june\b|july\b|august\b|september\b|october\b|november\b|december\b)|\b(?:capture|collection|observation)\s+(?:time|date|timestamp)\s*(?:(?:is|was|has been)\s+|[:=]\s*)(?:known\b|verified\b|confirmed\b|established\b|\d)/g;
const CSV_CONTENTS = /\bcsv\b.{0,80}\b(?:includes?|contains?|has|provides?|carries?|with|for)\b.{0,100}\b(?:formulas?|(?:original|raw|source)\s+(?:rows?|records?|data)|row[- ]level\s+(?:evidence|records?|data))\b|\b(?:formulas?|(?:original|raw|source)\s+(?:rows?|records?))\b.{0,45}\b(?:are|is|included|available|saved|exported|provided)\s+(?:in|with)\s+(?:the\s+)?(?:downloaded\s+|exported\s+)?csv\b/;
const NEGATED_CSV_CONTENTS = /\b(?:does not|doesn't|do not|don't|cannot|can't|never)\s+(?:include|contain|provide|carry|export)\b|\b(?:includes?|contains?|has|with)\s+(?:no|neither)\b|\bnot\s+(?:formulas?|(?:original|raw|source)\s+(?:rows?|records?|data))\b|\b(?:are|is)\s+not\s+(?:included\s+|available\s+|saved\s+)?(?:in|with)\s+(?:the\s+)?csv\b/;
const ACTIVITY_VERB = '\\b(?:earned|gained|received|generated)\\b';
const ACTIVITY_METRIC = '\\b(?:likes?|reactions?|comments?|shares?|engagement)\\b';
const ACTIVITY_PERIOD = '\\b(?:(?:last|this|previous)\\s+(?:week|month|day|year)|(?:during|between|from|in)\\s+\\d{4}-\\d{2}-\\d{2})\\b';
const PERIOD_ACTIVITY = new RegExp(`${ACTIVITY_VERB}[^,]{0,60}${ACTIVITY_METRIC}[^,]{0,40}${ACTIVITY_PERIOD}|${ACTIVITY_METRIC}[^,]{0,40}${ACTIVITY_VERB}[^,]{0,40}${ACTIVITY_PERIOD}|${ACTIVITY_PERIOD}[^,]{0,60}${ACTIVITY_VERB}[^,]{0,40}${ACTIVITY_METRIC}`, 'g');
const COUNT_LABEL = '(?:counts?|values?|likes?|comments?|shares?|reactions?|impressions?|clicks?|interactions?)';
const ZERO_AS_MISSING = new RegExp(`\\b(?:zero(?:s|es)?(?:[- ]valued)?(?:\\s+(?:recorded|measured|known))?(?:\\s+${COUNT_LABEL}(?:\\s+and\\s+${COUNT_LABEL})?)?|0\\s+${COUNT_LABEL})\\s*,?\\s+(?:(?:may|might|could|can)\\s+)?(?:means?|represents?|reflects?|indicat(?:e|es|ing)|suggest(?:s|ing)?|be|are|is)\\b[^,]{0,120}\\b(?:missing|unknown|unavailable|unreported|not\\s+(?:recorded|reported|observed))\\b`, 'g');

function qualified(clause: string, index: number, length: number): boolean {
  const before = clause.slice(0, index), after = clause.slice(index + length);
  // Qualifiers must attach to this assertion, not to an unrelated later capture-time caveat.
  if (/\b(?:may|might|could|possibly|potentially|perhaps)\b[^,]{0,70}$/.test(before)) return true;
  if (/\b(?:unverified|unconfirmed|possible|potential|assumed|hypothetical)\s+(?:(?:native|official|platform|csv)\s+){0,3}$/.test(before)) return true;
  // An absence of verification denies certainty about the matched origin phrase.
  // Require attachment on both sides so unrelated missing data cannot qualify it.
  if (/\b(?:lack|absence)\s+of\s+(?:(?:independent|documented)\s+)?$/.test(before) && /^\s+(?:verification|confirmation)\b/.test(after)) return true;
  if (/\b(?:rather than|instead of|neither)\s+(?:(?:an?|the)\s+)?$/.test(before)) return true;
  if (/\b(?:not|never|cannot|can't|isn't|aren't|wasn't|weren't)\b[^,]{0,55}$/.test(before)) return true;
  if (/\b(?:unknown|uncertain|unclear|unverified)\s+(?:whether|if)\b[^,]{0,80}$/.test(before)) return true;
  if (/\b(?:whether|if)\b/.test(before) && /\b(?:unknown|uncertain|unverified|not known|not established)\b/.test(after)) return true;
  if (/^\s+(?:(?:origin|provenance|authenticity|status|basis)\s+)?(?:is|are|remains?)\s+(?:unknown|uncertain|unverified|not verified|not established|not known)\b/.test(after)) return true;
  // Recommendations to obtain/verify evidence do not assert that the current input has it.
  return /\b(?:request|obtain|provide|upload|verify|confirm|check|ask for)\b[^,]{0,55}$/.test(before);
}

/**
 * A narrow guard for known unsupported assertions, not a general factual verifier.
 * It never rewrites content. The runtime records rejected output and asks the model to repair it.
 */
export function tabularNarrativeIssues(content: string, result?: AnalysisResult): readonly TabularNarrativeIssue[] {
  const text = content.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/[’]/g, "'").toLowerCase();
  const clauses = text.split(/[.!?;\n]+|\b(?:but|however|whereas)\b/).map(clause => clause.replace(/\s+/g, ' ').trim());
  const issues = new Set<TabularNarrativeIssue>();
  const nativeLifetime = Boolean(result?.metricSource && result.timeBasis.metricObservation === 'api_lifetime_counts');
  const measuredZero = result?.columns.some(column => column.unit === 'count' && result.rows.some(row => row[column.id as keyof typeof row] === 0));
  for (const clause of clauses) {
    if (measuredZero) for (const match of clause.matchAll(ZERO_AS_MISSING)) {
      if (!/\bdenominator\s+(?:is\s+|of\s+)?$/.test(clause.slice(0, match.index)) &&
          !/\b(?:not|never|cannot|can't|isn't|aren't)\b/.test(match[0].replace(/\bnot\s+(?:recorded|reported|observed)\b/g, 'unreported')) &&
          !/\b(?:not|never|cannot|can't)\b[^,]{0,30}$/.test(clause.slice(0, match.index))) issues.add('measured_zero_as_missing');
    }
    for (const [pattern, issue] of [[LIFETIME, 'unsupported_lifetime_basis'], [ORIGIN, 'unverified_export_origin'], [CAPTURE, 'unknown_capture_time']] as const) {
      for (const match of clause.matchAll(pattern)) {
        if (issue === 'unsupported_lifetime_basis' && nativeLifetime) continue;
        if (issue === 'unverified_export_origin' && nativeLifetime &&
            new RegExp(`^(?:retrieved|pulled|fetched)\\s+(?:directly\\s+)?from\\s+(?:the\\s+)?${result!.metricSource!.provider}$`).test(match[0]) &&
            !/^\s+(?:csv\s+)?export\b/.test(clause.slice(match.index + match[0].length))) continue;
        if (!qualified(clause, match.index, match[0].length)) issues.add(issue);
      }
    }
    if (nativeLifetime) for (const match of clause.matchAll(PERIOD_ACTIVITY)) {
      // A publication cohort with an explicit lifetime count is not an activity-period claim.
      if (/\bpublished\s+$/.test(clause.slice(0, match.index)) && /\blifetime\b/.test(match[0])) continue;
      if (!qualified(clause, match.index, match[0].length)) issues.add('unsupported_period_activity');
    }
    if (CSV_CONTENTS.test(clause) && !NEGATED_CSV_CONTENTS.test(clause)) issues.add('unsupported_csv_contents');
  }
  return [...issues];
}

export function validateTabularNarrative(content: string, result?: AnalysisResult): void {
  const issues = tabularNarrativeIssues(content, result);
  if (issues.length) throw new HarnessError(issues.map(issue => MESSAGES[issue]).join(' '), 422, 'invalid_tabular_narrative');
  if (result && hasAmbiguousRankedTotal(content, result)) throw new HarnessError(rankedScopeCorrection(result), 422, 'invalid_tabular_narrative');
}
