import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';

const source = new Script(readFileSync(new URL('../apps/desktop/setup.js', import.meta.url), 'utf8'));
const modelBaseUrl = 'http://127.0.0.1:11434/v1';
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element {
  value = '';
  disabled = true;
  textContent = '';
  className = '';
  validationMessage = '';
  options = [];
  listeners = new Map();
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage; }
  async emit(name) {
    await this.listeners.get(name)?.({ preventDefault() {} });
    await settle();
  }
}

async function setup(overrides = {}) {
  const elements = Object.fromEntries(['model-form', 'address', 'model', 'status', 'check', 'open', 'browse']
    .map(id => [id, new Element()]));
  elements.address.value = modelBaseUrl;
  const calls = { check: [], open: [] };
  const api = {
    config: async () => ({ modelBaseUrl, modelId: '' }),
    checkModel: async () => ({ models: ['local-a', 'local-b'] }),
    open: async () => ({ ok: true }),
    ...overrides,
  };
  source.runInNewContext({
    URL,
    document: {
      querySelector: selector => {
        const element = elements[selector.slice(1)];
        assert.ok(element, `Unexpected element: ${selector}`);
        return element;
      },
      createElement: name => {
        assert.equal(name, 'option');
        return new Element();
      },
    },
    window: { rivetSetup: {
      config: () => api.config(),
      checkModel: value => { calls.check.push({ ...value }); return api.checkModel(value); },
      open: value => { calls.open.push({ ...value }); return api.open(value); },
    } },
  });
  await settle();
  return {
    ...elements, calls, api,
    choose: async id => { elements.model.value = id; await elements.model.emit('change'); },
    submit: () => elements['model-form'].emit('submit'),
    options: () => elements.model.options.map(option => option.value),
  };
}

test('first run lists models without inference and opens only after a choice', async () => {
  const page = await setup();
  assert.deepEqual(page.calls.check, [{ modelBaseUrl, modelId: '' }]);
  assert.deepEqual(page.options(), ['', 'local-a', 'local-b']);
  assert.equal(page.open.disabled, true);
  assert.equal(page.browse.disabled, false);
  assert.match(page.status.textContent, /has not been tested/);
  await page.submit();
  assert.deepEqual(page.calls.open, []);
  await page.choose('local-b');
  assert.equal(page.open.disabled, false);
  await page.submit();
  await page.submit();
  assert.deepEqual(page.calls.open, [{ modelBaseUrl, modelId: 'local-b' }]);
  assert.equal(page.open.disabled, true);
});

test('a saved model is restored only when still listed', async () => {
  const page = await setup({ config: async () => ({ modelBaseUrl, modelId: 'local-b' }) });
  assert.equal(page.model.value, 'local-b');
  assert.equal(page.open.disabled, false);
  assert.equal(page.calls.check[0].modelId, '');
});

test('a removed saved model does not prevent discovery or choose a replacement silently', async () => {
  const page = await setup({ config: async () => ({ modelBaseUrl, modelId: 'removed-model' }) });
  assert.deepEqual(page.options(), ['', 'local-a', 'local-b']);
  assert.equal(page.model.value, '');
  assert.equal(page.open.disabled, true);
  assert.match(page.status.textContent, /no longer listed/);
  await page.choose('local-a');
  await page.submit();
  assert.equal(page.calls.open[0].modelId, 'local-a');
});

for (const [name, checkModel] of [
  ['unreachable server', async () => ({ error: 'Internal network details must not be rendered.' })],
  ['rejected check', async () => { throw new Error('Private process details'); }],
  ['malformed response', async () => ({ models: null })],
  ['missing response', async () => undefined],
  ['empty list', async () => ({ models: [] })],
]) test(`${name} leaves model-free browsing and retry available`, async () => {
  const page = await setup({ checkModel });
  assert.equal(page.model.disabled, true);
  assert.equal(page.open.disabled, true);
  assert.equal(page.check.disabled, false);
  assert.equal(page.browse.disabled, false);
  assert.equal(page.status.className, 'error');
  assert.doesNotMatch(page.status.textContent, /Private|Internal/);
  await page.browse.emit('click');
  assert.deepEqual(page.calls.open, [{ modelBaseUrl, modelId: '' }]);
});

test('failed refresh clears stale options and a retry restores the chosen model', async () => {
  const page = await setup();
  await page.choose('local-b');
  page.api.checkModel = async () => { throw new Error('Network unavailable'); };
  await page.check.emit('click');
  assert.deepEqual(page.options(), ['']);
  assert.equal(page.model.value, '');
  assert.equal(page.open.disabled, true);
  assert.equal(page.address.value, modelBaseUrl);
  page.api.checkModel = async () => ({ models: ['local-b'] });
  await page.check.emit('click');
  assert.equal(page.model.value, 'local-b');
  assert.equal(page.open.disabled, false);
});

for (const [code, message] of [
  ['model_invalid_config', /local server address/],
  ['model_unreachable', /Start it/],
  ['model_http_error', /refused the request/],
  ['model_bad_response', /usable model list/],
  ['model_list_empty', /No installed models/],
  ['model_list_too_large', /too large/],
  ['model_not_found', /no longer available/],
  ['model_timeout', /too long/],
  ['model_check_cancelled', /cancelled/],
  ['unrecognized', /Could not list models/],
  ['toString', /Could not list models/],
]) test(`typed model error ${code} provides safe recovery guidance`, async () => {
  const page = await setup({ checkModel: async () => ({ code, error: 'Private provider details' }) });
  assert.match(page.status.textContent, message);
  assert.doesNotMatch(page.status.textContent, /Private/);
  assert.equal(page.open.disabled, true);
  assert.equal(page.check.disabled, false);
  assert.equal(page.browse.disabled, false);
});

test('editing the address invalidates the list until the new server is checked', async () => {
  const page = await setup();
  await page.choose('local-a');
  page.address.value = 'http://localhost:9000/v1/';
  await page.address.emit('input');
  assert.deepEqual(page.options(), ['']);
  assert.equal(page.open.disabled, true);
  await page.submit();
  assert.deepEqual(page.calls.open, []);
  page.api.checkModel = async () => ({ models: ['another-model'] });
  await page.check.emit('click');
  assert.deepEqual(page.calls.check.at(-1), { modelBaseUrl: 'http://localhost:9000/v1', modelId: '' });
  assert.equal(page.model.value, '');
  assert.equal(page.open.disabled, true);
});

test('invalid and remote addresses never reach the bridge and do not block model-free browsing', async () => {
  for (const value of ['', 'not a URL', 'https://api.example.test/v1', 'http://192.168.0.2/v1',
    'http://user:secret@localhost/v1', 'http://localhost/v1?key=secret', 'http://localhost/admin']) {
    const page = await setup();
    const checks = page.calls.check.length;
    page.address.value = value;
    await page.address.emit('input');
    await page.check.emit('click');
    assert.equal(page.calls.check.length, checks);
    assert.match(page.address.validationMessage, /local server/);
    await page.browse.emit('click');
    assert.deepEqual(page.calls.open, [{ modelBaseUrl, modelId: '' }]);
    assert.equal(page.address.value, value);
  }
});

for (const [name, config] of [
  ['rejected settings', async () => { throw new Error('Private settings path'); }],
  ['settings error', async () => ({ error: 'Private settings path' })],
  ['invalid settings', async () => ({ modelId: '' })],
]) test(`${name} permits manual retry and browsing with defaults`, async () => {
  const page = await setup({ config });
  assert.match(page.status.textContent, /Could not read saved/);
  assert.doesNotMatch(page.status.textContent, /Private/);
  assert.equal(page.calls.check.length, 0);
  assert.equal(page.address.disabled, false);
  assert.equal(page.browse.disabled, false);
  await page.check.emit('click');
  assert.deepEqual(page.options(), ['', 'local-a', 'local-b']);
  await page.browse.emit('click');
  assert.deepEqual(page.calls.open, [{ modelBaseUrl, modelId: '' }]);
});

for (const [name, open] of [
  ['rejected launch', async () => { throw new Error('Private launch details'); }],
  ['launch error', async () => ({ error: 'Private launch details' })],
  ['missing launch response', async () => undefined],
]) test(`${name} preserves choices for retry`, async () => {
  const page = await setup({ open });
  await page.choose('local-b');
  await page.submit();
  assert.equal(page.model.value, 'local-b');
  assert.equal(page.address.value, modelBaseUrl);
  assert.equal(page.open.disabled, false);
  assert.equal(page.browse.disabled, false);
  assert.match(page.status.textContent, /could not open/);
  assert.doesNotMatch(page.status.textContent, /Private/);
  page.api.open = async () => ({ ok: true });
  await page.submit();
  assert.deepEqual(page.calls.open, Array(2).fill({ modelBaseUrl, modelId: 'local-b' }));
});

for (const rejected of [false, true]) test(`browsing ignores a late ${rejected ? 'rejected' : 'successful'} model check`, async () => {
  const pending = Promise.withResolvers();
  const page = await setup({ checkModel: () => pending.promise });
  assert.equal(page.check.disabled, true);
  assert.equal(page.browse.disabled, false);
  await page.browse.emit('click');
  if (rejected) pending.reject(new Error('Late private failure'));
  else pending.resolve({ models: ['late-model'] });
  await settle();
  assert.deepEqual(page.calls.open, [{ modelBaseUrl, modelId: '' }]);
  assert.match(page.status.textContent, /Opening your workspace/);
  assert.deepEqual(page.options(), ['']);
  assert.equal(page.open.disabled, true);
  assert.equal(page.browse.disabled, true);
});

test('a failed model-free launch remains retryable after a late check', async () => {
  const pending = Promise.withResolvers();
  const page = await setup({ checkModel: () => pending.promise, open: async () => ({ error: 'Launch failed' }) });
  await page.browse.emit('click');
  pending.resolve({ models: ['late-model'] });
  await settle();
  assert.match(page.status.textContent, /could not open/);
  assert.equal(page.check.disabled, false);
  assert.equal(page.browse.disabled, false);
  page.api.checkModel = async () => ({ models: ['local-a'] });
  await page.check.emit('click');
  assert.deepEqual(page.options(), ['', 'local-a']);
});

test('model IDs are rendered as option text and unusable entries are ignored', async () => {
  const literal = '<img src=x onerror=alert(1)>';
  const longest = 'x'.repeat(200);
  const page = await setup({ checkModel: async () => ({ models: [null, 42, '', ' ', '\n', 'x'.repeat(201), literal, 'local-a', 'local-a', longest] }) });
  assert.deepEqual(page.options(), ['', literal, 'local-a', longest]);
  assert.equal(page.model.options[1].textContent, literal);
});
