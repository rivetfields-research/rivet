const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync } = require('node:fs');
const { privateDirectory, loadConfig, saveConfig, backendEnvironment, internalUrl, externalUrl, checkModel, ModelError } = require('./runtime.cjs');

app.setName('Rivet Alpha');
app.setPath('userData', path.join(app.getPath('appData'), 'Rivet Alpha'));
const directory = app.getPath('userData');
const setupUrl = pathToFileURL(path.join(__dirname, 'setup.html')).href;
let setupWindow, workspaceWindow, backend, origin, token;
let stopping = false;
let restarting = false;
let opening = false;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const window = setupWindow || workspaceWindow; window?.show(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!backend || stopping) return;
    event.preventDefault();
    stopping = true;
    void stopBackend().finally(() => app.quit());
  });
  app.whenReady().then(initialize).catch(() => {
    dialog.showErrorBox('Rivet could not start', 'The local app could not start. Your saved workspace has not been removed.');
    app.quit();
  });
}

async function initialize() {
  privateDirectory(directory);
  privateDirectory(path.join(directory, 'workspace'));
  privateDirectory(path.join(directory, 'sources'));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Rivet Alpha', submenu: [
      { label: 'Model settings...', accelerator: 'CmdOrCtrl+,', click: showSetup },
      { label: 'Open local data folder', click: () => void shell.openPath(directory) },
      { type: 'separator' }, { role: 'quit' },
    ] }, { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' },
  ]));
  ipcMain.handle('rivet:show-model-settings', event => {
    if (!workspaceWindow || event.sender !== workspaceWindow.webContents ||
        event.senderFrame !== workspaceWindow.webContents.mainFrame || !internalUrl(event.senderFrame?.url, origin)) {
      return { error: 'Open model settings from the desktop workspace.' };
    }
    showSetup();
    return { ok: true };
  });
  for (const [channel, action] of Object.entries({
    'rivet:config': () => loadConfig(directory),
    'rivet:check-model': value => checkModel(value),
    'rivet:open': async value => {
      if (opening) throw new Error('Rivet is already starting.');
      opening = true;
      try {
        const config = saveConfig(directory, value);
        restarting = true;
        await stopBackend();
        await startWorkspace(config);
        restarting = false;
        setupWindow?.close();
        return { ok: true };
      } finally { opening = false; restarting = false; }
    },
  })) {
    ipcMain.handle(channel, async (event, value) => {
      if (!setupWindow || event.sender !== setupWindow.webContents || event.senderFrame?.url !== setupUrl ||
          event.senderFrame !== event.sender.mainFrame) return { error: 'This action is only available in model settings.' };
      try { return await action(value); }
      catch (error) {
        if (error instanceof ModelError) return { error: error.message, code: error.code };
        // Do not surface raw network, process, filesystem or provider responses.
        if (channel === 'rivet:check-model') return { error: 'Could not connect. Check that your local model server is running and the address and model are correct.' };
        return { error: channel === 'rivet:open' ? 'Rivet could not start. Your saved work is unchanged. Close and reopen the app to retry.' : 'Could not read the local model settings.' };
      }
    });
  }
  showSetup();
}

function secureWindow(options) {
  const window = new BrowserWindow({ backgroundColor: '#ffffff', show: false, ...options,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      ...options.webPreferences } });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  return window;
}

function showSetup() {
  if (setupWindow) { setupWindow.show(); setupWindow.focus(); return; }
  setupWindow = secureWindow({ title: 'Rivet Alpha - Model settings', width: 620, height: 660, minWidth: 400, minHeight: 500,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), partition: 'rivet-setup' } });
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWindow.webContents.on('will-navigate', (event, url) => { if (url !== setupUrl) event.preventDefault(); });
  setupWindow.on('closed', () => { setupWindow = null; });
  void setupWindow.loadURL(setupUrl);
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startWorkspace(config) {
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
  const backendDir = path.join(resources, 'backend');
  const executable = path.join(resources, 'runtime', 'bin', 'node');
  if (!existsSync(executable) || !existsSync(path.join(backendDir, 'dist/web/index.html'))) throw new Error('Incomplete app.');
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  token = randomBytes(32).toString('hex');
  const child = fork(path.join(backendDir, 'apps/server/src/index.ts'), [], {
    execPath: executable,
    execArgv: ['--import', pathToFileURL(path.join(backendDir, 'node_modules/tsx/dist/loader.mjs')).href],
    cwd: backendDir, env: backendEnvironment({ directory, config, port, token }),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  backend = child;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Startup timed out.')), 30000);
      const onError = () => finish(new Error('Could not start backend.'));
      const onExit = () => finish(new Error('Backend exited during startup.'));
      const onMessage = value => { if (value?.type === 'rivet-ready' && value.port === port) finish(); };
      function finish(error) {
        clearTimeout(timer); child.off('error', onError); child.off('exit', onExit); child.off('message', onMessage);
        error ? reject(error) : resolve();
      }
      child.once('error', onError); child.once('exit', onExit); child.on('message', onMessage);
    });
  } catch (error) { await stopBackend(); throw error; }
  child.once('exit', () => {
    if (backend === child) backend = null;
    if (!stopping && !restarting) {
      workspaceWindow?.hide(); showSetup();
      void dialog.showMessageBox(setupWindow, { type: 'warning', title: 'Rivet stopped', message: 'The local workspace stopped unexpectedly.', detail: 'Your saved work remains on this Mac. Open Rivet again from this window to recover it.' });
    }
  });
  if (workspaceWindow) workspaceWindow.destroy();
  workspaceWindow = secureWindow({ title: 'Rivet Alpha', width: 1440, height: 940, minWidth: 760, minHeight: 560,
    webPreferences: { preload: path.join(__dirname, 'workspace-preload.cjs'), partition: 'persist:rivet-alpha' } });
  const contents = workspaceWindow.webContents;
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    callback({ cancel: !internalUrl(details.url, origin) });
  });
  // Only this trusted renderer receives the per-launch token, and only for its exact loopback origin.
  contents.session.webRequest.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'x-rivet-desktop-token') delete headers[key];
    if (details.webContentsId === contents.id && internalUrl(details.url, origin)) headers['X-Rivet-Desktop-Token'] = token;
    callback({ requestHeaders: headers });
  });
  const openOutside = async url => {
    if (!externalUrl(url)) return;
    const answer = await dialog.showMessageBox(workspaceWindow, { type: 'question', message: 'Open this link in your browser?',
      detail: new URL(url).origin, buttons: ['Cancel', 'Open browser'], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) await shell.openExternal(url);
  };
  contents.setWindowOpenHandler(({ url }) => { void openOutside(url); return { action: 'deny' }; });
  contents.on('will-navigate', (event, url) => { if (!internalUrl(url, origin)) { event.preventDefault(); void openOutside(url); } });
  contents.on('will-redirect', (event, url) => { if (!internalUrl(url, origin)) event.preventDefault(); });
  const downloadSession = contents.session;
  const onDownload = (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  };
  downloadSession.on('will-download', onDownload);
  const window = workspaceWindow;
  window.on('closed', () => {
    downloadSession.removeListener('will-download', onDownload);
    if (workspaceWindow === window) workspaceWindow = null;
  });
  await workspaceWindow.loadURL(`${origin}/`);
}

async function stopBackend() {
  const child = backend;
  if (!child) return;
  backend = null;
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 8000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
