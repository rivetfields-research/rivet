import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const providerPorts = new Set([80, 443, 4310, 5190, 8000, 8001, 11434, 1234]);
export function assertTestEndpoint(hostname, port) {
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)
    || !Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535
    || providerPorts.has(Number(port))) throw new Error('Check runner blocked a non-fixture network endpoint.');
}
function validateRequest(args, protocol) {
  const first = args[0];
  const url = typeof first === 'string' || first instanceof URL ? new URL(first) : undefined;
  const options = url ? (typeof args[1] === 'object' ? args[1] : {}) : first;
  if (options?.socketPath) throw new Error('Check runner blocked a Unix socket.');
  assertTestEndpoint(options?.hostname ?? options?.host ?? url?.hostname ?? 'localhost',
    options?.port ?? url?.port ?? (protocol === 'https:' ? 443 : 80));
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, options) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assertTestEndpoint(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
  // Redirects must not turn a synthetic loopback request into an external call.
  return originalFetch(input, { ...options, redirect: 'error' });
};
for (const [module, protocol] of [[http, 'http:'], [https, 'https:']]) {
  const request = module.request;
  module.request = function (...args) { validateRequest(args, protocol); return request.apply(this, args); };
  module.get = function (...args) { const req = module.request(...args); req.end(); return req; };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' ? first : { port: first, host: args[1] };
  if (options.path) throw new Error('Check runner blocked a Unix socket.');
  assertTestEndpoint(options.host ?? options.hostname ?? 'localhost', options.port);
  return connect.apply(this, args);
};
const fork = childProcess.fork;
childProcess.fork = function (modulePath, args = [], options = {}) {
  return fork.call(this, modulePath, args, { ...options,
    execArgv: ['--import', import.meta.url, ...(options.execArgv ?? process.execArgv)] });
};
syncBuiltinESMExports();
