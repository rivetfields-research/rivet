import type { Run, WeeklyReviewPeriod } from '../../../packages/core/src/types';
import { answerDocument } from './answer-export';

export function weeklyReviewDates(period: WeeklyReviewPeriod): string {
  const from = new Date(period.from.length === 10 ? `${period.from}T00:00:00Z` : period.from), end = new Date(period.to.length === 10 ? `${period.to}T00:00:00Z` : period.to);
  end.setUTCDate(end.getUTCDate() - 1);
  const format = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `${format(from)} – ${format(end)} · UTC`;
}

export function weeklyReviewEmailDraft(run: Run, url: string): { subject: string; body: string } | null {
  if (!run.weeklyReview || run.status !== 'completed' || !run.result) return null;
  const report = answerDocument(run);
  if (!report) return null;
  const link = new URL(url);
  if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password) throw new Error('Use a Rivet report link.');
  link.searchParams.set('run', run.id);
  const { period, presync } = run.weeklyReview;
  const warning = ['partial', 'failed'].includes(presync.status) ? 'Some accounts could not refresh. This report uses their last saved data.\n\n' : '';
  // The standalone export already uses the saved answer and readable source labels.
  const body = report.content.split('\n<!-- Rivet answer:')[0].trim();
  return { subject: `Your weekly social & data update | ${period.from.slice(0, 10)}`,
    body: `Your weekly social & data update\n${weeklyReviewDates(period)}\n\n${warning}${body}\n\nOpen the saved report: ${link.href}\nThe report link requires access to Rivet.\n` };
}

export function emailDraftLink(recipient: string, draft: { subject: string; body: string }): string | null {
  const to = recipient.trim();
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to) || /[\r\n]/.test(draft.subject)) return null;
  const link = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
  return link.length <= 7000 ? link : null;
}

export function emailDraftFile(recipient: string, draft: { subject: string; body: string }, encode: (value: string) => string): string {
  const to = recipient.trim();
  if (to && !emailDraftLink(to, { ...draft, body: '' })) throw new Error('Enter one valid email address.');
  const chunks: string[] = []; let chunk = '', bytes = 0;
  for (const char of draft.subject) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > 42) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += char; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  const subject = chunks.map(text => `=?UTF-8?B?${encode(text)}?=`).join('\r\n ');
  return ['X-Unsent: 1', ...(to ? [`To: ${to}`] : []), `Subject: ${subject}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encode(draft.body).match(/.{1,76}/g)?.join('\r\n') ?? '', ''].join('\r\n');
}
