import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopAccessFromEnv } from './desktop-access.ts';
import { createApiServer, type HarnessApi } from './http.ts';
import type { Run } from '../../../packages/core/src/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const token = 'ab'.repeat(32);
type Headers = Record<string, string | string[] | undefined>;
const desktopEnv = (port: number): NodeJS.ProcessEnv => ({ HARNESS_DESKTOP: '1', HARNESS_DESKTOP_TOKEN: token,
  HARNESS_PORT: String(port), HARNESS_APP_ORIGIN: `http://127.0.0.1:${port}` });

async function reservePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return { port: address.port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function send(port: number, pathname = '/', headers: Headers = {}, method = 'GET', payload?: string) {
  return new Promise<{ status: number; body: string; headers: NodeJS.Dict<string | string[]> }>((resolve, reject) => {
    const rawHeaders = Object.entries({ host: `127.0.0.1:${port}`, ...headers })
      .flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).flatMap(item => [name, item]));
    const req = request({ hostname: '127.0.0.1', port, path: pathname, method, headers: rawHeaders, agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, body, headers: response.headers }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error('Desktop HTTP test timed out.')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function fixture(t: TestContext, desktop = true) {
  const webDir = await mkdtemp(path.join(tmpdir(), 'desktop-http-'));
  t.after(() => rm(webDir, { recursive: true, force: true }));
  await writeFile(path.join(webDir, 'index.html'), '<html><body>Desktop workspace</body></html>');
  await writeFile(path.join(webDir, 'app.js'), 'document.title = "Desktop workspace";');
  let starts = 0, externalCalls = 0;
  const run: Run = { id: 'desktop-run', requestId: 'desktop-request-0001', task: 'Read notes', status: 'queued',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), model: 'test', profileId: 'workspace-analyst',
    workflowId: null, workflowVersion: null, limits: { maxSteps: 8, timeoutMs: 90_000 },
    usage: { inputTokens: null, outputTokens: null }, error: null, result: null, events: [] };
  const api = {
    workspace: async () => ({sources:[],provider:{configured:false,available:false,model:null,label:'Local model not selected',kind:'openai-compatible',message:'Choose a model'}}),
    listRuns: () => [],
    startRun: async (input: { task: string; requestId: string }) => { starts++; return { ...run, ...input }; },
    connectionSettings: () => ({ runtimeEnabled: true, providers: [] }),
    listConnections: () => { externalCalls++; return []; },
    testScheduleEmail: async () => { externalCalls++; throw new Error('Email must stay disabled.'); },
  } as unknown as HarnessApi;
  const reserved = await reservePort();
  const port = reserved.port;
  await reserved.close();
  const server = createApiServer(api, { port, webDir, desktop: desktop ? desktopAccessFromEnv(desktopEnv(port)) : undefined,
    reportEmailPublic: async (_request, response) => { externalCalls++; response.end('public'); return true; },
    testBilling: { handle: async () => { externalCalls++; return false; } },
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return { port, origin: `http://127.0.0.1:${port}`, starts: () => starts, externalCalls: () => externalCalls,
    send: (pathname = '/', headers: Headers = {}, method = 'GET', payload?: string) =>
      send(port, pathname, { 'x-rivet-desktop-token': token, ...headers }, method, payload) };
}

test('desktop startup settings require a token, an unprivileged port and the exact IPv4 loopback origin', () => {
  assert.equal(desktopAccessFromEnv({}), undefined);
  assert.equal(desktopAccessFromEnv({ HARNESS_DESKTOP: '0', HARNESS_DESKTOP_TOKEN: 'invalid' }), undefined);
  for (const value of [undefined, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ' '.repeat(64)]) {
    assert.throws(() => desktopAccessFromEnv({ ...desktopEnv(4310), HARNESS_DESKTOP_TOKEN: value }), /HARNESS_DESKTOP_TOKEN/);
  }
  for (const value of [undefined, '', '0', '1023', '65536', '4310.5', '1e4', ' 4310']) {
    assert.throws(() => desktopAccessFromEnv({ ...desktopEnv(4310), HARNESS_PORT: value }), /HARNESS_PORT/);
  }
  for (const value of [undefined, '', 'http://localhost:4310', 'http://127.0.0.2:4310', 'http://127.1:4310',
    'http://127.0.0.1:4311', 'http://127.0.0.1:5190', 'https://127.0.0.1:4310', 'http://127.0.0.1:4310/',
    'http://user@127.0.0.1:4310', 'http://evil.test:4310']) {
    assert.throws(() => desktopAccessFromEnv({ ...desktopEnv(4310), HARNESS_APP_ORIGIN: value }), /HARNESS_APP_ORIGIN/);
  }
  assert.deepEqual(desktopAccessFromEnv(desktopEnv(4310)), { token, port: 4310, origin: 'http://127.0.0.1:4310' });
});

test('every desktop HTTP route requires the launch token, including static files and public callbacks', async t => {
  const f = await fixture(t);
  for (const pathname of ['/', '/app.js', '/api/runs', '/api/connections', '/api/connections/google-drive', '/api/connections/google-drive/callback',
    '/api/connections/meta/callback', '/connections/local-start', '/connections/meta/callback',
    '/email/events/resend', '/email/unsubscribe/' + 'a'.repeat(64), '/api/admin/organizations', '/billing-test']) {
    for (const value of [undefined, '', 'cd'.repeat(32), 'a'.repeat(63), token + 'a', token.toUpperCase(), [token, token]]) {
      const result = await f.send(pathname, { 'x-rivet-desktop-token': value });
      assert.equal(result.status, 403, pathname);
      assert.equal(JSON.parse(result.body).error.code, 'desktop_token_denied');
      assert.equal(result.body.includes(token), false);
      assert.equal(result.headers['cache-control'], 'no-store');
    }
  }
  for (const method of ['POST', 'HEAD', 'OPTIONS']) {
    assert.equal((await f.send('/api/runs', { 'x-rivet-desktop-token': undefined }, method)).status, 403);
  }
  assert.equal(f.starts(), 0);
  assert.equal(f.externalCalls(), 0);
});

test('desktop rejects hostile hosts, origins, development origins and cross-site navigations without exemptions', async t => {
  const f = await fixture(t);
  for (const host of [`localhost:${f.port}`, `127.0.0.2:${f.port}`, `127.1:${f.port}`, `evil.test:${f.port}`,
    '127.0.0.1', '127.0.0.1:1', `127.0.0.1:${f.port}.evil.test`, [`127.0.0.1:${f.port}`, 'evil.test']]) {
    assert.equal((await f.send('/', { host })).status, 403, String(host));
  }
  for (const origin of ['null', 'https://evil.test', `http://localhost:${f.port}`, 'http://127.0.0.1:5190',
    'http://localhost:5190', 'http://127.0.0.1:4320', 'http://localhost:4320', `${f.origin}/`, [f.origin, f.origin]]) {
    assert.equal((await f.send('/api/runs', { origin })).status, 403, String(origin));
  }
  for (const pathname of ['/', '/app.js', '/api/runs', '/api/connections', '/api/connections/google-drive', '/api/connections/google-drive/callback',
    '/api/connections/meta/callback', '/connections/local-start', '/email/events/resend']) {
    for (const site of ['cross-site', 'same-site']) {
      for (const origin of [undefined, f.origin]) {
        assert.equal((await f.send(pathname, { origin, 'sec-fetch-site': site,
          'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status, 403, pathname);
      }
    }
  }
  assert.equal(f.externalCalls(), 0);
});

test('valid desktop main frames, assets and API reads/writes work without exposing the token', async t => {
  const f = await fixture(t);
  const main = await f.send('/', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  assert.equal(main.status, 200);
  assert.match(main.body, /Desktop workspace/);
  assert.equal(main.body.includes(token), false);
  assert.equal((await f.send('/app.js', { 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await f.send('/', {}, 'HEAD')).status, 200);
  assert.equal((await f.send('/api/runs')).status, 200);
  const created = await f.send('/api/runs', { origin: f.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    'POST', JSON.stringify({ task: 'Read notes', requestId: 'desktop-request-0001' }));
  assert.equal(created.status, 202);
  assert.equal(f.starts(), 1);
  assert.equal(f.externalCalls(), 0);
});

test('desktop capability is explicit while model details remain private and ordinary local responses are unchanged', async t => {
  const desktop = await fixture(t);
  const response = await desktop.send('/api/workspace');
  assert.equal(response.status, 200);
  const workspace = JSON.parse(response.body);
  assert.equal(workspace.desktop, true);
  assert.equal(workspace.provider.configured, false);
  assert.equal(workspace.provider.model, null);
  assert.equal(workspace.provider.label, 'Rivet');
  assert.equal((await desktop.send('/api/workspace', {'x-rivet-desktop-token':undefined})).status, 403);
  const local = await fixture(t, false);
  assert.equal(Object.hasOwn(JSON.parse((await local.send('/api/workspace')).body), 'desktop'), false);
});

test('desktop connector, OAuth, organization and email routes stay disabled even behind a valid token', async t => {
  const f = await fixture(t);
  const connections = await f.send('/api/connections');
  assert.equal(connections.status, 200);
  assert.deepEqual(JSON.parse(connections.body), { runtimeEnabled: false, unavailableReason: 'desktop', providers: [], connections: [] });
  const drive = await f.send('/api/connections/google-drive');
  assert.equal(drive.status, 200);
  assert.equal(JSON.parse(drive.body).configured, false);
  assert.equal(JSON.parse(drive.body).status, 'disconnected');
  assert.equal(JSON.parse(drive.body).pickerConfigured, false);
  assert.equal((await f.send('/api/connections', {}, 'POST')).status, 404);
  assert.equal((await f.send('/api/connections/google-drive', {}, 'POST')).status, 404);
  for (const pathname of ['/api/connections/google-drive/authorize', '/api/connections/meta/callback',
    '/connections/meta/callback', '/connections/local-start', '/api/admin/organizations', '/api/signup/session',
    '/api/team/sources', '/api/organization-session', '/admin', '/join', '/onboarding', '/w/example/api/runs',
    '/email/events/resend', '/api/schedules/example/email', '/api/schedules/example/email/test', '/api/datasets/social/apify',
    '/billing-test', '/api/billing-test']) {
    for (const method of ['GET', 'POST']) assert.equal((await f.send(pathname, {}, method)).status, 404, pathname);
  }
  assert.equal(f.externalCalls(), 0);
});

test('ordinary local HTTP still permits localhost and its development origins without a desktop token', async t => {
  const f = await fixture(t, false);
  assert.equal((await send(f.port, '/', { host: `localhost:${f.port}` })).status, 200);
  assert.equal((await send(f.port, '/api/runs', { origin: 'http://127.0.0.1:5190' })).status, 200);
  assert.equal((await send(f.port, '/api/runs', { origin: 'http://localhost:4320' })).status, 200);
});

async function backend(t: TestContext, options: { port?: number; env?: NodeJS.ProcessEnv; work?: string; disconnectImmediately?: boolean } = {}) {
  const work = options.work ?? await mkdtemp(path.join(tmpdir(), 'desktop-backend-'));
  if (!options.work) t.after(() => rm(work, { recursive: true, force: true }));
  await mkdir(path.join(work, 'dist/web'), { recursive: true });
  await mkdir(path.join(work, 'sources'), { recursive: true });
  await writeFile(path.join(work, 'dist/web/index.html'), '<html><body>Desktop backend</body></html>');
  // An inherited development .env must never refill the parent's sanitized environment.
  await writeFile(path.join(work, '.env'), 'HARNESS_TABULAR_SNAPSHOT_LIMIT=0\nHARNESS_PROFILE=invalid\n');
  const reserved = options.port === undefined ? await reservePort() : undefined;
  const port = options.port ?? reserved!.port;
  await reserved?.close();
  const child = fork(path.join(root, 'apps/server/src/index.ts'), [], {
    execPath: process.execPath, execArgv: ['--import', import.meta.resolve('tsx')], cwd: work,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, HOME: work, HARNESS_PROFILE: 'workspace-analyst',
      HARNESS_DATA_DIR: path.join(work, 'data'), HARNESS_SOURCE_DIR: path.join(work, 'sources'),
      HARNESS_MODEL_BASE_URL: 'http://127.0.0.1:1/v1', ...desktopEnv(port), ...options.env },
  });
  const exited = once(child, 'exit');
  const messages: unknown[] = [];
  let output = '';
  child.stdout!.on('data', chunk => { output = (output + chunk).slice(-16_384); });
  child.stderr!.on('data', chunk => { output = (output + chunk).slice(-16_384); });
  child.on('message', message => { messages.push(message); });
  const ready = Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(() => { throw new Error(`Desktop backend exited before readiness: ${output}`); }),
  ]);
  // Failure tests inspect exit and messages instead of awaiting readiness.
  void ready.catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    child.stdout!.destroy();
    child.stderr!.destroy();
  });
  if (options.disconnectImmediately) child.disconnect();
  return { child, exited, ready, messages, port, work, output: () => output };
}

test('desktop entry fails startup for absent or invalid tokens without readiness or secret output', { timeout: 30_000 }, async t => {
  for (const value of [undefined, '', 'not-a-valid-desktop-token', 'cd'.repeat(31)]) {
    const f = await backend(t, { env: { HARNESS_DESKTOP_TOKEN: value } });
    assert.equal((await f.exited)[0], 1);
    assert.deepEqual(f.messages, []);
    assert.match(f.output(), /HARNESS_DESKTOP_TOKEN must be/);
    if (value) assert.equal(f.output().includes(value), false);
    assert.doesNotMatch(f.output(), /harness API:/);
  }
});

test('desktop entry requests JSON-object syntax while preserving its provider limits', { timeout: 20_000 }, async t => {
  let payload: Record<string, unknown> | undefined;
  const model = createServer((req, response) => {
    if (req.url === '/v1/models') { response.end(JSON.stringify({data:[{id:'fixture-json-model'}]})); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      payload = JSON.parse(body);
      response.setHeader('Content-Type','text/event-stream');
      const delta = {choices:[{index:0,delta:{content:JSON.stringify({type:'reply',content:'Ready.'})},finish_reason:null}]};
      const finish = {choices:[{index:0,delta:{},finish_reason:'stop'}]};
      response.end(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => model.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));});
  const address = model.address(); assert(address && typeof address === 'object');
  const f = await backend(t,{env:{HARNESS_MODEL_BASE_URL:`http://127.0.0.1:${address.port}/v1`,HARNESS_MODEL_ID:'fixture-json-model'}});
  await f.ready;
  const headers = {'x-rivet-desktop-token':token,origin:`http://127.0.0.1:${f.port}`,'content-type':'application/json'};
  const started = await send(f.port,'/api/runs',headers,'POST',JSON.stringify({task:'Hello',sourceIds:[],requestId:'desktop-json-mode-0001'}));
  assert.equal(started.status,202);
  const id = JSON.parse(started.body).id;
  let run: Run | undefined;
  for(let i=0;i<100;i++){
    run = JSON.parse((await send(f.port,`/api/runs/${id}`,headers)).body);
    if(run && !['queued','running'].includes(run.status))break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(run?.status,'completed',run?.error??'');
  assert.equal(run?.reply?.content,'Ready.');
  assert.deepEqual(payload?.response_format,{type:'json_object'});
  assert.equal(payload?.reasoning_effort,'none');
  assert.equal(payload?.max_tokens,600);
  f.child.kill('SIGTERM');assert.equal((await f.exited)[0],0,f.output());
});

test('forked desktop listens before readiness, ignores unsafe feature flags and closes on parent disconnect', { timeout: 30_000 }, async t => {
  const f = await backend(t, { env: { HARNESS_CONNECTIONS_ENABLED: '1', HARNESS_CONNECTOR_INSTAGRAM: '1',
    HARNESS_CONNECTOR_FACEBOOK: '1', HARNESS_CONNECTOR_YOUTUBE: '1', HARNESS_CONNECTOR_LINKEDIN: '1',
    HARNESS_CONNECTOR_MAILCHIMP: '1', HARNESS_CONNECTOR_GA4: '1', HARNESS_CONNECTOR_WINDSOR_LINKEDIN: '1',
    HARNESS_ORG_ADMIN: '1', HARNESS_REPORT_EMAIL_MODE: 'resend' } });
  assert.deepEqual(await f.ready, { type: 'rivet-ready', port: f.port });
  assert.equal((await send(f.port)).status, 403);
  assert.equal((await send(f.port, '/', { 'x-rivet-desktop-token': token })).status, 200);
  assert.equal((await send(f.port, '/api/runs', { 'x-rivet-desktop-token': token })).status, 200);
  const connections = await send(f.port, '/api/connections', { 'x-rivet-desktop-token': token });
  assert.equal(connections.status, 200);
  assert.deepEqual(JSON.parse(connections.body), { runtimeEnabled: false, unavailableReason: 'desktop', providers: [], connections: [] });
  const drive = await send(f.port, '/api/connections/google-drive', { 'x-rivet-desktop-token': token });
  assert.equal(drive.status, 200);
  assert.equal(JSON.parse(drive.body).configured, false);
  const session = await send(f.port, '/api/session', { 'x-rivet-desktop-token': token });
  assert.equal(session.status, 200);
  assert.deepEqual(JSON.parse(session.body), { mode: 'local' });
  for (const pathname of ['/api/connections/google-drive/status', '/api/organization-session', '/api/schedules/example/email']) {
    assert.equal((await send(f.port, pathname, { 'x-rivet-desktop-token': token })).status, 404, pathname);
  }
  // A client that leaves a partial request open must not hold the orphaned backend alive.
  const socket = connect(f.port, '127.0.0.1');
  socket.on('error', (error: NodeJS.ErrnoException) => assert.equal(error.code, 'ECONNRESET'));
  const socketClosed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('GET / HTTP/1.1\r\n');
  f.child.disconnect();
  assert.equal((await f.exited)[0], 0, f.output());
  await socketClosed;
  assert.deepEqual(f.messages, [{ type: 'rivet-ready', port: f.port }]);
  assert.equal(f.output().includes(token), false);
  await assert.rejects(send(f.port));
  await assert.rejects(access(path.join(f.work, 'data/runtime.lock')), { code: 'ENOENT' });
  // Reopen the same storage after proving graceful shutdown removed its exclusive lock.
  const reopened = await backend(t, { work: f.work });
  assert.deepEqual(await reopened.ready, { type: 'rivet-ready', port: reopened.port });
  reopened.child.kill('SIGTERM');
  assert.equal((await reopened.exited)[0], 0, reopened.output());
});

test('desktop parent disconnect before runtime startup never emits readiness or leaves a listener', { timeout: 20_000 }, async t => {
  const f = await backend(t, { disconnectImmediately: true });
  assert.equal((await f.exited)[0], 0, f.output());
  assert.deepEqual(f.messages, []);
  await assert.rejects(access(path.join(f.work, 'data/runtime.lock')), { code: 'ENOENT' });
  await assert.rejects(send(f.port));
});

test('desktop bind failure exits nonzero, emits no readiness and releases its runtime', { timeout: 20_000 }, async t => {
  const occupied = await reservePort();
  t.after(occupied.close);
  const f = await backend(t, { port: occupied.port });
  assert.equal((await f.exited)[0], 1, f.output());
  assert.deepEqual(f.messages, []);
  assert.match(f.output(), /EADDRINUSE/);
  assert.equal(f.output().includes(token), false);
  await assert.rejects(access(path.join(f.work, 'data/runtime.lock')), { code: 'ENOENT' });
  const reopened = await backend(t, { work: f.work });
  await reopened.ready;
  reopened.child.kill('SIGINT');
  assert.equal((await reopened.exited)[0], 0, reopened.output());
});
