import type { ProviderStatus } from './types.ts';
import { HarnessError } from './errors.ts';

export interface ModelMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ModelCompletion {
  content: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}
export interface ModelProvider {
  status(signal: AbortSignal): Promise<ProviderStatus>;
  complete(request: { messages: ModelMessage[]; maxOutputTokens: number; signal: AbortSignal; model: string; onDelta?: (text: string) => void | Promise<void> }): Promise<ModelCompletion>;
}

const EVENT_BYTES = 64 * 1024;
const STREAM_BYTES = 1024 * 1024;
const TEXT_BYTES = 64 * 1024;
const validTokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const streamError = () => new HarnessError('Local model returned an invalid or incomplete stream.', 502, 'provider_error');
const localActionFormatError = () => new HarnessError('This local model returned native tool calls instead of Rivet JSON actions. No returned action was executed. Choose a compatible model in Model settings. Your saved work is unchanged.', 502, 'provider_action_format');
const localTruncatedError = () => new HarnessError('The local model reached its response limit before finishing. Try a shorter request or a different model. Your saved work is unchanged.', 502, 'provider_output_truncated');
const localRefusalError = () => new HarnessError('The local model declined this request. Your saved work is unchanged.', 502, 'provider_refusal');

function nativeAction(name: string, args: string): string {
  let value: unknown;
  try { value = JSON.parse(args); } catch { throw localActionFormatError(); }
  if (!record(value) || Object.hasOwn(value, 'type') || name.length > 128 || /[\x00-\x20\x7f]/.test(name)) throw localActionFormatError();
  // Some local models encode the prompted JSON action as a function call even
  // without native tool declarations. This does not register or execute tools.
  const action = name.startsWith('tool.') && name.length > 5
    ? { type: 'tool', name: name.slice(5), arguments: value }
    : name.startsWith('workspace.') ? { type: 'tool', name, arguments: value }
    : ['tool', 'reply', 'finish'].includes(name) ? { type: name, ...value } : undefined;
  if (!action) throw localActionFormatError();
  const content = JSON.stringify(action);
  if (Buffer.byteLength(content, 'utf8') > TEXT_BYTES) throw new HarnessError('Local model text exceeded 64 KiB.', 502, 'provider_response_limit');
  return content;
}

async function deliverDelta(onDelta: (text: string) => void | Promise<void>, text: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return onDelta(text); }), interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
  signal.throwIfAborted();
}

export async function readCompletionStream(response: Response, signal: AbortSignal, onDelta: (text: string) => void | Promise<void>, options: { azureAnnotations?: boolean; localActions?: boolean } = {}): Promise<ModelCompletion> {
  if (!response.body) throw streamError();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, eventBytes = 0, textBytes = 0;
  let line = '', content = '', data: string[] = [];
  let skipLf = false, finished = false, done = false;
  let usage: ModelCompletion['usage'];
  let native: { kind: 'tool_calls' | 'function_call'; id?: string; name: string; args: string } | undefined;

  const dispatch = async () => {
    if (!data.length) return;
    const value = data.join('\n');
    data = [];
    if (value === '[DONE]') {
      if (!finished || !content.trim()) throw streamError();
      done = true;
      return;
    }
    let event: unknown;
    try { event = JSON.parse(value); } catch { throw streamError(); }
    if (!record(event) || event.error !== undefined || !Array.isArray(event.choices)) throw streamError();
    // Azure's default filter can precede text with an empty-choice prompt annotation.
    // Never enable asynchronous filtering here: this reader cannot retract displayed text.
    if (options.azureAnnotations) {
      const filters: unknown[] = [event.prompt_filter_results, event.prompt_annotations, ...event.choices.map(choice => record(choice) ? choice.content_filter_results : undefined)];
      while (filters.length) {
        const item = filters.pop();
        if (Array.isArray(item)) filters.push(...item);
        else if (record(item)) {
          if (item.filtered === true) throw new HarnessError('Azure model content was blocked by its filter.', 502, 'provider_content_filter');
          filters.push(...Object.values(item));
        }
      }
      if (event.choices.some(choice => record(choice) && choice.content_filter_offsets !== undefined)) {
        throw new HarnessError('Azure sent delayed filter checks that cannot be used with live streaming. The workspace owner can enable buffered responses. Your saved data is unchanged.', 502, 'provider_stream_configuration');
      }
    }
    if (record(event.usage)) {
      const inputTokens = event.usage.prompt_tokens, outputTokens = event.usage.completion_tokens;
      if (validTokens(inputTokens) || validTokens(outputTokens)) {
        usage = { inputTokens: validTokens(inputTokens) ? inputTokens : usage?.inputTokens, outputTokens: validTokens(outputTokens) ? outputTokens : usage?.outputTokens };
      }
    }
    // Usage is a separate event in MLX/OpenAI streams; only one text choice is requested.
    if (!event.choices.length) {
      const annotations = event.prompt_filter_results ?? event.prompt_annotations;
      const promptAnnotation = options.azureAnnotations && !finished && !content.length && Array.isArray(annotations) && annotations.length > 0 && annotations.every(item => record(item) && Number.isSafeInteger(item.prompt_index) && Number(item.prompt_index) >= 0 && record(item.content_filter_results));
      if (!record(event.usage) && !promptAnnotation) throw streamError();
      return;
    }
    if (finished || event.choices.length !== 1) throw streamError();
    const choice: unknown = event.choices[0];
    if (!record(choice) || (choice.index !== undefined && choice.index !== 0) || !record(choice.delta)) throw streamError();
    if (options.azureAnnotations && choice.finish_reason === 'content_filter') throw new HarnessError('Azure model content was blocked by its filter.', 502, 'provider_content_filter');
    if (options.azureAnnotations && (choice.delta.tool_calls != null || choice.delta.function_call != null || choice.delta.refusal != null)) throw streamError();
    if (!options.azureAnnotations) {
      if (choice.delta.refusal != null) throw localRefusalError();
      if (choice.finish_reason === 'length') throw localTruncatedError();
      const hasToolCalls = choice.delta.tool_calls != null && !(Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0);
      if (hasToolCalls || choice.delta.function_call != null) {
        if (!options.localActions || content || (hasToolCalls && choice.delta.function_call != null)) throw localActionFormatError();
        const kind = hasToolCalls ? 'tool_calls' : 'function_call';
        let call: unknown = choice.delta.function_call;
        let id: unknown;
        if (kind === 'tool_calls') {
          const calls = choice.delta.tool_calls;
          if (!Array.isArray(calls) || calls.length !== 1 || !record(calls[0]) || calls[0].index !== 0 || (calls[0].type !== undefined && calls[0].type !== 'function')) throw localActionFormatError();
          call = calls[0].function ?? {};
          id = calls[0].id;
          if (id !== undefined && (typeof id !== 'string' || id.length > 256)) throw localActionFormatError();
        }
        if (!record(call) || (call.name !== undefined && typeof call.name !== 'string') || (call.arguments !== undefined && typeof call.arguments !== 'string')) throw localActionFormatError();
        native ??= { kind, name: '', args: '' };
        if (native.kind !== kind || (native.id !== undefined && id !== undefined && native.id !== id)) throw localActionFormatError();
        if (typeof id === 'string') native.id = id;
        native.name += call.name ?? '';
        native.args += call.arguments ?? '';
        if (native.name.length > 128 || Buffer.byteLength(native.args, 'utf8') > TEXT_BYTES) throw new HarnessError('Local model action exceeded its size limit.', 502, 'provider_response_limit');
      }
      if ((choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') && !native) throw localActionFormatError();
    }
    const text = choice.delta.content;
    if (text !== undefined && text !== null && typeof text !== 'string') throw streamError();
    // Reasoning, tool-call fields and other provider metadata never become visible text.
    if (typeof text === 'string' && text.length) {
      if (native) throw localActionFormatError();
      textBytes += Buffer.byteLength(text, 'utf8');
      if (textBytes > TEXT_BYTES) throw new HarnessError('Local model text exceeded 64 KiB.', 502, 'provider_response_limit');
      content += text;
      await deliverDelta(onDelta, text, signal);
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (options.azureAnnotations && choice.finish_reason === 'length') throw new HarnessError('Azure reached the response length limit before finishing. Try a shorter report. Your saved data is unchanged.', 502, 'provider_output_truncated');
      if (native) {
        if (choice.finish_reason !== native.kind) throw localActionFormatError();
        content = nativeAction(native.name, native.args);
      } else if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') throw localActionFormatError();
      else if (choice.finish_reason !== 'stop') throw streamError();
      finished = true;
    }
  };
  const acceptLine = async () => {
    if (!line) {
      await dispatch();
      eventBytes = 0;
    } else if (line === 'data') data.push('');
    else if (line.startsWith('data:')) data.push(line.slice(line[5] === ' ' ? 6 : 5));
    // SSE comments, id, retry and event fields do not carry model content.
    line = '';
  };
  const append = (part: string, delimiter = 0) => {
    eventBytes += Buffer.byteLength(part, 'utf8') + delimiter;
    if (eventBytes > EVENT_BYTES) throw new HarnessError('Local model stream event exceeded 64 KiB.', 502, 'provider_response_limit');
    line += part;
  };

  try {
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') throw streamError();
    while (!done) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        decoder.decode();
        if (options.azureAnnotations) throw new HarnessError('The Azure response ended before completion was confirmed. Your saved data is unchanged. Try again.', 502, 'provider_stream_incomplete');
        throw streamError();
      }
      bytes += chunk.value.byteLength;
      if (bytes > STREAM_BYTES) throw new HarnessError('Local model stream exceeded 1 MiB.', 502, 'provider_response_limit');
      const text = decoder.decode(chunk.value, { stream: true });
      if (!text.length) continue;
      let start = skipLf && text[0] === '\n' ? 1 : 0;
      skipLf = false;
      for (let i = start; i < text.length; i++) {
        if (text[i] !== '\r' && text[i] !== '\n') continue;
        // Count CRLF conservatively even when the pair straddles network chunks.
        append(text.slice(start, i), text[i] === '\r' ? 2 : 1);
        await acceptLine();
        if (done) break;
        if (text[i] === '\r') {
          if (text[i + 1] === '\n') i++;
          else if (i === text.length - 1) skipLf = true;
        }
        start = i + 1;
      }
      if (!done) append(text.slice(start));
    }
    signal.throwIfAborted();
    return { content, usage };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof HarnessError) throw error;
    throw streamError();
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createLocalProvider(options: { modelBaseUrl: string; modelId?: string; modelApiKey?: string; modelReasoningEffort?: 'none'; modelResponseFormat?: 'json_object' }): ModelProvider {
  const base = new URL(options.modelBaseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash) {
    throw new HarnessError('This initial harness supports only a local model endpoint on loopback.', 400, 'invalid_model_endpoint');
  }
  const url = base.href.replace(/\/$/, '');
  const reasoningEffort = options.modelReasoningEffort;
  if (reasoningEffort !== undefined && reasoningEffort !== 'none') throw new HarnessError('Local reasoning control must be none or unset.', 400, 'invalid_model_reasoning_effort');
  const responseFormat = options.modelResponseFormat;
  if (responseFormat !== undefined && responseFormat !== 'json_object') throw new HarnessError('Local response format must be json_object or unset.', 400, 'invalid_model_response_format');
  const inferenceOptions = { ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(responseFormat === undefined ? {} : { response_format: { type: responseFormat } }) };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.modelApiKey) headers.Authorization = `Bearer ${options.modelApiKey}`;
  const requestJson = async (path: string, signal: AbortSignal, payload?: unknown) => {
    const response = await fetch(`${url}${path}`, { method: payload ? 'POST' : 'GET', headers, body: payload ? JSON.stringify(payload) : undefined, signal, redirect: 'error' });
    if (!response.ok) throw new HarnessError(`Local model returned HTTP ${response.status}.`, 502, 'provider_error');
    if (!response.body) throw new HarnessError('Local model returned an empty response.', 502, 'provider_error');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 64 * 1024) throw new HarnessError('Local model response exceeded 64 KiB.', 502, 'provider_response_limit');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HarnessError('Local model returned invalid JSON.', 502, 'provider_error'); }
  };
  return {
    async status(signal) {
      if (options.modelId === '') return { configured: false, available: false, model: null, label: 'Local model not selected', kind: 'openai-compatible', message: 'Choose a local model in Model settings to generate answers.' };
      const result: ProviderStatus = { configured: true, available: false, model: options.modelId ?? null, label: 'Local OpenAI-compatible model', kind: 'openai-compatible', message: 'Local model is unavailable.' };
      try {
        const body = await requestJson('/models', AbortSignal.any([signal, AbortSignal.timeout(1500)]));
        const ids: string[] = Array.isArray(body?.data) ? body.data.map((item: { id?: unknown }) => item?.id).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256) : [];
        const model = options.modelId ?? ids[0];
        if (!model || !ids.includes(model)) return { ...result, message: options.modelId ? 'The configured model is not advertised by the local endpoint.' : 'No model is loaded at the local endpoint.' };
        return { ...result, model, available: true, message: 'Local endpoint is reachable and advertises this model.' };
      } catch { return result; }
    },
    async complete({ messages, maxOutputTokens, signal, model, onDelta }) {
      if (options.modelId === '') throw new HarnessError('Choose a local model in Model settings to generate answers.', 503, 'model_unavailable');
      if (onDelta) {
        let response: Response;
        try {
          response = await fetch(`${url}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model, messages, max_tokens: maxOutputTokens, temperature: 0, stream: true, stream_options: { include_usage: true }, stop: ['<|im_end|>'], ...inferenceOptions }), signal, redirect: 'error' });
        } catch {
          signal.throwIfAborted();
          throw new HarnessError('Local model request failed.', 502, 'provider_error');
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          signal.throwIfAborted();
          throw new HarnessError(`Local model returned HTTP ${response.status}.`, 502, 'provider_error');
        }
        return readCompletionStream(response, signal, onDelta, { localActions: true });
      }
      const body = await requestJson('/chat/completions', signal, { model, messages, max_tokens: maxOutputTokens, temperature: 0, stream: false, stop: ['<|im_end|>'], ...inferenceOptions });
      if (!record(body) || body.error !== undefined || !Array.isArray(body.choices) || body.choices.length !== 1) throw new HarnessError('Local model returned an invalid response.', 502, 'provider_error');
      const choice = body.choices[0];
      if (!record(choice) || (choice.index !== undefined && choice.index !== 0) || !record(choice.message)) throw new HarnessError('Local model returned an invalid response.', 502, 'provider_error');
      if (choice.message.refusal != null) throw localRefusalError();
      if (choice.finish_reason === 'length') throw localTruncatedError();
      const toolCalls = Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length === 0 ? undefined : choice.message.tool_calls;
      const functionCall = choice.message.function_call;
      let nativeContent: string | undefined;
      if (toolCalls != null || functionCall != null) {
        if ((choice.message.content != null && choice.message.content !== '') || (toolCalls != null && functionCall != null)) throw localActionFormatError();
        let call: unknown = functionCall;
        if (toolCalls != null) {
          if (!Array.isArray(toolCalls) || toolCalls.length !== 1 || !record(toolCalls[0]) || toolCalls[0].type !== 'function' || choice.finish_reason !== 'tool_calls') throw localActionFormatError();
          call = toolCalls[0].function;
        } else if (choice.finish_reason !== 'function_call') throw localActionFormatError();
        if (!record(call) || typeof call.name !== 'string' || typeof call.arguments !== 'string') throw localActionFormatError();
        nativeContent = nativeAction(call.name, call.arguments);
      } else if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') throw localActionFormatError();
      if (!nativeContent && choice.finish_reason !== 'stop') throw new HarnessError('Local model did not confirm a completed response.', 502, 'provider_error');
      const content = nativeContent ?? choice.message.content;
      if (typeof content !== 'string' || !content.trim()) throw new HarnessError('Local model returned no action.', 502, 'provider_error');
      const usage = record(body.usage) ? body.usage : {};
      const inputTokens = usage.prompt_tokens;
      const outputTokens = usage.completion_tokens;
      return { content, usage: { inputTokens: validTokens(inputTokens) ? inputTokens : undefined, outputTokens: validTokens(outputTokens) ? outputTokens : undefined } };
    },
  };
}
