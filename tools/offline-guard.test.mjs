import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTestEndpoint } from './offline-guard.mjs';

test('offline checks permit disposable loopback listeners and refuse standard model/app endpoints', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) assert.doesNotThrow(() => assertTestEndpoint(host, 50123));
  for (const host of ['api.example.invalid', '192.168.1.5', '169.254.169.254', '127.0.0.1.evil.invalid']) {
    assert.throws(() => assertTestEndpoint(host, 50123), /blocked/);
  }
  for (const port of [0, 80, 443, 8001, 11434, 1234, 4310, 5190, 65536, NaN]) {
    assert.throws(() => assertTestEndpoint('127.0.0.1', port), /blocked/);
  }
});

test('fetch is refused before an external request or existing model endpoint can be contacted', async () => {
  await assert.rejects(async () => fetch('https://example.invalid/'), /blocked/);
  await assert.rejects(async () => fetch('http://127.0.0.1:11434/v1/models'), /blocked/);
});
