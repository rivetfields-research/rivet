import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLocalProvider } from './provider.ts';

async function endpoint(t: TestContext, handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1`;
}

test('local adapter discovers its model and requests bounded nonstreaming JSON actions', async t => {
  let payload: Record<string, unknown> | undefined;
  const base = await endpoint(t, (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'local-test' }] })); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      payload = JSON.parse(body);
      response.end(JSON.stringify({ choices: [{ message: { content: '{"type":"finish"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 4 } }));
    });
  });
  const adapter = createLocalProvider({ modelBaseUrl: base });
  const available = await adapter.status(AbortSignal.timeout(1000));
  assert.equal(available.available, true);
  assert.equal(available.model, 'local-test');
  const result = await adapter.complete({ messages: [{ role: 'user', content: 'Example task' }], model: available.model!, maxOutputTokens: 600, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(result.usage, { inputTokens: 17, outputTokens: 4 });
  assert.equal(payload?.max_tokens, 600);
  assert.equal(payload?.stream, false);
  assert.equal(payload?.model, 'local-test');
  assert.equal(payload?.reasoning_effort, undefined);
  assert.equal(payload?.response_format, undefined);
});

test('desktop reasoning control is explicit and pinned for both completion paths', async t => {
  const options: Parameters<typeof createLocalProvider>[0] = { modelBaseUrl: 'http://localhost/v1', modelReasoningEffort: 'none' };
  const provider = createLocalProvider(options);
  options.modelReasoningEffort = undefined;
  const payloads: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)); payloads.push(payload);
    return payload.stream ? new Response(sse(delta('{"type":"reply","content":"Ready."}')) + stop + done, { headers: { 'Content-Type': 'text/event-stream' } })
      : Response.json({ choices: [{ message: { content: '{"type":"reply","content":"Ready."}' }, finish_reason: 'stop' }] });
  });
  const request = { messages: [], model: 'example', maxOutputTokens: 600, signal: AbortSignal.timeout(1000) };
  await provider.complete(request);
  await provider.complete({ ...request, onDelta: () => {} });
  assert.deepEqual(payloads.map(payload => payload.reasoning_effort), ['none', 'none']);
  assert.throws(() => createLocalProvider({ ...options, modelReasoningEffort: 'invalid' as 'none' }));
});

test('desktop JSON mode is explicit and pinned without weakening action validation', async t => {
  const options: Parameters<typeof createLocalProvider>[0] = { modelBaseUrl: 'http://localhost/v1', modelResponseFormat: 'json_object' };
  const provider = createLocalProvider(options);
  options.modelResponseFormat = undefined;
  const payloads: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)); payloads.push(payload);
    return payload.stream ? new Response(sse(delta('{"type":"reply","content":"Ready."}')) + stop + done, { headers: { 'Content-Type': 'text/event-stream' } })
      : Response.json({ choices: [{ message: { content: '{"type":"reply","content":"Ready."}' }, finish_reason: 'stop' }] });
  });
  const request = { messages: [], model: 'example', maxOutputTokens: 600, signal: AbortSignal.timeout(1000) };
  await provider.complete(request);
  await provider.complete({ ...request, onDelta: () => {} });
  assert.deepEqual(payloads.map(payload => payload.response_format), [{ type: 'json_object' }, { type: 'json_object' }]);
  assert.deepEqual(payloads.map(payload => payload.max_tokens), [600, 600]);
  assert.throws(() => createLocalProvider({ ...options, modelResponseFormat: 'text' as 'json_object' }), { code: 'invalid_model_response_format' });
});

test('an unadvertised configured model is unavailable', async t => {
  const base = await endpoint(t, (_request, response) => response.end(JSON.stringify({ data: [{ id: 'different-model' }] })));
  const result = await createLocalProvider({ modelBaseUrl: base, modelId: 'requested-model' }).status(AbortSignal.timeout(1000));
  assert.equal(result.available, false);
  assert.match(result.message, /not advertised/);
});

test('an explicitly unselected model never discovers or calls a model in browse-only mode', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('No request is allowed.'); });
  const provider = createLocalProvider({ modelBaseUrl: 'http://localhost/v1', modelId: '' });
  const status = await provider.status(AbortSignal.timeout(1000));
  assert.equal(status.configured, false);
  assert.equal(status.available, false);
  assert.equal(status.model, null);
  await assert.rejects(provider.complete({ messages: [], model: 'not-selected', maxOutputTokens: 600, signal: AbortSignal.timeout(1000) }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'model_unavailable');
  assert.equal(calls, 0);
});

test('malformed, oversized, and non-success responses are rejected without echoing their body', async t => {
  let variant = 'malformed';
  const base = await endpoint(t, (_request, response) => {
    if (variant === 'malformed') response.end('not-json');
    if (variant === 'oversized') response.end('a'.repeat(70 * 1024));
    if (variant === 'server-error') { response.statusCode = 500; response.end('a secret echoed in a provider error'); }
  });
  const adapter = createLocalProvider({ modelBaseUrl: base });
  const request = () => adapter.complete({ messages: [], model: 'test', maxOutputTokens: 600, signal: AbortSignal.timeout(1000) });
  await assert.rejects(request(), /invalid JSON/);
  variant = 'oversized';
  await assert.rejects(request(), /64 KiB/);
  variant = 'server-error';
  await assert.rejects(request(), error => error instanceof Error && error.message === 'Local model returned HTTP 500.');
});

test('adapter propagates cancellation to an HTTP request that has not completed', async t => {
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const base = await endpoint(t, () => { entered(); });
  const controller = new AbortController();
  const adapter = createLocalProvider({ modelBaseUrl: base });
  const completion = adapter.complete({ messages: [], model: 'test', maxOutputTokens: 600, signal: controller.signal });
  await enteredPromise;
  controller.abort(new Error('Test cancellation'));
  await assert.rejects(completion, /Test cancellation/);
});

test('redirects cannot move requests beyond the configured loopback endpoint', async t => {
  const base = await endpoint(t, (_request, response) => {
    response.statusCode = 302;
    response.setHeader('Location', 'https://example.com/should-not-be-called');
    response.end();
  });
  const adapter = createLocalProvider({ modelBaseUrl: base });
  assert.equal((await adapter.status(AbortSignal.timeout(1000))).available, false);
});

test('missing or invalid provider usage remains unreported', async t => {
  const base = await endpoint(t, (_request, response) => response.end(JSON.stringify({ choices: [{ message: { content: '{"type":"finish"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: -1, completion_tokens: 'unknown' } })));
  const result = await createLocalProvider({ modelBaseUrl: base }).complete({ messages: [], model: 'test', maxOutputTokens: 600, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(result.usage, { inputTokens: undefined, outputTokens: undefined });
});

const sse = (value: unknown, newline = '\n') => `data: ${JSON.stringify(value)}${newline}${newline}`;
const delta = (content: string | null, finish: string | null = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] });
const stop = sse(delta('', 'stop'));
const done = 'data: [DONE]\n\n';
const streamRequest = (onDelta: (text: string) => void | Promise<void>, signal = AbortSignal.timeout(2000)) => ({ messages: [], model: 'test', maxOutputTokens: 600, signal, onDelta });

function mockStream(t: TestContext, chunks: (string | Uint8Array)[], contentType = 'text/event-stream') {
  let position = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position === chunks.length) { controller.close(); return; }
      const chunk = chunks[position++];
      controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'Content-Type': contentType } }));
  return { body, cancelled: () => cancelled, chunksRead: () => position };
}

test('streamed text arrives before completion and includes final usage without duplicating fragments', async t => {
  let payload: Record<string, unknown> | undefined;
  let finish!: () => void, arrived!: () => void;
  const firstDelta = new Promise<void>(resolve => { arrived = resolve; });
  const base = await endpoint(t, (request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      payload = JSON.parse(body);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      finish = () => response.end(sse(delta('"finish"}')) + stop + sse({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 4 } }) + done);
      response.write(sse(delta('{"type":')));
    });
  });
  let complete = false;
  const fragments: string[] = [];
  const completion = createLocalProvider({ modelBaseUrl: base }).complete(streamRequest(text => { fragments.push(text); arrived(); })).then(result => { complete = true; return result; });
  await firstDelta;
  assert.equal(complete, false);
  assert.deepEqual(fragments, ['{"type":']);
  assert.equal(payload?.stream, true);
  assert.equal(payload?.max_tokens, 600);
  assert.deepEqual(payload?.stream_options, { include_usage: true });
  finish();
  const result = await completion;
  assert.equal(result.content, '{"type":"finish"}');
  assert.equal(fragments.join(''), result.content);
  assert.equal(fragments.length, 2);
  assert.deepEqual(result.usage, { inputTokens: 17, outputTokens: 4 });
});

test('SSE parsing handles split UTF-8, CRLF, multiple data lines and role events while ignoring reasoning', async t => {
  const multiLine = 'data: {"choices":\r\ndata: [{"index":0,"delta":{"content":"café 🧭"},"finish_reason":null}]}\r\n\r\n';
  const wire = '\uFEFF: heartbeat\r\n\r\n' + sse({ choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'private', reasoning_content: 'private too' }, finish_reason: null }] }, '\r\n') + multiLine + stop + done;
  const bytes = new TextEncoder().encode(wire);
  const stream = mockStream(t, [...bytes].map(byte => new Uint8Array([byte])));
  const fragments: string[] = [];
  const result = await createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(text => { fragments.push(text); }));
  assert.deepEqual(fragments, ['café 🧭']);
  assert.equal(result.content, 'café 🧭');
  assert.equal(result.usage, undefined);
  assert.equal(stream.body.locked, false);
  assert.equal(stream.cancelled(), true);
});

test('streaming awaits each delta callback before reading another chunk', async t => {
  const stream = mockStream(t, [sse(delta('first')), sse(delta(' second')), stop, done]);
  let release!: () => void, arrived!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const firstDelta = new Promise<void>(resolve => { arrived = resolve; });
  const fragments: string[] = [];
  const completion = createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(async text => {
    fragments.push(text);
    if (text === 'first') { arrived(); await blocked; }
  }));
  await firstDelta;
  assert.equal(stream.chunksRead(), 1);
  assert.deepEqual(fragments, ['first']);
  release();
  assert.equal((await completion).content, 'first second');
  assert.deepEqual(fragments, ['first', ' second']);
  assert.equal(stream.body.locked, false);
});

test('malformed and truncated streams cannot return a completed action', async t => {
  const cases: Record<string, (string | Uint8Array)[]> = {
    'invalid JSON': ['data: provider-secret-not-json\n\n'],
    'error object': [sse({ error: { message: 'provider-secret' } })],
    'missing choices': [sse({ content: 'provider-secret' })],
    'invalid delta': [sse({ choices: [{ index: 0, delta: { content: ['provider-secret'] } }] })],
    'multiple choices': [sse({ choices: [delta('one').choices[0], { index: 1, delta: { content: 'two' } }] })],
    'wrong choice': [sse({ choices: [{ index: 1, delta: { content: 'provider-secret' } }] })],
    'no final marker': [sse(delta('partial')), stop],
    'no finish reason': [sse(delta('partial')), done],
    'unfinished event': [sse(delta('partial')), stop, 'data: [DONE]\n'],
    'unfinished JSON': [sse(delta('partial')), 'data: {'],
    'content filter finish': [sse(delta('partial', 'content_filter')), done],
    'text after finish': [sse(delta('one')), stop, sse(delta('two')), done],
    'empty response': [stop, done],
    'invalid UTF-8': [new Uint8Array([0xc3, 0x28])],
    'incomplete UTF-8': [new Uint8Array([0xc3])],
  };
  for (const [name, chunks] of Object.entries(cases)) await t.test(name, async t => {
    const stream = mockStream(t, chunks);
    await assert.rejects(createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(() => {})), error => error instanceof Error && error.message === 'Local model returned an invalid or incomplete stream.');
    assert.equal(stream.body.locked, false);
  });
});

test('local model incompatibility, refusal and truncation stay actionable and never complete', async t => {
  for (const [name, choice, code] of [
    ['native tool', { delta: { tool_calls: [{ function: { name: 'private-provider-payload' } }] }, finish_reason: null }, 'provider_action_format'],
    ['legacy function', { delta: { function_call: { name: 'private-provider-payload', arguments: '{}' } }, finish_reason: 'function_call' }, 'provider_action_format'],
    ['tool finish', { delta: { content: '{}' }, finish_reason: 'tool_calls' }, 'provider_action_format'],
    ['length finish', { delta: { content: '{}' }, finish_reason: 'length' }, 'provider_output_truncated'],
    ['refusal', { delta: { refusal: 'private-provider-payload' }, finish_reason: 'stop' }, 'provider_refusal'],
  ] as const) await t.test(name, async t => {
    const stream = mockStream(t, [sse({ choices: [{ index: 0, ...choice }] }), done]);
    const fragments: string[] = [];
    await assert.rejects(createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(text => { fragments.push(text); })),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === code && !error.message.includes('private-provider-payload'));
    assert.deepEqual(fragments, []);
    assert.equal(stream.body.locked, false);
    assert.equal(stream.cancelled(), true);
  });
});

test('buffered local responses cannot hide native actions, refusals or incomplete output', async t => {
  for (const [name, choice, code] of [
    ['native tool', { message: { content: '{"type":"finish"}', tool_calls: [{}] }, finish_reason: 'stop' }, 'provider_action_format'],
    ['legacy function', { message: { content: '{}', function_call: {} }, finish_reason: 'stop' }, 'provider_action_format'],
    ['tool finish', { message: { content: '{}' }, finish_reason: 'tool_calls' }, 'provider_action_format'],
    ['refusal', { message: { content: '{}', refusal: 'private-provider-payload' }, finish_reason: 'stop' }, 'provider_refusal'],
    ['length finish', { message: { content: '{}' }, finish_reason: 'length' }, 'provider_output_truncated'],
    ['unknown finish', { message: { content: '{}' }, finish_reason: 'unexpected' }, 'provider_error'],
    ['missing finish', { message: { content: '{}' } }, 'provider_error'],
    ['wrong choice', { index: 1, message: { content: '{}' }, finish_reason: 'stop' }, 'provider_error'],
  ] as const) await t.test(name, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [choice] }));
    await assert.rejects(createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete({ messages: [], model: 'test', maxOutputTokens: 600, signal: AbortSignal.timeout(1000) }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === code && !error.message.includes('private-provider-payload'));
  });
});

test('one completed local native action translates to the same JSON protocol without publishing argument fragments', async t => {
  const stream = mockStream(t, [
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-one', type: 'function' }] }, finish_reason: null }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-one', type: 'function', function: { name: 'tool.workspace.read', arguments: '{"sourceId":' } }] }, finish_reason: null }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"source_exact"}' } }] }, finish_reason: null }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), done,
  ]);
  const fragments: string[] = [];
  const result = await createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(text => { fragments.push(text); }));
  assert.deepEqual(JSON.parse(result.content), { type: 'tool', name: 'workspace.read', arguments: { sourceId: 'source_exact' } });
  assert.deepEqual(fragments, []);
  assert.equal(stream.body.locked, false);
});

test('empty native call lists do not prevent a normal JSON text completion', async t => {
  const content = '{"type":"reply","content":"Ready."}';
  const chunks = sse({ choices: [{ index: 0, delta: { content, tool_calls: [] }, finish_reason: null }] }) + stop + done;
  let streaming = true;
  t.mock.method(globalThis, 'fetch', async () => streaming
    ? new Response(chunks, { headers: { 'Content-Type': 'text/event-stream' } })
    : Response.json({ choices: [{ message: { content, tool_calls: [] }, finish_reason: 'stop' }] }));
  const provider = createLocalProvider({ modelBaseUrl: 'http://localhost/v1' });
  assert.equal((await provider.complete(streamRequest(() => {}))).content, content);
  streaming = false;
  assert.equal((await provider.complete({ ...streamRequest(() => {}), onDelta: undefined })).content, content);
});

test('buffered native reply, finish and tool shapes preserve runtime-owned validation', async t => {
  for (const [name, args, expected] of [
    ['reply', { content: 'Ready.' }, { type: 'reply', content: 'Ready.' }],
    ['finish', { title: 'Report', content: 'Text', citations: ['source_exact'] }, { type: 'finish', title: 'Report', content: 'Text', citations: ['source_exact'] }],
    ['tool', { name: 'workspace.read', arguments: { sourceId: 'source_exact' } }, { type: 'tool', name: 'workspace.read', arguments: { sourceId: 'source_exact' } }],
    ['tool.workspace.not_registered', { sourceId: 'source_exact' }, { type: 'tool', name: 'workspace.not_registered', arguments: { sourceId: 'source_exact' } }],
    ['workspace.read', { sourceId: 'source_exact' }, { type: 'tool', name: 'workspace.read', arguments: { sourceId: 'source_exact' } }],
  ] as const) await t.test(name, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: '', tool_calls: [{ type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }));
    const result = await createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete({ messages: [], model: 'test', maxOutputTokens: 600, signal: AbortSignal.timeout(1000) });
    assert.deepEqual(JSON.parse(result.content), expected);
  });
});

test('native action translation rejects mixed, multiple, changed, malformed and unterminated calls', async t => {
  const call = (args = '{}', name = 'reply', extra = {}) => ({ index: 0, id: 'one', type: 'function', function: { name, arguments: args }, ...extra });
  const event = (calls: unknown[], text?: string) => sse({ choices: [{ index: 0, delta: { tool_calls: calls, content: text }, finish_reason: null }] });
  const finish = sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  for (const [name, chunks] of Object.entries({
    mixed: [event([call()], 'not an action')],
    multiple: [event([call(), call('{}', 'finish', { index: 1 })])],
    changedId: [event([call('{')]), event([call('}', '', { id: 'two' })])],
    wrongIndex: [event([call('{}', 'reply', { index: 1 })])],
    invalidArguments: [event([call('not JSON')]), finish, done],
    nonObject: [event([call('[]')]), finish, done],
    injectedType: [event([call('{"type":"finish"}')]), finish, done],
    arbitraryFunction: [event([call('{}', 'delete_files')]), finish, done],
    noFinish: [event([call()]), done],
    noDone: [event([call()]), finish],
    wrongFinish: [event([call()]), stop, done],
  })) await t.test(name, async t => {
    const stream = mockStream(t, chunks);
    await assert.rejects(createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(() => {})));
    assert.equal(stream.body.locked, false);
  });
});

test('bounded streaming rejects oversized events, assembled text and aggregate metadata', async t => {
  const cases = [
    { name: 'event', chunks: [': ' + 'x'.repeat(64 * 1024)], message: /event exceeded 64 KiB/ },
    { name: 'text', chunks: [sse(delta('x'.repeat(40 * 1024))), sse(delta('x'.repeat(40 * 1024)))], message: /text exceeded 64 KiB/ },
    { name: 'aggregate', chunks: Array.from({ length: 18 }, () => ': ' + 'x'.repeat(60 * 1024) + '\n\n'), message: /stream exceeded 1 MiB/ },
  ];
  for (const { name, chunks, message } of cases) await t.test(name, async t => {
    const stream = mockStream(t, chunks);
    await assert.rejects(createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(() => {})), message);
    assert.equal(stream.body.locked, false);
    assert.equal(stream.cancelled(), true);
  });
});

test('missing and invalid streaming usage stays undefined while valid reported fields are retained', async t => {
  const cases = [
    { usage: undefined, expected: undefined },
    { usage: { prompt_tokens: -1, completion_tokens: 'unknown' }, expected: undefined },
    { usage: { prompt_tokens: 9, completion_tokens: null }, expected: { inputTokens: 9, outputTokens: undefined } },
    { usage: { prompt_tokens: null, completion_tokens: 3 }, expected: { inputTokens: undefined, outputTokens: 3 } },
  ];
  for (const [index, entry] of cases.entries()) await t.test(String(index), async t => {
    mockStream(t, [sse(delta('response')), stop, ...(entry.usage ? [sse({ choices: [], usage: entry.usage })] : []), done]);
    const result = await createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(() => {}));
    assert.deepEqual(result.usage, entry.expected);
  });
});

test('abort while awaiting a delta cancels and releases the reader without delivering queued text', async t => {
  const stream = mockStream(t, [sse(delta('first')), sse(delta(' second')), stop, done]);
  const controller = new AbortController();
  let arrived!: () => void;
  const firstDelta = new Promise<void>(resolve => { arrived = resolve; });
  const fragments: string[] = [];
  const completion = createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(text => {
    fragments.push(text); arrived();
    return new Promise<void>(() => {});
  }, controller.signal));
  await firstDelta;
  controller.abort(new Error('Test streaming cancellation'));
  await assert.rejects(completion, /Test streaming cancellation/);
  assert.deepEqual(fragments, ['first']);
  assert.equal(stream.chunksRead(), 1);
  assert.equal(stream.cancelled(), true);
  assert.equal(stream.body.locked, false);
});

test('abort during a pending reader read cancels and releases the stream', async t => {
  let waiting!: () => void, cancelled = false;
  const reading = new Promise<void>(resolve => { waiting = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull() { waiting(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  const controller = new AbortController();
  const completion = createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(() => assert.fail('No text was supplied'), controller.signal));
  await reading;
  controller.abort(new Error('Cancelled waiting for model'));
  await assert.rejects(completion, /Cancelled waiting for model/);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('stream transport, content type and consumer errors remain generic and close the reader', async t => {
  await t.test('transport', async t => {
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('provider-secret'); });
    await assert.rejects(createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(() => {})), error => error instanceof Error && error.message === 'Local model request failed.');
  });
  await t.test('content type', async t => {
    const stream = mockStream(t, ['provider-secret'], 'application/json');
    await assert.rejects(createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(() => {})), /invalid or incomplete stream/);
    assert.equal(stream.cancelled(), true);
    assert.equal(stream.body.locked, false);
  });
  await t.test('consumer', async t => {
    const stream = mockStream(t, [sse(delta('first')), stop, done]);
    await assert.rejects(createLocalProvider({ modelBaseUrl: 'http://localhost/v1' }).complete(streamRequest(() => { throw new Error('provider-secret'); })), error => error instanceof Error && error.message === 'Local model returned an invalid or incomplete stream.');
    assert.equal(stream.cancelled(), true);
    assert.equal(stream.body.locked, false);
  });
});
