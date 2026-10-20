import type { RunEvent, RunStatus } from '../../../packages/core/src/types';

export type ModelTurn = {
  kind: 'model-turn';
  requestId: string;
  sequence: number;
  createdAt: string;
  input?: unknown;
  output: string;
  state: 'waiting' | 'receiving' | 'complete' | 'partial';
  truncated: boolean;
  usage?: unknown;
  tools: RunEvent[];
};
export type ActivityEntry = { kind: 'event'; event: RunEvent } | ModelTurn;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const streamRecord = (event: RunEvent) => event.type === 'model_delta' || (event.type === 'model' && (event.streamPhase === 'started' || event.streamPhase === 'completed'));

/** Presentation only: never parses emitted text into actions or a document. */
export function groupModelActivity(events: RunEvent[], status?: RunStatus): ActivityEntry[] {
  const ids = new Set<string>();
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence).filter(event => {
    if (ids.has(event.id)) return false;
    ids.add(event.id);
    return true;
  });
  const requests = new Set(ordered.filter(event => event.requestId && streamRecord(event)).map(event => event.requestId!));
  const groups = new Map<string, { turn: ModelTurn; completed?: RunEvent; deltas: string[] }>();
  const entries: ActivityEntry[] = [];
  for (const event of ordered) {
    const grouped = event.requestId && requests.has(event.requestId) && (streamRecord(event) || event.type === 'tool_call' || event.type === 'tool_result');
    if (!grouped) { entries.push({ kind: 'event', event }); continue; }
    const requestId = event.requestId!;
    let group = groups.get(requestId);
    if (!group) {
      const turn: ModelTurn = { kind: 'model-turn', requestId, sequence: event.sequence, createdAt: event.createdAt, output: '', state: 'waiting', truncated: false, tools: [] };
      group = { turn, deltas: [] };
      groups.set(requestId, group);
      entries.push(turn);
    }
    if (event.type === 'tool_call' || event.type === 'tool_result') group.turn.tools.push(event);
    else if (event.type === 'model_delta' && typeof event.delta === 'string') group.deltas.push(event.delta);
    else if (event.type === 'model' && event.streamPhase === 'started') group.turn.input = event.input;
    else if (event.type === 'model' && event.streamPhase === 'completed') group.completed = event;
  }
  const terminal = status !== undefined && status !== 'queued' && status !== 'running';
  for (const { turn, completed, deltas } of groups.values()) {
    const result = completed && object(completed.output) ? completed.output : undefined;
    // A completed response is the full record, not an additional fragment.
    turn.output = typeof result?.response === 'string' ? result.response : deltas.join('');
    turn.truncated = result?.truncated === true;
    turn.usage = result?.reportedUsage;
    turn.state = completed && typeof result?.response === 'string' && !turn.truncated ? 'complete' : terminal || turn.truncated ? 'partial' : turn.output ? 'receiving' : 'waiting';
  }
  return entries;
}

export function isNearScrollEnd(element: { scrollHeight: number; scrollTop: number; clientHeight: number }, threshold = 36) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export type StreamingNarrative = { kind: 'reply' | 'report'; requestId: string; content: string };

type StringPrefix = { value: string; end: number; complete: boolean };
/** Decode only a JSON string. An unfinished escape waits for the next chunk. */
function stringPrefix(input: string, start: number): StringPrefix | null {
  if (input[start] !== '"') return null;
  let end = start + 1;
  while (end < input.length) {
    const character = input[end];
    if (character === '"') {
      try { return { value: JSON.parse(input.slice(start, end + 1)), end: end + 1, complete: true }; }
      catch { return null; }
    }
    if (character < ' ') return null;
    if (character === '\\') {
      const escaped = input[end + 1];
      if (escaped === undefined) break;
      if (escaped === 'u') {
        const hex = input.slice(end + 2, end + 6);
        if (!/^[\da-f]*$/i.test(hex)) return null;
        if (hex.length < 4) break;
        end += 6;
      } else {
        if (!'"\\/bfnrt'.includes(escaped)) return null;
        end += 2;
      }
    } else end++;
  }
  try { return { value: JSON.parse(`${input.slice(start, end)}"`), end: input.length, complete: false }; }
  catch { return null; }
}

/** A shallow reader for the public prose envelope, never an action parser. Only
 * top-level strings and a citations string array are admitted: nested content,
 * tool arguments and reasoning fields cannot become a visible content field. */
function narrativePrefix(input: string): { kind: StreamingNarrative['kind']; content: string; complete: boolean } | null {
  let cursor = 0;
  let type: string | undefined;
  let content: string | undefined;
  const keys = new Set<string>();
  const whitespace = () => { while (/[ \t\r\n]/.test(input[cursor] ?? '') && cursor < input.length) cursor++; };
  const result = (complete = false) => (type === 'reply' || type === 'finish') && content !== undefined && !(type === 'reply' && keys.has('title'))
    ? { kind: type === 'reply' ? 'reply' as const : 'report' as const, content, complete } : null;
  whitespace();
  if (input[cursor++] !== '{') return null;
  while (cursor < input.length) {
    whitespace();
    if (cursor === input.length) return result();
    const key = stringPrefix(input, cursor);
    if (!key) return null;
    if (!key.complete) return result();
    if (!['type', 'title', 'content', 'citations'].includes(key.value) || keys.has(key.value)) return null;
    keys.add(key.value);
    cursor = key.end;
    whitespace();
    if (cursor === input.length) return result();
    if (input[cursor++] !== ':') return null;
    whitespace();
    if (cursor === input.length) return result();
    if (key.value === 'citations') {
      if (input[cursor++] !== '[') return null;
      whitespace();
      if (cursor === input.length) return result();
      if (input[cursor] !== ']') {
        while (cursor < input.length) {
          const citation = stringPrefix(input, cursor);
          if (!citation) return null;
          if (!citation.complete) return result();
          cursor = citation.end;
          whitespace();
          if (cursor === input.length) return result();
          if (input[cursor] === ']') break;
          if (input[cursor++] !== ',') return null;
          whitespace();
          if (cursor === input.length) return result();
        }
      }
      cursor++;
    } else {
      const value = stringPrefix(input, cursor);
      if (!value) return null;
      if (key.value === 'content') content = value.value;
      if (key.value === 'type' && value.complete) {
        type = value.value;
        if (type !== 'reply' && type !== 'finish') return null;
      }
      if (!value.complete) return result();
      cursor = value.end;
    }
    whitespace();
    if (cursor === input.length) return result();
    if (input[cursor] === '}') {
      cursor++;
      whitespace();
      return cursor === input.length ? result(true) : null;
    }
    if (input[cursor++] !== ',') return null;
  }
  return result();
}

export function visibleNarrativeProse(content: string): string {
  // Saved Markdown owns citation rendering. Draft prose withholds source links,
  // legacy source notes and unfinished brackets instead of exposing their IDs.
  let visible = '';
  let cursor = 0;
  while (cursor < content.length) {
    if (content[cursor] !== '[') { visible += content[cursor++]; continue; }
    const start = cursor++;
    let brackets = 1;
    while (cursor < content.length && brackets) {
      if (content[cursor] === '\\') { cursor += 2; continue; }
      if (content[cursor] === '[') brackets++;
      if (content[cursor] === ']') brackets--;
      cursor++;
    }
    if (brackets) break;
    const label = content.slice(start, cursor);
    if (/^\[Source:/i.test(label)) continue;
    // The next chunk may turn a closed label into a source link.
    if (cursor === content.length) break;
    if (content[cursor] === '(') {
      let parentheses = 1;
      cursor++;
      while (cursor < content.length && parentheses) {
        if (content[cursor] === '\\') { cursor += 2; continue; }
        if (content[cursor] === '(') parentheses++;
        if (content[cursor] === ')') parentheses--;
        cursor++;
      }
      if (parentheses) break;
      if (/\]\(\s*source\s*:/i.test(content.slice(start, cursor))) continue;
    }
    visible += content.slice(start, cursor);
  }
  return visible.replace(/[\uD800-\uDBFF]$/, '');
}

/** Read provisional public prose from the current model turn. This never creates
 * an artifact, executes an action, or claims validation. A model-complete record
 * may still be displayed while the runtime validates it; a saved result replaces
 * it as soon as the run ends. Rejections and terminal events clear it immediately. */
export function streamingNarrative(events: RunEvent[], status: RunStatus): StreamingNarrative | null {
  if (status !== 'running') return null;
  const latest = groupModelActivity(events, status).filter((item): item is ModelTurn => item.kind === 'model-turn').at(-1);
  if (!latest || !['receiving', 'complete'].includes(latest.state) || latest.tools.length) return null;
  if (events.some(event => event.sequence > latest.sequence && (
    ['completed', 'cancelled', 'failed', 'interrupted'].includes(event.type)
    || (event.type === 'model' && object(event.output) && 'validationError' in event.output)
  ))) return null;
  const parsed = narrativePrefix(latest.output);
  if (!parsed || (latest.state === 'complete' && !parsed.complete)) return null;
  const content = visibleNarrativeProse(parsed.content);
  return content ? { kind: parsed.kind, requestId: latest.requestId, content } : null;
}

/** Compatibility for callers that only show unfinished conversational replies. */
export function streamingReply(events: RunEvent[], status: RunStatus): string | null {
  const narrative = streamingNarrative(events, status);
  if (!narrative || narrative.kind !== 'reply') return null;
  if (events.some(event => event.requestId === narrative.requestId && event.streamPhase === 'completed')) return null;
  return narrative.content;
}
