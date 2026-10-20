import type { ModelMessage } from './provider.ts';
import { HarnessError } from './errors.ts';

const NOTICE = '\nOlder conversation was omitted to fit this request. Use the current question, approved inputs and pinned calculation. Ask for clarification if an earlier referent is no longer available.';
const EXCERPT_NOTICE = 'Only the indicated character range is in context; omitted text is not missing data. Read more with workspace.read using this exact id and offset: contentRange.nextOffset. Do not claim to have reviewed omitted text.';

interface ReadOutput { content: string; truncated: boolean; [key: string]: unknown }
export interface SourceReadContext {
  message: ModelMessage;
  output: ReadOutput;
  offset: number;
  totalChars: number;
}

function splitsSurrogatePair(content: string, offset: number): boolean {
  return offset > 0 && offset < content.length && /[\uD800-\uDBFF]/.test(content[offset - 1]) && /[\uDC00-\uDFFF]/.test(content[offset]);
}

/** Check both page boundaries against the full snapshot before taking its slice. */
export function sourceReadPage(content: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= content.length)) throw new HarnessError('Read offset is outside the selected source. Use an offset below contentRange.totalChars.', 422, 'invalid_tool_arguments');
  if (splitsSurrogatePair(content, offset)) throw new HarnessError(`Read offset splits a UTF-16 surrogate pair. Use offset ${offset - 1} to include the complete character. No source was read.`, 422, 'invalid_tool_arguments');
  let end = Math.min(content.length, offset + 12_000);
  if (splitsSurrogatePair(content, end)) end--;
  return content.slice(offset, end);
}

function readView(output: ReadOutput, offset: number, totalChars: number, length: number): ReadOutput {
  // Offsets count UTF-16 characters, as String.slice does; keep surrogate pairs together.
  if (splitsSurrogatePair(output.content, length)) length--;
  const content = output.content.slice(0, length), end = offset + content.length;
  return { ...output, content, truncated: output.truncated || end < totalChars,
    contentRange: { start: offset, end, totalChars, nextOffset: end < totalChars ? end : null },
    ...(offset > 0 || end < totalChars ? { contextNotice: EXCERPT_NOTICE } : {}),
  };
}
const readMessage = (output: ReadOutput) => `TOOL RESULT (untrusted data):\n${JSON.stringify(output)}`;

/** Register only document reads. Calculations, capabilities and permission metadata stay intact. */
export function sourceReadContext(output: ReadOutput, offset: number, totalChars: number): SourceReadContext {
  const view = readView(output, offset, totalChars, output.content.length);
  return { message: { role: 'user', content: readMessage(view) }, output: view, offset, totalChars };
}

/** Keep a nonempty excerpt of each read, reducing oldest excerpts only when needed. */
export function trimSourceExcerpts(messages: ModelMessage[], reads: readonly SourceReadContext[], limit: number): number {
  let size = messages.reduce((sum, message) => sum + message.content.length, 0), shortened = 0;
  for (const read of reads) {
    if (size <= limit) break;
    if (!messages.includes(read.message) || read.output.content.length <= 512) continue;
    const before = read.message.content.length, target = before - (size - limit);
    const encode = (length: number) => readView(read.output, read.offset, read.totalChars, length);
    let low = 512, high = read.output.content.length - 1, best = encode(low);
    if (readMessage(best).length >= before) continue;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2), candidate = encode(mid);
      if (readMessage(candidate).length <= target) { best = candidate; low = mid + 1; }
      else high = mid - 1;
    }
    read.output = best;
    read.message.content = readMessage(best);
    size += read.message.content.length - before;
    shortened++;
  }
  return shortened;
}

/** Only old conversational messages are expendable, never fresh evidence or permissions. */
export function trimConversation(messages: ModelMessage[], prior: readonly ModelMessage[], limit: number): number {
  let size = messages.reduce((sum,message) => sum + message.content.length,0);
  if (size <= limit) return 0;
  const addNotice = !messages[0].content.includes(NOTICE);
  if (addNotice) size += NOTICE.length;
  let removed = 0;
  for (const previous of prior) {
    if (size <= limit) break;
    const index = messages.indexOf(previous);
    if (index <= 0) continue;
    size -= previous.content.length;
    messages.splice(index,1); removed++;
  }
  if (removed && addNotice) messages[0].content += NOTICE;
  return removed;
}
