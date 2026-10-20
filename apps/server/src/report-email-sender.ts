import { createReportEmailCaptureSender, type ReportEmailMessage, type ReportEmailSender } from '../../../packages/core/src/report-email.ts';

export interface ReportEmailSenderConfig {
  sender: ReportEmailSender;
  from: string;
  replyTo: string;
  appOrigin: string;
}

const ENDPOINT = 'https://api.resend.com/emails';
const MAX_RESPONSE_BYTES = 16_384;
const MAX_HTML_BYTES = 80_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** The dispatcher owns retries; this transport only classifies the single attempt. */
export class ReportEmailSubmissionError extends Error {
  constructor(readonly retryable: boolean, readonly retryAfterMs?: number) {
    super('Report email submission could not be confirmed.');
    this.name = 'ReportEmailSubmissionError';
  }
}
const submissionFailed = () => new ReportEmailSubmissionError(true);
const stopped = () => Object.assign(new ReportEmailSubmissionError(true), { name: 'AbortError', message: 'Report email submission stopped.' });
const invalidMessage = () => Object.assign(new ReportEmailSubmissionError(false), { message: 'Invalid report email message or submission key.' });

function mailbox(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254 || CONTROLS.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return local.length > 0 && local.length <= 64 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) &&
    !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') &&
    domain.includes('.') && domain.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function brandedFrom(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 264 || CONTROLS.test(value)) return false;
  const match = /^Rivet <([^<>]+)>$/.exec(value);
  return !!match && mailbox(match[1]);
}

function appOrigin(value: string | undefined): string {
  const invalid = () => new Error('HARNESS_REPORT_EMAIL_APP_ORIGIN must be a canonical HTTPS origin (HTTP only on loopback).');
  if (!value || value.length > 2048 || CONTROLS.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.origin !== value || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw invalid();
  return value;
}

function unsubscribeHeaders(value: unknown, origin: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw invalidMessage();
  const entries = Object.entries(value);
  if (entries.length > 2) throw invalidMessage();
  const result: Record<string, string> = {};
  for (const [name, header] of entries) {
    const key = name.toLowerCase() === 'list-unsubscribe' ? 'List-Unsubscribe' :
      name.toLowerCase() === 'list-unsubscribe-post' ? 'List-Unsubscribe-Post' : null;
    if (!key || result[key] !== undefined || typeof header !== 'string' || !header || header.length > 2048 || /[^\x20-\x7e]/.test(header)) throw invalidMessage();
    if (key === 'List-Unsubscribe-Post') {
      if (header !== 'List-Unsubscribe=One-Click') throw invalidMessage();
    } else {
      if (!/^<[^<>\s]+>$/.test(header)) throw invalidMessage();
      let url: URL;
      try { url = new URL(header.slice(1, -1)); } catch { throw invalidMessage(); }
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin || url.username || url.password || url.hash) throw invalidMessage();
    }
    result[key] = header;
  }
  if (result['List-Unsubscribe-Post'] && !result['List-Unsubscribe']) throw invalidMessage();
  return result;
}

function checkMessage(message: ReportEmailMessage, from: string, replyTo: string, key: string, origin: string) {
  if (!message || message.from !== from || !mailbox(message.to) ||
      (message.replyTo !== undefined && message.replyTo !== replyTo) ||
      typeof message.subject !== 'string' || !message.subject.trim() || message.subject.length > 998 || CONTROLS.test(message.subject) ||
      typeof message.text !== 'string' || !message.text.trim() ||
      (message.html !== undefined && (typeof message.html !== 'string' || !message.html.trim() || Buffer.byteLength(message.html) > MAX_HTML_BYTES)) ||
      typeof key !== 'string' || key.length < 1 || key.length > 256 || /[^\x21-\x7e]/.test(key)) {
    throw invalidMessage();
  }
  return unsubscribeHeaders(message.headers, origin);
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  try {
    signal.throwIfAborted();
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body) {
      throw submissionFailed();
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw submissionFailed();
    reader = response.body.getReader();
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw submissionFailed();
      if (part.value.byteLength) chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener('abort', cancel);
    if (reader) { cancel(); reader.releaseLock(); }
    else { void response.body?.cancel().catch(() => {}); }
  }
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value || value.length > 60) return undefined;
  const milliseconds = /^\d{1,10}$/.test(value) ? Number(value) * 1000 :
    /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Date.parse(value) - Date.now() : NaN;
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(MAX_RETRY_AFTER_MS, milliseconds)) : undefined;
}

async function receipt(response: Response, signal: AbortSignal): Promise<{ id: string }> {
  if (response.redirected || (response.url && response.url !== ENDPOINT)) {
    void response.body?.cancel().catch(() => {});
    throw submissionFailed();
  }
  if (!response.ok) {
    let concurrent = false;
    if (response.status === 409) {
      try {
        const value = await responseJson(response, signal);
        concurrent = !!value && typeof value === 'object' && !Array.isArray(value) && 'name' in value &&
          typeof value.name === 'string' && value.name.length <= 80 && !/[^a-z_]/.test(value.name) && value.name === 'concurrent_idempotent_requests';
      } catch { /* An unreadable conflict cannot authorize another submission. */ }
    } else { void response.body?.cancel().catch(() => {}); }
    const retryable = concurrent || response.status === 429 || (response.status >= 500 && response.status <= 599);
    throw new ReportEmailSubmissionError(retryable, retryable ? retryAfter(response) : undefined);
  }
  const value = await responseJson(response, signal);
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' ||
      value.id.length < 1 || value.id.length > 200 || /[^A-Za-z0-9_-]/.test(value.id)) throw submissionFailed();
  return { id: value.id };
}

/** Read once at startup. Merely having credentials never enables email. */
export function reportEmailSenderFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): ReportEmailSenderConfig | undefined {
  const mode = env.HARNESS_REPORT_EMAIL_MODE;
  if (mode === undefined || mode === '' || mode === 'off') return undefined;
  if (mode !== 'capture' && mode !== 'resend') throw new Error('HARNESS_REPORT_EMAIL_MODE must be off, capture, or resend.');
  const from = env.HARNESS_REPORT_EMAIL_FROM;
  if (!brandedFrom(from)) throw new Error('HARNESS_REPORT_EMAIL_FROM must be Rivet <one email address>.');
  const replyTo = env.HARNESS_REPORT_EMAIL_REPLY_TO;
  if (!mailbox(replyTo)) throw new Error('HARNESS_REPORT_EMAIL_REPLY_TO must be one email address.');
  const origin = appOrigin(env.HARNESS_REPORT_EMAIL_APP_ORIGIN);

  if (mode === 'capture') {
    const capture = createReportEmailCaptureSender();
    return { from, replyTo, appOrigin: origin, sender: {
      localOnly: true,
      async send(message, options) {
        if (options.signal.aborted) throw stopped();
        const headers = checkMessage(message, from, replyTo, options.idempotencyKey, origin);
        return capture.send({ ...message, from, replyTo, ...(headers === undefined ? {} : { headers }) }, options);
      },
    } };
  }

  const apiKey = env.HARNESS_REPORT_EMAIL_API_KEY;
  if (!apiKey || apiKey.length > 512 || /[^\x21-\x7e]/.test(apiKey)) {
    throw new Error('HARNESS_REPORT_EMAIL_API_KEY must be a nonempty secret token without whitespace.');
  }
  return { from, replyTo, appOrigin: origin, sender: {
    async send(message, options) {
      if (options.signal.aborted) throw stopped();
      const headers = checkMessage(message, from, replyTo, options.idempotencyKey, origin);
      try {
        const response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': options.idempotencyKey },
          body: JSON.stringify({ from, to: [message.to], reply_to: replyTo, subject: message.subject, text: message.text,
            ...(message.html === undefined ? {} : { html: message.html }), ...(headers === undefined ? {} : { headers }) }),
          signal: options.signal, redirect: 'error', credentials: 'omit',
        });
        return await receipt(response, options.signal);
      } catch (error) {
        // Never expose the provider body, fetch error, or caller-supplied abort reason.
        if (options.signal.aborted) throw stopped();
        throw error instanceof ReportEmailSubmissionError ? new ReportEmailSubmissionError(error.retryable, error.retryAfterMs) : submissionFailed();
      }
    },
  } };
}
