import assert from 'node:assert/strict';
import test from 'node:test';
import fs, { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import runtime from '../apps/desktop/runtime.cjs';

test('desktop model settings accept only local OpenAI-compatible endpoints', () => {
  assert.deepEqual(runtime.validateConfig({modelBaseUrl:'http://127.0.0.1:11434/v1/', modelId:' gpt-oss:20b '}), {modelBaseUrl:'http://127.0.0.1:11434/v1', modelId:'gpt-oss:20b'});
  for (const url of ['https://api.example.com/v1', 'http://192.168.0.1/v1', 'http://127.0.0.1:11434/admin', 'http://user:password@localhost/v1', 'http://localhost/v1?secret=x', 'file:///v1']) {
    assert.throws(() => runtime.validateConfig({modelBaseUrl:url,modelId:''}));
  }
  assert.throws(() => runtime.validateConfig({...runtime.DEFAULT_CONFIG, apiKey:'secret'}));
});

test('desktop backend environment never inherits cloud settings, Node hooks or keys', () => {
  const env = runtime.backendEnvironment({directory:'/private/rivet',config:runtime.DEFAULT_CONFIG,port:50123,token:'a'.repeat(64)}, {
    HOME:'/Users/test', NODE_OPTIONS:'--require evil', HARNESS_DATA_DIR:'/production', HARNESS_MODEL_API_KEY:'private', HARNESS_REPORT_EMAIL_MODE:'resend', HARNESS_GOOGLE_CLIENT_SECRET:'private', STRIPE_SECRET_KEY:'private', PATH:'/evil',
  });
  assert.equal(env.HARNESS_DATA_DIR,'/private/rivet/workspace');
  assert.equal(env.HARNESS_REPORT_EMAIL_MODE,'off');
  assert.equal(env.HARNESS_CONNECTIONS_ENABLED,'0');
  assert.equal(env.PATH,'/usr/bin:/bin');
  for (const name of ['NODE_OPTIONS','HARNESS_MODEL_API_KEY','HARNESS_GOOGLE_CLIENT_SECRET','STRIPE_SECRET_KEY']) assert.equal(env[name],undefined);
});

test('desktop settings persist privately and reject extra fields', () => {
  const directory = mkdtempSync(path.join(tmpdir(),'rivet-desktop-settings-'));
  try {
    runtime.privateDirectory(directory);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.deepEqual(runtime.loadConfig(directory),runtime.DEFAULT_CONFIG);
    runtime.saveConfig(directory,{...runtime.DEFAULT_CONFIG,modelId:'test-model'});
    assert.equal(runtime.loadConfig(directory).modelId,'test-model');
    assert.equal(statSync(path.join(directory,'model.json')).mode & 0o777,0o600);
    assert.doesNotMatch(readFileSync(path.join(directory,'model.json'),'utf8'),/token|key/i);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('settings saves survive stale temporary files and clean up a failed write without replacing saved settings', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rivet-desktop-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  runtime.saveConfig(directory, { ...runtime.DEFAULT_CONFIG, modelId: 'saved-model' });
  const stale = path.join(directory, `model-${process.pid}.tmp`);
  writeFileSync(stale, 'incomplete earlier write');
  runtime.saveConfig(directory, { ...runtime.DEFAULT_CONFIG, modelId: 'next-model' });
  assert.equal(runtime.loadConfig(directory).modelId, 'next-model');
  const saved = readFileSync(path.join(directory, 'model.json'));
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', file => {
    write(file, 'partial write');
    throw new Error('Synthetic disk failure');
  });
  assert.throws(() => runtime.saveConfig(directory, runtime.DEFAULT_CONFIG), /Synthetic disk failure/);
  assert.deepEqual(readFileSync(path.join(directory, 'model.json')), saved);
  assert.deepEqual(readdirSync(directory).sort(), [path.basename(stale), 'model.json'].sort());
  assert.equal(readFileSync(stale, 'utf8'), 'incomplete earlier write');
  t.mock.restoreAll();
  runtime.saveConfig(directory, { ...runtime.DEFAULT_CONFIG, modelId: 'retry-model' });
  assert.equal(runtime.loadConfig(directory).modelId, 'retry-model');
});

test('desktop navigation does not accept lookalike origins or dangerous protocols', () => {
  const origin='http://127.0.0.1:50123';
  assert.equal(runtime.internalUrl(origin+'/?report=saved',origin),true);
  for (const url of ['http://127.0.0.1:50124','http://localhost:50123','http://127.0.0.1.evil.test:50123',`blob:${origin}/untrusted`,'file:///etc/passwd','javascript:alert(1)']) assert.equal(runtime.internalUrl(url,origin),false);
  assert.equal(runtime.externalUrl('https://rivetfields.com/'),true);
  for (const url of ['file:///tmp/a','javascript:alert(1)','http://example.com','https://user:password@example.com']) assert.equal(runtime.externalUrl(url),false);
});

async function modelFailure(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof runtime.ModelError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /fictional-private/);
    return true;
  });
}

test('model checks reject invalid config before fetching and expose only typed safe errors', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Invalid config must not reach fetch'));
  await modelFailure(runtime.checkModel({ modelBaseUrl: 'fictional-private', modelId: '' }), 'model_invalid_config');
  assert.throws(() => runtime.validateConfig({ modelBaseUrl: {}, modelId: '' }), error => error instanceof runtime.ModelError && error.code === 'model_invalid_config');
});

test('model checks use a bounded redirect-free request and accept only usable model identifiers', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `${runtime.DEFAULT_CONFIG.modelBaseUrl}/models`);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ data: [{ id: 'fixture-model' }, { id: 'm'.repeat(200) }, null, { id: '' }, { id: '  ' }, { id: 'bad\nid' }, { id: 'm'.repeat(201) }] });
  });
  assert.deepEqual(await runtime.checkModel(runtime.DEFAULT_CONFIG), { models: ['fixture-model', 'm'.repeat(200)] });
});

test('model errors distinguish network failure, HTTP rejection, malformed lists, empty lists and missing selection', async t => {
  for (const [code, reply] of [
    ['model_unreachable', () => { throw new Error('fictional-private connection diagnostic'); }],
    ['model_http_error', () => new Response('fictional-private provider response', { status: 403 })],
    ['model_bad_response', () => new Response('fictional-private malformed JSON')],
    ['model_bad_response', () => Response.json({ fictional: 'fictional-private' })],
    ['model_bad_response', () => new Response(null)],
    ['model_bad_response', () => new Response(Buffer.concat([Buffer.from('{"data":[{"id":"'), Buffer.from([0xff]), Buffer.from('"}]}')]))],
    ['model_list_empty', () => Response.json({ data: [] })],
    ['model_not_found', () => Response.json({ data: [{ id: 'other-model' }] })],
  ]) {
    await t.test(code, async t => {
      t.mock.method(globalThis, 'fetch', async () => reply());
      await modelFailure(runtime.checkModel({ ...runtime.DEFAULT_CONFIG, modelId: 'selected-model' }), code);
    });
  }
});

test('model checks cancel oversized streams, bound bytes to 64 KiB, and return at most 100 models', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(32769)); },
    cancel() { cancelled = true; },
  })));
  await modelFailure(runtime.checkModel(runtime.DEFAULT_CONFIG), 'model_list_too_large');
  assert.equal(cancelled, true);
  const body = JSON.stringify({ data: [{ id: 'fixture-model' }] });
  t.mock.method(globalThis, 'fetch', async () => new Response(body.padEnd(65536)));
  assert.deepEqual(await runtime.checkModel(runtime.DEFAULT_CONFIG), { models: ['fixture-model'] });
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(32767) + '\u00e9\u00e9'.repeat(8193)));
  await modelFailure(runtime.checkModel(runtime.DEFAULT_CONFIG), 'model_list_too_large');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: Array.from({ length: 101 }, (_, i) => ({ id: `model-${i}` })) }));
  assert.equal((await runtime.checkModel(runtime.DEFAULT_CONFIG)).models.length, 100);
});

test('model check timeout and caller abort cover response streaming without exposing abort reasons', async t => {
  for (const timeout of [false, true]) {
    await t.test(timeout ? 'timeout' : 'caller abort', async t => {
      const controller = new AbortController();
      if (timeout) t.mock.method(AbortSignal, 'timeout', milliseconds => {
        assert.equal(milliseconds, 5000);
        return controller.signal;
      });
      t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"data":['));
          signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
          setImmediate(() => controller.abort(new Error('fictional-private abort reason')));
        },
      })));
      await modelFailure(runtime.checkModel(runtime.DEFAULT_CONFIG, timeout ? {} : { signal: controller.signal }),
        timeout ? 'model_timeout' : 'model_check_cancelled');
    });
  }
});

test('an already-cancelled model check never sends a request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Cancelled check must not reach fetch'));
  await modelFailure(runtime.checkModel(runtime.DEFAULT_CONFIG, { signal: AbortSignal.abort('fictional-private') }), 'model_check_cancelled');
  assert.equal(fetch.mock.callCount(), 0);
});

test('model check cancellation also interrupts a request before response headers arrive', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    setImmediate(() => controller.abort(new Error('fictional-private connection details')));
  }));
  await modelFailure(runtime.checkModel(runtime.DEFAULT_CONFIG, { signal: controller.signal }), 'model_check_cancelled');
});

test('HTTP rejection cancels its body without reading provider diagnostics', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { status: 503 }));
  await modelFailure(runtime.checkModel(runtime.DEFAULT_CONFIG), 'model_http_error');
  assert.equal(cancelled, true);
});
