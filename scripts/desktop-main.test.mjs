import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import runtime from '../apps/desktop/runtime.cjs';

const filename = fileURLToPath(new URL('../apps/desktop/main.cjs', import.meta.url));
const source = new Script(readFileSync(filename, 'utf8'), { filename });
const settle = () => new Promise(resolve => setImmediate(resolve));

async function desktop(t, { spawnFailure = false } = {}) {
  const handlers = new Map(), sessions = new Map(), timers = new Set();
  const windows = [], children = [];
  const controls = {
    loadConfig: () => ({ ...runtime.DEFAULT_CONFIG }),
    saveConfig: (_directory, value) => runtime.validateConfig(value),
    checkModel: async () => ({ models: ['fixture-model'] }),
  };
  let menu;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      const partition = options.webPreferences.partition;
      if (!sessions.has(partition)) sessions.set(partition, Object.assign(new EventEmitter(), {
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {} },
      }));
      this.webContents = Object.assign(new EventEmitter(), {
        id: windows.length + 1, session: sessions.get(partition), mainFrame: { url: '' },
        setWindowOpenHandler() {},
      });
      windows.push(this);
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    show() {}
    focus() {}
    hide() {}
    close() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    destroy() { this.close(); }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, setName() {}, setPath() {}, quit() {},
    getPath: name => `/synthetic/rivet/${name}`,
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
  });
  const modules = {
    electron: {
      app, BrowserWindow: Window,
      Menu: { buildFromTemplate: value => value, setApplicationMenu: value => { menu = value; } },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      dialog: { showErrorBox: () => assert.fail('Unexpected startup error'), showMessageBox: async () => ({ response: 0 }) },
      shell: { openPath: async () => '', openExternal: async () => {} },
    },
    'node:crypto': { randomBytes }, 'node:path': path, 'node:url': { pathToFileURL },
    'node:fs': { existsSync: () => true },
    'node:net': { createServer: () => ({
      once() {}, listen(_port, _host, callback) { callback(); },
      address: () => ({ port: 50123 }), close: callback => callback(),
    }) },
    'node:child_process': { fork: (_entry, _args, { env }) => {
      const child = Object.assign(new EventEmitter(), {
        pid: spawnFailure ? undefined : 50000 + children.length,
        exitCode: null, signalCode: null, signals: [],
        kill(signal) {
          this.signals.push(signal);
          if (!this.pid) return false;
          this.signalCode = signal;
          queueMicrotask(() => this.emit('exit', null, signal));
          return true;
        },
      });
      children.push(child);
      queueMicrotask(() => spawnFailure
        ? child.emit('error', new Error('fictional-private spawn diagnostic'))
        : child.emit('message', { type: 'rivet-ready', port: Number(env.HARNESS_PORT) }));
      return child;
    } },
    './runtime.cjs': {
      ...runtime, privateDirectory() {},
      backendEnvironment: launch => runtime.backendEnvironment(launch, { HOME: '/synthetic/account', TMPDIR: '/synthetic/tmp' }),
      ...Object.fromEntries(Object.keys(controls).map(name => [name, (...args) => controls[name](...args)])),
    },
  };
  source.runInNewContext({
    URL, __dirname: path.dirname(filename), process: { resourcesPath: '/synthetic/resources' },
    require: name => { assert.ok(Object.hasOwn(modules, name), `Unexpected module: ${name}`); return modules[name]; },
    setTimeout: (callback, milliseconds) => { const timer = { callback, milliseconds }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  t.after(async () => {
    app.emit('before-quit', { preventDefault() {} });
    await settle();
    for (const window of windows) window.destroy();
    assert.equal(timers.size, 0, 'Lifecycle timers must be cleared');
  });
  await settle();
  assert.equal(handlers.size, 4);
  const setup = () => windows.findLast(window => !window.destroyed && window.options.webPreferences.partition === 'rivet-setup');
  const invoke = (channel, value = runtime.DEFAULT_CONFIG, event) => {
    const sender = event?.sender ?? setup()?.webContents;
    return handlers.get(channel)(event ?? { sender, senderFrame: sender.mainFrame }, value);
  };
  return { controls, windows, children, sessions, timers, setup, invoke, showSettings: () => menu[0].submenu[0].click() };
}

test('main forwards typed model errors to trusted setup without forwarding arbitrary errors', async t => {
  const app = await desktop(t);
  for (const code of ['model_invalid_config', 'model_unreachable', 'model_timeout', 'model_check_cancelled',
    'model_http_error', 'model_bad_response', 'model_list_too_large', 'model_list_empty', 'model_not_found']) {
    const message = `Safe fixture explanation: ${code}`;
    app.controls.checkModel = async () => { throw new runtime.ModelError(code, message); };
    const reply = await app.invoke('rivet:check-model');
    assert.equal(reply.code, code);
    assert.equal(reply.error, message);
  }
  for (const [channel, name] of [['rivet:config', 'loadConfig'], ['rivet:check-model', 'checkModel'], ['rivet:open', 'saveConfig']]) {
    app.controls[name] = () => { throw Object.assign(new Error('fictional-private diagnostic'), { code: 'model_timeout' }); };
    const reply = await app.invoke(channel);
    assert.equal(reply.code, undefined);
    assert.equal(typeof reply.error, 'string');
    assert.doesNotMatch(reply.error, /fictional-private/);
  }
});

test('typed error forwarding remains restricted to the exact setup main frame', async t => {
  const app = await desktop(t);
  let checks = 0;
  app.controls.checkModel = async () => { checks++; throw new runtime.ModelError('model_timeout', 'Safe fixture explanation'); };
  const sender = app.setup().webContents;
  for (const event of [
    { sender, senderFrame: { url: sender.mainFrame.url } },
    { sender: { mainFrame: sender.mainFrame }, senderFrame: sender.mainFrame },
  ]) {
    const reply = await app.invoke('rivet:check-model', runtime.DEFAULT_CONFIG, event);
    assert.match(reply.error, /only available in model settings/);
    assert.equal(reply.code, undefined);
  }
  assert.equal(checks, 0);
  sender.mainFrame.url = 'https://example.invalid/untrusted';
  assert.match((await app.invoke('rivet:check-model')).error, /only available in model settings/);
  assert.equal(checks, 0);
});

test('only the current trusted workspace main frame can open model settings without writing configuration', async t => {
  const app = await desktop(t);
  const setupSender = app.setup().webContents;
  assert.equal((await app.invoke('rivet:open')).ok, true);
  const workspace = app.windows.findLast(window => window.options.webPreferences.partition === 'persist:rivet-alpha');
  const sender = workspace.webContents;
  assert.equal(path.basename(workspace.options.webPreferences.preload), 'workspace-preload.cjs');
  assert.equal(workspace.options.webPreferences.nodeIntegration, false);
  assert.equal(workspace.options.webPreferences.contextIsolation, true);
  app.controls.saveConfig = () => assert.fail('Opening settings must not change configuration');
  for (const event of [
    {sender:setupSender,senderFrame:setupSender.mainFrame},
    {sender,senderFrame:{url:sender.mainFrame.url}},
    {sender:{mainFrame:sender.mainFrame},senderFrame:sender.mainFrame},
    {sender},
  ]) assert.match((await app.invoke('rivet:show-model-settings', undefined, event)).error, /desktop workspace/);
  assert.equal(app.setup(), undefined);
  const trustedURL = sender.mainFrame.url;
  for (const url of ['https://example.invalid', 'http://127.0.0.1:1/', 'file:///local.html']) {
    sender.mainFrame.url = url;
    assert.match((await app.invoke('rivet:show-model-settings', undefined, {sender,senderFrame:sender.mainFrame})).error, /desktop workspace/);
  }
  sender.mainFrame.url = trustedURL;
  assert.equal((await app.invoke('rivet:show-model-settings', undefined, {sender,senderFrame:sender.mainFrame})).ok, true);
  assert.ok(app.setup());
  assert.equal(app.children.length, 1);
  assert.equal(app.children[0].signals.length, 0, 'Opening settings must not interrupt the current backend');
  workspace.close();
  assert.match((await app.invoke('rivet:show-model-settings', undefined, {sender,senderFrame:sender.mainFrame})).error, /desktop workspace/);
});

test('workspace preload exposes one argument-free settings action and no generic IPC or configuration access', async () => {
  const calls = [];
  let bridge;
  const code = readFileSync(new URL('../apps/desktop/workspace-preload.cjs', import.meta.url), 'utf8');
  new Script(code).runInNewContext({require: name => {
    assert.equal(name, 'electron');
    return {contextBridge:{exposeInMainWorld:(name, value)=>{assert.equal(name,'rivetDesktop');bridge=value;}},
      ipcRenderer:{invoke:(...args)=>{calls.push(args);return Promise.resolve({ok:true});}}};
  }});
  assert.deepEqual(Object.keys(bridge), ['openModelSettings']);
  assert.equal(Object.isFrozen(bridge), true);
  assert.equal((await bridge.openModelSettings('ignored-untrusted-input')).ok, true);
  assert.deepEqual(calls, [['rivet:show-model-settings']]);
});

test('workspace replacement and close remove only their own persistent-session download listeners', async t => {
  const app = await desktop(t);
  assert.equal((await app.invoke('rivet:open')).ok, true);
  const first = app.windows.find(window => window.options.webPreferences.partition === 'persist:rivet-alpha');
  const session = first.webContents.session;
  const firstDownload = session.listeners('will-download')[0];
  assert.equal(session.listenerCount('will-download'), 1);
  const unrelated = () => {};
  session.on('will-download', unrelated);
  app.showSettings();
  assert.equal((await app.invoke('rivet:open')).ok, true);
  const second = app.windows.findLast(window => window.options.webPreferences.partition === 'persist:rivet-alpha');
  assert.equal(first.destroyed, true);
  assert.equal(second.webContents.session, session);
  assert.equal(session.listenerCount('will-download'), 2);
  assert.equal(session.listeners('will-download').includes(firstDownload), false);
  assert.equal(session.listeners('will-download').includes(unrelated), true);
  const options = [];
  session.emit('will-download', {}, { getFilename: () => '../report.csv', setSaveDialogOptions: value => options.push(value) });
  assert.equal(options.length, 1);
  assert.equal(options[0].defaultPath, '/synthetic/rivet/downloads/report.csv');
  second.close();
  assert.equal(session.listenerCount('will-download'), 1);
  assert.equal(session.listeners('will-download')[0], unrelated);
  assert.deepEqual(app.children[0].signals, ['SIGTERM']);
});

test('a failed spawn without a PID returns a safe setup error without waiting for an exit event', async t => {
  const app = await desktop(t, { spawnFailure: true });
  let reply;
  const opening = app.invoke('rivet:open').then(value => { reply = value; });
  await settle();
  assert.ok(reply, 'Failed startup must settle without an exit event');
  assert.match(reply.error, /could not start/);
  assert.doesNotMatch(reply.error, /fictional-private/);
  assert.equal(app.setup().destroyed, false);
  assert.equal(app.children.length, 1);
  assert.deepEqual(app.children[0].signals, []);
  assert.equal(app.children[0].listenerCount('exit'), 0);
  assert.equal(app.timers.size, 0);
  await opening;
});
