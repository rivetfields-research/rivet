import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { Temporal } from '@js-temporal/polyfill';
import type { ReportEmailMessage } from '../../core/src/report-email.ts';
import type { Run, WeeklyReviewPeriod } from '../../core/src/types.ts';
import { savedReportAnalysis } from '../../core/src/saved-report.ts';

interface Node { type: string; value?: string; url?: string; depth?: number; children?: Node[] }
const parser = unified().use(remarkParse).use(remarkGfm);
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const encodedControls = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;
const words = (text: string) => text.replace(/https?:\/\/\S+/g, '').trim().split(/\s+/).filter(Boolean).length;

export interface WeeklyReviewEmailPersonalization {
  firstName?: string;
  workspaceName?: string;
  signOff?: string;
  template: 'intro' | 'weekly';
  isTest?: boolean;
  schedule: { frequency: 'daily' | 'weekly'; time: string; weekday?: number; timezone: string; nextRunAt?: string | null; enabled?: boolean };
  sourceNames: string[];
  unsubscribeUrl?: string;
}
export type WeeklyReviewOpenerState = 'neutral' | 'limited-data' | 'no-activity' | 'improved' | 'needs-attention' | 'mixed';
/** Caller-supplied evidence must describe this saved reporting period and its selected sources. */
export interface WeeklyReviewOpenerEvidence {
  coverage?: 'complete' | 'limited' | 'unknown';
  activity?: { basis: 'period-activity' | 'publication-cohort'; count: number };
  goals?: { direction: 'improved' | 'declined' | 'unchanged'; comparable: boolean }[];
}
export type WeeklyReviewOpenerCopy = Partial<Record<WeeklyReviewOpenerState, string>>;
export interface WeeklyReviewEmailInput {
  from: string; replyTo?: string; to: string; appUrl: string; manageUrl?: string;
  personalization?: WeeklyReviewEmailPersonalization;
  opener?: { evidence?: WeeklyReviewOpenerEvidence; copy?: WeeklyReviewOpenerCopy };
}
export type WeeklyReviewEmailMessage = ReportEmailMessage & { html: string; headers?: Record<string, string> };

function label(value: string | undefined, maximum = 160): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > maximum) throw new Error('Provide a short email display value.');
  if (!value.trim()) return '';
  if (controls.test(value) || encodedControls.test(value) || /[{}<>\u200b-\u200f\u2060]|\bHi\s*,/i.test(value)) {
    throw new Error('Email display values cannot contain controls, markup or placeholders.');
  }
  return value.trim().replace(/\s+/g, ' ');
}

/** Use only explicit names; never derive a recipient name from their email address. */
export function weeklyReviewEmailGreeting(input: Pick<WeeklyReviewEmailPersonalization, 'firstName' | 'workspaceName'> = {}): string {
  const firstName = label(input.firstName), workspaceName = label(input.workspaceName);
  return firstName ? `Hi ${firstName},` : workspaceName ? `Hi ${workspaceName} team,` : 'Hi there,';
}

const openerCopy: Record<WeeklyReviewOpenerState, string> = {
  neutral: 'Your saved weekly review is ready.',
  'limited-data': 'Some source data is limited; the saved review includes the details.',
  'no-activity': 'No activity was recorded in the covered sources for this period.',
  improved: 'The saved comparison shows progress toward a measured goal.',
  'needs-attention': 'The saved comparison shows a decline against a measured goal.',
  mixed: 'The saved goal comparisons show a mix of progress and declines.',
};

/** Metric movement alone is not goal progress, and publication cohorts are not period activity. */
export function weeklyReviewEmailOpener(evidence: WeeklyReviewOpenerEvidence = {}, copy: WeeklyReviewOpenerCopy = {}): { state: WeeklyReviewOpenerState; text: string } {
  let state: WeeklyReviewOpenerState = 'neutral';
  if (evidence.coverage === 'limited') state = 'limited-data';
  else if (evidence.coverage === 'complete') {
    if (evidence.activity?.basis === 'period-activity' && evidence.activity.count === 0) state = 'no-activity';
    else {
      const goals = evidence.goals?.filter(goal => goal.comparable === true) ?? [];
      const improved = goals.some(goal => goal.direction === 'improved'), declined = goals.some(goal => goal.direction === 'declined');
      state = improved && declined ? 'mixed' : declined ? 'needs-attention' : improved ? 'improved' : 'neutral';
    }
  }
  const text = label(copy[state], 240) || openerCopy[state];
  if (words(text) > 35) throw new Error('Keep the email opener under 35 words.');
  assertWeeklyReviewEmailContent({ subject: '', text });
  return { state, text };
}

/** Inline email styles contain no CSS braces, so all rendered fields can be checked together. */
export function assertWeeklyReviewEmailContent(message: { subject: string; text: string; html?: string }): void {
  if ([message.subject, message.text, message.html ?? ''].some(value => /[{}]|\bHi\s*,/i.test(value))) {
    throw new Error('Email content contains an unresolved placeholder or an empty greeting.');
  }
}

function scheduleText(schedule: WeeklyReviewEmailPersonalization['schedule']): { cadence: string; paused: boolean } {
  if (!schedule || !['daily', 'weekly'].includes(schedule.frequency) || typeof schedule.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time) ||
      schedule.enabled !== undefined && typeof schedule.enabled !== 'boolean' ||
      (schedule.frequency === 'weekly' ? !Number.isInteger(schedule.weekday) || schedule.weekday! < 0 || schedule.weekday! > 6 : schedule.weekday !== undefined)) {
    throw new Error('Provide the saved daily or weekly email schedule.');
  }
  const timezone = label(schedule.timezone);
  if (!timezone) throw new Error('Provide the saved schedule timezone.');
  new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const frequency = schedule.frequency === 'daily' ? 'day' : weekdays[schedule.weekday!];
  const cadence = `Every ${frequency} at ${schedule.time} (${timezone})`;
  const paused = schedule.enabled === false || schedule.nextRunAt === null;
  if (schedule.nextRunAt != null) {
    try { Temporal.Instant.from(schedule.nextRunAt); } catch {
      throw new Error('Provide a valid saved next-run timestamp.');
    }
  }
  return { cadence, paused };
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

function header(value: string, displayName = false): string {
  if (typeof value !== 'string' || value.length > 320 || controls.test(value) || encodedControls.test(value)) {
    throw new Error('Provide a safe email address.');
  }
  const address = displayName ? value.match(/^[A-Za-z0-9][A-Za-z0-9 ._'()-]{0,79} <([^<>]+)>$/)?.[1] ?? value : value;
  if (address.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(address)) {
    throw new Error('Provide one valid email address.');
  }
  return value;
}

function safeUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\<>{}]/.test(value) || /%7[bd]/i.test(value) || controls.test(value) || encodedControls.test(value) ||
      /\/(?:\.|%2e){1,2}(?:\/|[?#]|$)/i.test(value) || !/^https?:\/\//i.test(value)) {
    throw new Error('Provide a safe absolute Rivet URL.');
  }
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.username || url.password || /^https?:\/\/[^/]*@/i.test(value) || url.protocol === 'http:' && !loopback) {
    throw new Error('Rivet URLs require HTTPS, or HTTP on loopback, without credentials.');
  }
  return url;
}

function periodBoundary(value: string, timezone: string): Temporal.ZonedDateTime {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? Temporal.PlainDate.from(value).toZonedDateTime(timezone)
    : Temporal.Instant.from(value).toZonedDateTimeISO(timezone);
}

function weekLabel(period: WeeklyReviewPeriod): string | null {
  try {
    const timezone = label(period.timezone);
    if (!timezone) return null;
    const dates = [period.from, period.to].map(value => periodBoundary(value, timezone));
    const [from, to] = dates;
    // A full local week can be 167 or 169 hours across daylight-saving changes.
    if (dates.some(date => !date.equals(date.startOfDay())) ||
        !from.toPlainDate().add({ days: 7 }).equals(to.toPlainDate())) return null;
    const format = (date: Temporal.PlainDate) => date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${format(from.toPlainDate())} to ${format(to.toPlainDate().subtract({ days: 1 }))} (${timezone})`;
  } catch { return null; }
}

const excludedSection = /\b(?:sources?|evidence|appendix|provenance|receipts?|raw data|raw rows|records|tool logs|instructions?|next steps|actions?|recommendations?|methodology|assumptions)\b/i;
const warningSection = /\b(?:limits?|limitations?|coverage|caveats?|missing|warnings?)\b/i;
const instruction = /^(?:please|you (?:must|should|need)|do not|don't|open|click|visit|send|email\s+(?:this|that|the|all|these|it|them|to)|run|execute|delete|forward|copy|paste|install|use|check|review|recommend|consider|try|test|publish|schedule|add|remove|increase|focus|prioritize|compare|ensure|keep|read|follow|ignore|disregard)\b/i;
const internal = /\b(?:instructions?|system prompt|developer message|must|should|recommend|click|execute|send|ignore|disregard|override|tool[_ .-]?(?:call|result|log)|workspace\.\w+|sha[- ]?256|contentHash|sourceHash|bearer|api[_ -]?key)\b|\b[a-f0-9]{32,}\b|https?:\/\/|www\.|source:|[{}|<>`]|\S+@\S+|^(?:id|record|row|source|dataset|batch|observation)\s*[:=]/i;
const limitation = /\b(?:missing|unavailable|unknown|incomplete|partial|stale|capped|not measured|not (?:weekly|period) activity|lifetime|cannot|could not|does not|do not|no (?:comparison|baseline))\b/i;
const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
const evidenceSubject = /^(?:(?:the|a|an|this|that|our|your)\s+)?(?:(?:saved|supporting|full|complete|checked|attached|supplied|synthetic)\s+)*(?:report|review|calculation|evidence|sources?|receipts?|snapshot|export|appendix|csv|table|chart|results?|details?|links?)\b/i;
const navigation = /\b(?:is|are|was|were|has been|have been|can be)\s+(?:(?:also|now)\s+)?(?:attached|linked|available|provided|saved|accessible|found|viewed|read|opened|referenced|in|at|below|above|here)\b/i;
const substantive = /\b(?:recorded|total(?:ed|led)?|accounted for|averaged|generated|measured|increased|decreased|grew|declined|fell|rose|only|limited to|based on|covers?|excludes?)\b/i;

function plain(node: Node): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.type === 'break') return ' ';
  if (node.type === 'link' && node.url?.startsWith('source:')) return '';
  if (['paragraph', 'heading', 'emphasis', 'strong', 'link', 'linkReference'].includes(node.type)) return (node.children ?? []).map(plain).join('');
  return '';
}

function unsafeInline(node: Node): boolean {
  return ['delete', 'inlineCode', 'html', 'image', 'imageReference', 'footnoteReference'].includes(node.type) || !!node.children?.some(unsafeInline);
}

function takeawayText(text: string): string {
  const cleaned = text.replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s+([.,;:!?])/g, '$1');
  return [...sentences.segment(cleaned)].map(item => item.segment.trim()).filter(sentence => {
    if (/^(?:see|refer to|view|consult|for (?:the )?(?:full|saved) (?:report|review))\b/i.test(sentence)) return false;
    // A removed citation can leave a sentence without its object. Omit that sentence in full.
    if (/\b(?:as|at|in|via|from|to|for|with|of|by|is|are|was|were)\s*(?:(?:the|a|an)\s*)?[.!?:;,]?$|^[.!?:;,\s]+$/i.test(sentence)) return false;
    return !evidenceSubject.test(sentence) || !navigation.test(sentence) || limitation.test(sentence) || substantive.test(sentence);
  }).join(' ').trim();
}

/** Whole short passages retain their qualifiers; long passages are omitted, never cut into claims. */
function savedPassages(content: string): { findings: string[]; warning?: string } {
  const findings: string[] = [];
  let warning: string | undefined;
  let hasLimits = false;
  const sections: { depth: number; excluded: boolean; warning: boolean }[] = [];
  const visit = (node: Node) => {
    if (node.type === 'heading') {
      while (sections.length && sections.at(-1)!.depth >= node.depth!) sections.pop();
      const title = plain(node);
      sections.push({ depth: node.depth!, excluded: excludedSection.test(title), warning: warningSection.test(title) });
      if (!sections.some(section => section.excluded) && warningSection.test(title)) hasLimits = true;
    } else if (node.type === 'paragraph' && !sections.some(section => section.excluded) && !unsafeInline(node)) {
      const raw = plain(node).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
      if (limitation.test(raw)) hasLimits = true;
      const text = takeawayText(raw);
      if (text.length < 15 || text.length > 260 || words(text) < 3 || words(text) > 30 || instruction.test(text) || internal.test(text) || /^(?:[^,]*,){2}/.test(text)) return;
      if (sections.some(section => section.warning) || limitation.test(text)) warning ??= text;
      else if (findings.length < 3 && !findings.some(value => value.toLowerCase() === text.toLowerCase())) findings.push(text);
    } else if (['root', 'list', 'listItem'].includes(node.type)) node.children?.forEach(visit);
  };
  // Bound parsing work, dropping the final incomplete passage when the report is longer.
  const bounded = content.length > 64000 ? content.slice(0, content.lastIndexOf('\n\n', 64000) + 2) : content;
  visit(parser.parse(bounded));
  return { findings, warning: warning ?? (hasLimits ? 'The saved review notes data limitations; see the full report for details.' : undefined) };
}

function calculationFinding(run: Run): string | undefined {
  const period = run.weeklyReview!.period;
  const table = run.result!.tabularAnalysis?.result;
  const source = run.result!.sourceAnalysis?.result;
  const range = table?.request.dateRange ?? (source?.operation === 'review' ? source.request.dateRange : undefined);
  if (!range?.from || !range.to) return;
  try {
    if (periodBoundary(range.from, period.timezone).epochNanoseconds !== periodBoundary(period.from, period.timezone).epochNanoseconds ||
        periodBoundary(range.to, period.timezone).epochNanoseconds !== periodBoundary(period.to, period.timezone).epochNanoseconds) return;
  } catch { return; }
  const count = table?.counts.includedRows ?? (source?.operation === 'review' ? source.counts.includedRecords : undefined);
  if (count === undefined || !Number.isSafeInteger(count) || count < 0) return;
  if (count === 0) return "No records matched the saved calculation's weekly filters; this does not establish zero activity.";
  const basis = table ? table.timeBasis.grouping === 'publication_time' ? 'publication-date' : 'source-period'
    : source?.operation === 'review' && source.dateBasis === 'provider_period' ? 'provider-reporting-day' : 'publication-date';
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'record matches' : 'records match'} the saved calculation's ${basis} filters for this week.`;
}

/** Compose only sealed output. The caller must enforce current membership and source access before sending. */
export function composeWeeklyReviewEmail(run: Run, input: WeeklyReviewEmailInput): WeeklyReviewEmailMessage | null {
  if (run.status !== 'completed' || !run.weeklyReview || !run.result?.id || !/^[A-Za-z0-9_.:-]{1,200}$/.test(run.id)) return null;
  const week = weekLabel(run.weeklyReview.period);
  if (!week) return null;
  const from = header(input.from, true), to = header(input.to);
  const replyTo = input.replyTo === undefined ? undefined : header(input.replyTo, true);
  const reportUrl = safeUrl(input.appUrl);
  const prefix = reportUrl.pathname.match(/^\/w\/([A-Za-z0-9_-]{1,160})(?:\/|$)/)?.[0];
  if (reportUrl.pathname.startsWith('/w/') && !prefix) throw new Error('Provide a valid Rivet organization URL.');
  reportUrl.pathname = prefix ? prefix.endsWith('/') ? prefix : `${prefix}/` : '/';
  reportUrl.search = '';
  reportUrl.hash = '';
  // Only analyses and IDs supported by Reports can bypass the conversation viewer.
  const analysis = savedReportAnalysis(run);
  if ((analysis?.kind === 'tabular' || analysis?.kind === 'source') && /^[A-Za-z0-9_-]{1,160}$/.test(run.id)) {
    reportUrl.searchParams.set('view', 'dashboards');
    reportUrl.searchParams.set('report', run.id);
  } else {
    reportUrl.searchParams.set('run', run.id);
  }
  const manageUrl = input.manageUrl === undefined ? undefined : safeUrl(input.manageUrl);
  if (manageUrl && (manageUrl.origin !== reportUrl.origin || prefix && !manageUrl.pathname.startsWith(reportUrl.pathname))) {
    throw new Error('Manage emails must link to the same Rivet workspace.');
  }
  const personalization = input.personalization;
  if (personalization && (!['intro', 'weekly'].includes(personalization.template) ||
      personalization.isTest !== undefined && typeof personalization.isTest !== 'boolean')) throw new Error('Provide a valid email template and test flag.');
  const greeting = weeklyReviewEmailGreeting(personalization);
  const workspaceName = label(personalization?.workspaceName);
  const signOff = label(personalization?.signOff) || 'The Rivet team';
  const schedule = personalization ? scheduleText(personalization.schedule) : undefined;
  if (personalization && (!Array.isArray(personalization.sourceNames) || personalization.sourceNames.length > 5)) throw new Error('Provide up to five selected source names.');
  const sourceNames = personalization?.sourceNames.map(name => {
    const value = label(name);
    if (!value) throw new Error('Provide a nonempty selected source name.');
    return value;
  });
  const sources = sourceNames?.length ? new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(sourceNames) : undefined;
  const unsubscribeUrl = personalization?.unsubscribeUrl === undefined ? undefined : safeUrl(personalization.unsubscribeUrl);
  if (unsubscribeUrl && unsubscribeUrl.origin !== reportUrl.origin) throw new Error('Unsubscribe must link to the same Rivet origin.');

  const { presync, resolvedSources, connectionIds, missingConnectionIds } = run.weeklyReview;
  const warnings: string[] = [];
  if (presync.status === 'skipped') warnings.push('Refresh was skipped; data freshness is unverified.');
  else if (presync.status !== 'completed' || presync.connections.some(item => !['completed', 'unchanged'].includes(item.status))) {
    warnings.push('Some accounts did not refresh; saved data may be stale.');
  }
  const missing = new Set([...missingConnectionIds, ...connectionIds.filter(id => !resolvedSources.some(source => source.connectionId === id))]);
  if (missing.size) warnings.push(`${missing.size} selected ${missing.size === 1 ? 'account is' : 'accounts are'} missing from this review.`);
  const periodEnd = periodBoundary(run.weeklyReview.period.to, run.weeklyReview.period.timezone).epochMilliseconds;
  if (resolvedSources.some(source => Date.parse(source.observedAt) < periodEnd)) warnings.push('Some saved data predates the end of the reporting week.');
  const selected = [...new Set([...connectionIds, ...missingConnectionIds])];
  const allUnavailable = selected.length > 0 && selected.every(id => missing.has(id) ||
    !resolvedSources.some(source => source.connectionId === id && Date.parse(source.observedAt) >= periodEnd));
  const allRefreshFailed = presync.status === 'failed' || selected.length > 0 && selected.every(id =>
    presync.connections.some(item => item.connectionId === id && ['failed', 'interrupted'].includes(item.status)));
  const suppressFindings = allUnavailable || allRefreshFailed;
  const table = run.result.tabularAnalysis?.result, source = run.result.sourceAnalysis?.result;
  if (table && (table.warnings.some(item => /missing|incomplete|undated|empty_cohort|partial|capped/.test(item.code)) || table.counts.excludedUndated || Object.values(table.metricCoverage).some(item => item && (item.missingRows || item.zeroDenominatorRows))) ||
      source && (source.observations.some(item => item.coverage !== 'complete' || item.capped) || source.operation === 'review' && (source.counts.excludedUndated || source.totals.missingRecords)) || run.result.answer?.missing?.length) {
    warnings.push('Some coverage or metrics are incomplete; missing values are unknown, not zero.');
  }
  if (table?.timeBasis.metricObservation === 'api_lifetime_counts' || source?.operation === 'review' && source.metric.basis === 'lifetime') warnings.push('Lifetime counters do not measure activity earned this week.');
  else if (table?.timeBasis.metricObservation === 'source_export_counts') warnings.push('Metric observation times are unknown; these counts do not establish weekly activity.');
  if (source?.operation === 'review' && source.dateBasis === 'provider_period') warnings.push('Provider reporting days do not establish exact UTC activity.');
  const hypothetical = run.result.answer?.kind === 'hypothetical';
  const passages = hypothetical || run.result.answer?.kind === 'missing-data' ? { findings: [] } : savedPassages(run.result.content);
  if (hypothetical) warnings.push('The saved review contains hypothetical estimates, not measured results.');
  if (run.result.answer?.kind === 'missing-data' && !run.result.answer.missing?.length) warnings.push('The saved review reports missing data.');
  if (passages.warning) warnings.push(suppressFindings ? 'The saved review notes data limitations; see the full report for details.' : passages.warning);
  const candidates = suppressFindings ? [] : passages.findings.length ? passages.findings : hypothetical ? [] : [calculationFinding(run)].filter((text): text is string => !!text);
  const intro = personalization?.template === 'intro';
  const scope = `${workspaceName ? `for ${workspaceName}` : 'for you'}${sources ? ` across ${sources}` : ''}`;
  const scheduleCopy = schedule ? [schedule.paused ? `Your schedule is paused (${schedule.cadence.replace(/^Every/, 'every')}). This review is ${scope}.` : `${schedule.cadence}, Rivet prepares a review ${scope}.`,
    ...(sourceNames && !sources ? ['Selected source names are unavailable.'] : [])].join(' ') : undefined;
  // Saved coverage warnings take precedence over an otherwise optimistic caller-supplied opener.
  const reconnect = 'Fresh data is unavailable for this review. Reconnect or refresh the selected sources in Rivet.';
  const opener = intro ? 'This is your first weekly review from Rivet.'
    : suppressFindings ? reconnect : weeklyReviewEmailOpener(warnings.length ? { ...input.opener?.evidence, coverage: 'limited' } : input.opener?.evidence, input.opener?.copy).text;
  const preview = `${greeting} ${personalization?.isTest ? '[Test] ' : ''}${intro ? "here's what to expect from these emails." : opener}`;
  const opening = [greeting, personalization?.isTest ? 'This is a test email.' : undefined,
    intro ? [opener, scheduleCopy].filter(Boolean).join(' ') : opener, ...(intro && suppressFindings ? [reconnect] : []),
    `Reporting week: ${week}`, ...(!intro ? [scheduleCopy] : [])].filter(Boolean) as string[];
  const links = [{ label: 'Open the saved report (Rivet access required)', url: reportUrl },
    ...(manageUrl ? [{ label: 'Manage emails', url: manageUrl }] : []),
    ...(unsubscribeUrl ? [{ label: 'Unsubscribe', url: unsubscribeUrl }] : [])];
  const findings: string[] = [];
  const paragraphs = () => [...opening, ...findings, ...(warnings.length ? [`Coverage: ${warnings.join(' ')}`] : []),
    ...(!findings.length && !suppressFindings ? ['The saved review has no short findings to include here.'] : [])];
  const valediction = intro ? 'Glad to have you with us,' : 'Have a good week,';
  const body = () => [...paragraphs(), ...links.map(link => `${link.label}:\n${link.url.href}`), 'Questions? Just reply.', `${valediction}\n${signOff}`].join('\n\n') + '\n';
  for (const candidate of candidates.slice(0, 3)) {
    findings.push(candidate);
    // Retain one whole finding and every limitation even when essential context exceeds the target.
    if (findings.length > 1 && words(body()) > 180) findings.pop();
  }
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    `<body style="margin:0;background:#ffffff;color:#2a2a2a;font:16px/1.6 Arial,sans-serif;overflow-wrap:anywhere"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(preview)}</div>` +
    `<main style="max-width:600px;margin:0 auto;padding:24px">${paragraphs().map(text => `<p style="margin:0 0 16px">${escapeHtml(text)}</p>`).join('')}` +
    links.map(link => `<p style="margin:0 0 16px"><a style="color:#2a2a2a;text-decoration:underline" href="${escapeHtml(link.url.href)}">${escapeHtml(link.label)}</a></p>`).join('') +
    `<p style="margin:0 0 16px">Questions? Just reply.</p><p style="margin:24px 0 0">${valediction}<br>${escapeHtml(signOff)}</p></main></body></html>`;
  const message: WeeklyReviewEmailMessage = { from, to, ...(replyTo === undefined ? {} : { replyTo }),
    subject: `${personalization?.isTest ? '[Test] ' : ''}${intro ? `Your first weekly review ${workspaceName ? `for ${workspaceName}` : 'from Rivet'}` : `${workspaceName || 'Rivet'}: weekly review, ${week}`}`,
    text: body(), html, ...(unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${unsubscribeUrl.href}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}) };
  assertWeeklyReviewEmailContent(message);
  return message;
}
