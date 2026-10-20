#!/usr/bin/env node
// Private local packaging and verified launch. The parent confirms build stability.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RELEASE = Object.freeze({
  name: 'Rivet Alpha', bundleId: 'com.rivetfields.rivet.alpha', version: '0.1.1',
  electron: '44.9.0', packager: '20.3.0', node: '24.19.0', platform: 'darwin', arch: 'arm64',
  nodeArchive: 'node-v24.19.0-darwin-arm64.tar.gz',
  nodeSha256: '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
});
export const SHELL_FILES = ['package.json', 'main.cjs', 'runtime.cjs', 'preload.cjs', 'workspace-preload.cjs', 'setup.html', 'setup.css', 'setup.js'];
const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const NODE_URL = `https://nodejs.org/dist/v${RELEASE.node}/`;
const ELECTRON_URL = `https://github.com/electron/electron/releases/download/v${RELEASE.electron}/`;
const ELECTRON_ARCHIVE = `electron-v${RELEASE.electron}-darwin-arm64.zip`;
const APP_NAME = `${RELEASE.name}.app`;
const DMG_NAME = `Rivet-Alpha-${RELEASE.version}-darwin-arm64.dmg`;
// This source candidate omits external fixtures and all public logo artwork.
const EXACT = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', '.nvmrc', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt',
  'apps/web/index.html', 'apps/web/vite.config.ts',
  ...SHELL_FILES.map(name => `apps/desktop/${name}`), 'apps/desktop/package-lock.json',
  'scripts/package-desktop.mjs', 'scripts/package-desktop.test.mjs',
]);
export const REQUIRED_SOURCES = [...EXACT, 'apps/server/src/index.ts', 'packages/core/src/index.ts',
  'packages/data-layer/src/index.ts', 'packages/presentation/src/weekly-review-email.ts'];
const SOURCE_PREFIXES = ['apps/server/src/', 'apps/web/src/', 'packages/core/src/',
  'packages/data-layer/src/', 'packages/presentation/src/'];
const OMIT_ENTRIES = new Set(['apps/server/src/main-hosted.ts', 'apps/server/src/main-local-azure.ts']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function parseArgs(args) {
  const mode = ['--verify', '--launch'].includes(args[0]) ? args[0].slice(2) : undefined;
  if ((args.length === 1 && args[0] === '--help') || (mode && args.length === 2 && args[1] === '--help')) return { help: true };
  if (mode && args.length === 2 && args[1] && !args[1].startsWith('--')) return { [mode]: args[1] };
  if (args.length !== 3 || args[0] !== '--output' || !args[1] || args[2] !== '--confirm-code-stable') {
    throw new Error('Usage: npm run desktop:package -- --output /outside/git/new-directory --confirm-code-stable (only after parent confirmation); npm run desktop:verify -- /absolute/artifact-directory; npm run desktop:launch -- /absolute/artifact-directory');
  }
  return { output: args[1], codeStable: true };
}

export function validateHost(version = process.versions.node, platform = process.platform, arch = process.arch) {
  if (!/^24\./.test(version)) throw new Error('Run the packager with Node 24.');
  if (platform !== RELEASE.platform || arch !== RELEASE.arch) throw new Error('Build on native Apple silicon macOS (darwin arm64); cross-builds and Rosetta are not supported.');
}

export function checkPackagingSource(root = ROOT) {
  command(process.execPath, [path.join(root, 'tools/check-source.mjs')], { cwd: root,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } });
}

export function allowedSource(name) {
  if (/[\\\x00-\x1f\x7f]/.test(name)) return false;
  const parts = name.split('/');
  if (parts.some(part => !part || ['.', '..', 'node_modules', 'dist', 'outputs', 'work', 'screenshots'].includes(part)
    || (part.startsWith('.') && name !== '.nvmrc'))) return false;
  if (EXACT.has(name)) return true;
  return !OMIT_ENTRIES.has(name) && SOURCE_PREFIXES.some(prefix => name.startsWith(prefix)) && /\.(?:ts|tsx|css)$/.test(name);
}

export function backendSource(name) {
  return allowedSource(name) && !/\.(?:test|browser-test|spec)\./.test(name)
    && (name === 'tsconfig.json' || ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'].includes(name) || name.startsWith('fixtures/')
      || SOURCE_PREFIXES.filter(prefix => !prefix.startsWith('apps/web/')).some(prefix => name.startsWith(prefix)));
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(binary)} ${args[0]} failed (${result.status ?? result.signal}).`);
  return result.stdout?.trimEnd() ?? '';
}

function git(root, ...args) { return command('/usr/bin/git', ['-C', root, ...args]); }
function candidates(root) {
  return [...new Set(git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0'))].filter(allowedSource).sort();
}

export function sourceBytes(root, name) {
  const filename = path.join(root, name);
  if (!allowedSource(name) || realpathSync(filename) !== filename || !lstatSync(filename).isFile()) {
    throw new Error(`Linked or non-regular source is forbidden: ${name}`);
  }
  const before = statSync(filename, { bigint: true });
  if (before.size > 8n * 1024n * 1024n) throw new Error(`Source exceeds 8 MiB: ${name}`);
  const bytes = readFileSync(filename);
  const after = statSync(filename, { bigint: true });
  if (before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.size !== after.size) throw new Error('Source changed while packaging.');
  return bytes;
}

export function snapshotSources(root) {
  root = realpathSync(root);
  const names = candidates(root);
  if (REQUIRED_SOURCES.some(name => !names.includes(name)) || names.length > 10000) throw new Error('Required desktop source is missing or source count exceeds 10,000.');
  const files = names.map(name => ({ path: name, bytes: sourceBytes(root, name) }));
  if (files.reduce((total, file) => total + file.bytes.length, 0) > 256 * 1024 * 1024) throw new Error('Source exceeds 256 MiB.');
  return { gitHead: git(root, 'rev-parse', 'HEAD'), dirty: Boolean(git(root, 'status', '--porcelain=v1', '--untracked-files=all')),
    files: files.map(file => ({ ...file, sha256: sha256(file.bytes) })) };
}

export function assertUnchanged(root, snapshot) {
  const names = candidates(root);
  if (JSON.stringify(names) !== JSON.stringify(snapshot.files.map(file => file.path))
    || git(root, 'rev-parse', 'HEAD') !== snapshot.gitHead
    || snapshot.files.some(file => sha256(sourceBytes(realpathSync(root), file.path)) !== file.sha256)) {
    throw new Error('Source changed while packaging; wait for the parent and retry.');
  }
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function reserveOutput(root, requested) {
  if (!path.isAbsolute(requested) || /[\x00-\x1f\x7f]/.test(requested)) throw new Error('Output must be an absolute directory outside Git.');
  const absolute = path.resolve(requested);
  // Require an existing parent so symlinks and Git membership are checked before any write.
  const parent = realpathSync(path.dirname(absolute));
  const output = path.join(parent, path.basename(absolute));
  const insideGit = spawnSync('/usr/bin/git', ['-C', parent, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', shell: false });
  if (within(realpathSync(root), output) || insideGit.status === 0) throw new Error('Choose an output directory outside Git.');
  try { mkdirSync(output, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Output exists; refusing to overwrite.'); throw error; }
  return output;
}

export function expectedChecksum(text, filename) {
  const rows = text.split(/\r?\n/).map(line => /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line)).filter(Boolean).filter(row => row[2] === filename);
  if (rows.length !== 1) throw new Error(`Official checksum missing or duplicated: ${filename}`);
  return rows[0][1].toLowerCase();
}

export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyArchive(filename, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected) || await hashFile(filename) !== expected) throw new Error('Archive SHA-256 mismatch; extraction refused.');
}

async function download(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') throw new Error(`Official download unavailable: ${url}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Download exceeds size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function buildEnvironment(node, workspace) {
  return { PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: path.join(workspace, 'home'),
    TMPDIR: path.join(workspace, 'tmp'), LANG: 'en_US.UTF-8', CI: '1',
    npm_config_cache: path.join(workspace, 'npm-cache'), npm_config_userconfig: path.join(workspace, 'npm-user.conf'),
    npm_config_globalconfig: path.join(workspace, 'npm-global.conf'), npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_arch: RELEASE.arch, npm_config_platform: RELEASE.platform, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' };
}

function writeJSON(filename, value) { writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
function writeSource(directory, name, bytes) {
  const target = path.join(directory, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
}

export function validateLock(lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw new Error('An npm v3 lockfile is required.');
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (entry.link || !entry.version || !entry.integrity || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity)
      || !entry.resolved?.startsWith('https://registry.npmjs.org/')) throw new Error(`Dependency must have a locked npm registry version and integrity: ${name}`);
  }
}

export function runtimeMetadata(pkg, lock) {
  validateLock(lock);
  const dependencies = { ...pkg.dependencies };
  for (const name of ['tsx', 'esbuild']) {
    const version = lock.packages[`node_modules/${name}`]?.version;
    if (!version) throw new Error(`Missing locked runtime dependency: ${name}`);
    dependencies[name] = version;
  }
  const runtime = { name: `${pkg.name}-desktop-runtime`, version: RELEASE.version, private: true,
    type: 'module', engines: { node: '24.x' }, dependencies, ...(pkg.overrides ? { overrides: pkg.overrides } : {}) };
  const derived = structuredClone(lock);
  derived.name = runtime.name;
  derived.version = runtime.version;
  derived.packages[''] = { name: runtime.name, version: runtime.version, dependencies, engines: runtime.engines };
  return { package: runtime, lock: derived };
}

export function assertLockedDependencies(original, derived) {
  validateLock(derived);
  for (const [name, entry] of Object.entries(derived.packages)) {
    if (!name) continue;
    const before = original.packages[name];
    if (!before || ['version', 'resolved', 'integrity'].some(key => before[key] !== entry[key])) throw new Error(`Runtime dependency drift: ${name}`);
  }
}

export async function treeInventory(directory) {
  const files = [];
  async function walk(relative) {
    for (const name of readdirSync(path.join(directory, relative)).sort()) {
      const item = path.join(relative, name);
      const absolute = path.join(directory, item);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        if (path.isAbsolute(target) || !within(realpathSync(directory), realpathSync(absolute))) throw new Error(`Escaping bundle symlink: ${item}`);
        files.push({ path: item, type: 'symlink', target });
      } else if (info.isDirectory()) await walk(item);
      else if (info.isFile()) files.push({ path: item, type: 'file', size: info.size, mode: info.mode & 0o777, sha256: await hashFile(absolute) });
      else throw new Error(`Non-regular bundle entry: ${item}`);
    }
  }
  await walk('');
  return files;
}

function artifactFile(directory, name, maxBytes = Infinity) {
  const filename = path.join(directory, name);
  const info = lstatSync(filename);
  if (!info.isFile() || realpathSync(filename) !== filename || info.size > maxBytes) throw new Error(`Invalid or linked artifact file: ${name}`);
  return filename;
}

/** Integrity of a local build, not authorship, signing or notarization approval. */
export async function verifyDesktop(requested) {
  if (!path.isAbsolute(requested) || /[\x00-\x1f\x7f]/.test(requested)) throw new Error('Choose an absolute artifact directory.');
  const directory = path.resolve(requested);
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error('Artifact directory must be a real directory, not a link.');
  const manifestFile = artifactFile(directory, 'manifest.json', 16 * 1024 * 1024);
  const checksums = readFileSync(artifactFile(directory, 'SHA256SUMS', 8192), 'utf8');
  await verifyArchive(manifestFile, expectedChecksum(checksums, 'manifest.json'));
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest.format !== 'rivet-private-desktop/v1' || manifest.distribution !== 'private-local-alpha' || manifest.published !== false
    || !/^[a-f0-9]{40}$/.test(manifest.gitHead ?? '')
    || Object.entries(RELEASE).some(([key, value]) => manifest.release?.[key] !== value)
    || manifest.app?.path !== APP_NAME || manifest.dmg?.path !== DMG_NAME || !Array.isArray(manifest.app.files)) {
    throw new Error('Artifact manifest does not match this private desktop package contract.');
  }
  const dmg = artifactFile(directory, DMG_NAME);
  const dmgSha256 = expectedChecksum(checksums, DMG_NAME);
  if (manifest.dmg.sha256 !== dmgSha256) throw new Error('DMG manifest checksum differs from SHA256SUMS.');
  await verifyArchive(dmg, dmgSha256);
  const app = path.join(directory, APP_NAME);
  if (!lstatSync(app).isDirectory() || realpathSync(app) !== app) throw new Error('App bundle must be a real directory, not a link.');
  const files = await treeInventory(app);
  if (sha256(JSON.stringify(files)) !== manifest.app.inventorySha256
    || sha256(JSON.stringify(manifest.app.files)) !== manifest.app.inventorySha256) throw new Error('App inventory changed since packaging.');
  for (const name of [
    `Contents/MacOS/${RELEASE.name}`, 'Contents/Info.plist', 'Contents/Resources/app.asar',
    'Contents/Resources/runtime/bin/node', 'Contents/Resources/runtime/LICENSE',
    'Contents/Resources/backend/apps/server/src/index.ts', 'Contents/Resources/backend/package-lock.json',
    'Contents/Resources/backend/node_modules/tsx/dist/loader.mjs',
    'Contents/Resources/backend/node_modules/@esbuild/darwin-arm64/bin/esbuild',
    'Contents/Resources/backend/dist/web/index.html',
    'Contents/Resources/licenses/LICENSE', 'Contents/Resources/licenses/LICENSES.chromium.html',
  ]) artifactFile(app, name);
  for (const name of [`Contents/MacOS/${RELEASE.name}`, 'Contents/Resources/runtime/bin/node',
    'Contents/Resources/backend/node_modules/@esbuild/darwin-arm64/bin/esbuild']) {
    if (!(statSync(path.join(app, name)).mode & 0o111)) throw new Error(`Runtime executable is not executable: ${name}`);
  }
  return { app, manifest };
}

export async function launchDesktop(requested, run = command) {
  validateHost();
  const verified = await verifyDesktop(requested);
  // Use Launch Services, without changing quarantine, settings or the data directory.
  run('/usr/bin/open', ['-n', '-a', verified.app], { env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'en_US.UTF-8',
  } });
  return verified;
}

export function packagerOptions(shell, workspace, electronSha256) {
  return { dir: shell, name: RELEASE.name, appBundleId: RELEASE.bundleId, appVersion: RELEASE.version,
    buildVersion: RELEASE.version, electronVersion: RELEASE.electron, platform: RELEASE.platform, arch: RELEASE.arch,
    out: path.join(workspace, 'packaged'), tmpdir: path.join(workspace, 'tmp'), overwrite: false,
    asar: true, prune: false, ignore: name => name !== '' && name !== '/' && !SHELL_FILES.includes(name.replace(/^\//, '')),
    download: { cacheRoot: path.join(workspace, 'electron-cache'), unsafelyDisableChecksums: false,
      checksums: { [ELECTRON_ARCHIVE]: electronSha256 },
      mirrorOptions: { resolveAssetURL: async () => `${ELECTRON_URL}${ELECTRON_ARCHIVE}` } },
  };
}

export function dmgArguments(source, output) {
  return ['create', '-volname', RELEASE.name, '-srcfolder', source, '-format', 'UDZO', '-fs', 'HFS+', output];
}

export function copyRuntimeResources(packaged, workspace) {
  const resources = path.join(packaged, `${RELEASE.name}.app`, 'Contents/Resources');
  // Packager's extraResource copy rewrites relative npm symlinks to staging paths.
  for (const name of ['backend', 'runtime']) cpSync(path.join(workspace, name), path.join(resources, name),
    { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  const licenses = path.join(resources, 'licenses');
  mkdirSync(licenses);
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    const source = path.join(packaged, name);
    if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error(`Missing Electron license: ${name}`);
    copyFileSync(source, path.join(licenses, name));
  }
}

async function prepareNode(workspace) {
  const checksums = await download(`${NODE_URL}SHASUMS256.txt`, 1024 * 1024);
  if (expectedChecksum(checksums.toString('utf8'), RELEASE.nodeArchive) !== RELEASE.nodeSha256) throw new Error('Official Node checksum changed; refusing the archive.');
  const archive = path.join(workspace, RELEASE.nodeArchive);
  writeFileSync(archive, await download(`${NODE_URL}${RELEASE.nodeArchive}`, 128 * 1024 * 1024), { flag: 'wx' });
  await verifyArchive(archive, RELEASE.nodeSha256);
  // Only the verified official archive is ever passed to tar.
  command('/usr/bin/tar', ['-xzf', archive, '-C', workspace]);
  const distribution = path.join(workspace, `node-v${RELEASE.node}-darwin-arm64`);
  const node = path.join(distribution, 'bin/node');
  const env = buildEnvironment(node, workspace);
  for (const directory of [env.HOME, env.TMPDIR]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (command(node, ['-p', 'process.versions.node+" "+process.platform+" "+process.arch'], { env }) !== `${RELEASE.node} darwin arm64`) throw new Error('Downloaded Node runtime does not match the pinned platform/version.');
  const runtime = path.join(workspace, 'runtime');
  mkdirSync(path.join(runtime, 'bin'), { recursive: true });
  copyFileSync(node, path.join(runtime, 'bin/node'));
  chmodSync(path.join(runtime, 'bin/node'), 0o755);
  copyFileSync(path.join(distribution, 'LICENSE'), path.join(runtime, 'LICENSE'));
  return { node, npm: path.join(distribution, 'lib/node_modules/npm/bin/npm-cli.js'), env };
}

export async function packageDesktop({ output: requested, codeStable }, root = ROOT) {
  if (!codeStable) throw new Error('Parent code-stable confirmation is required before packaging.');
  validateHost();
  const snapshot = snapshotSources(root);
  checkPackagingSource(root);
  assertUnchanged(root, snapshot);
  const output = reserveOutput(root, requested);
  const workspace = mkdtempSync(path.join(path.dirname(output), '.rivet-desktop-'));
  try {
    const build = path.join(workspace, 'build');
    for (const file of snapshot.files) writeSource(build, file.path, file.bytes);
    const pkg = JSON.parse(readFileSync(path.join(build, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(build, 'package-lock.json'), 'utf8'));
    const shell = path.join(build, 'apps/desktop');
    const shellPkg = JSON.parse(readFileSync(path.join(shell, 'package.json'), 'utf8'));
    validateLock(lock);
    validateLock(JSON.parse(readFileSync(path.join(shell, 'package-lock.json'), 'utf8')));
    if (shellPkg.main !== 'main.cjs' || shellPkg.version !== RELEASE.version || !shellPkg.private
      || shellPkg.devDependencies?.electron !== RELEASE.electron || shellPkg.devDependencies?.['@electron/packager'] !== RELEASE.packager) throw new Error('Desktop metadata differs from the pinned package contract.');
    const { node, npm, env } = await prepareNode(workspace);
    const runNpm = (cwd, args) => command(node, [npm, ...args, '--no-audit', '--no-fund'], { cwd, env, stdio: 'inherit' });
    console.log('Installing and building allowlisted source with pinned arm64 Node.');
    runNpm(build, ['ci', '--ignore-scripts', '--include=dev', '--include=optional']);
    command(node, ['node_modules/typescript/bin/tsc', '--noEmit'], { cwd: build, env, stdio: 'inherit' });
    command(node, ['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts'], { cwd: build, env, stdio: 'inherit' });
    const backend = path.join(workspace, 'backend');
    mkdirSync(backend);
    for (const file of snapshot.files.filter(file => backendSource(file.path))) writeSource(backend, file.path, file.bytes);
    cpSync(path.join(build, 'dist/web'), path.join(backend, 'dist/web'), { recursive: true, errorOnExist: true, force: false });
    const runtime = runtimeMetadata(pkg, lock);
    writeJSON(path.join(backend, 'package.json'), runtime.package);
    writeJSON(path.join(backend, 'package-lock.json'), runtime.lock);
    // npm recomputes production reachability; every resulting resolution must remain in the original lock.
    runNpm(backend, ['install', '--package-lock-only', '--ignore-scripts', '--offline']);
    const runtimeLock = JSON.parse(readFileSync(path.join(backend, 'package-lock.json'), 'utf8'));
    assertLockedDependencies(lock, runtimeLock);
    runNpm(backend, ['ci', '--omit=dev', '--include=optional', '--ignore-scripts']);
    for (const name of ['node_modules/tsx/dist/loader.mjs', 'node_modules/@esbuild/darwin-arm64/bin/esbuild', 'dist/web/index.html']) {
      if (!existsSync(path.join(backend, name))) throw new Error(`Missing runtime payload: ${name}`);
    }
    command(node, ['--import', './node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e',
      'import { transformSync } from "esbuild"; import "./packages/core/src/index.ts"; transformSync("const n: number = 1", {loader:"ts"});'], { cwd: backend, env, stdio: 'inherit' });
    await treeInventory(backend);
    runNpm(shell, ['ci', '--ignore-scripts', '--include=dev', '--include=optional']);
    const electronSha256 = expectedChecksum((await download(`${ELECTRON_URL}SHASUMS256.txt`, 1024 * 1024)).toString('utf8'), ELECTRON_ARCHIVE);
    const { packager } = await import(pathToFileURL(path.join(shell, 'node_modules/@electron/packager/dist/index.js')).href);
    assertUnchanged(root, snapshot);
    const packaged = await packager(packagerOptions(shell, workspace, electronSha256));
    if (packaged.length !== 1) throw new Error('Expected exactly one Apple-silicon application.');
    copyRuntimeResources(packaged[0], workspace);
    const imageRoot = path.join(workspace, 'dmg-root');
    mkdirSync(imageRoot);
    const appName = APP_NAME;
    const app = path.join(imageRoot, appName);
    renameSync(path.join(packaged[0], appName), app);
    symlinkSync('/Applications', path.join(imageRoot, 'Applications'));
    const appFiles = await treeInventory(app);
    const dmgName = DMG_NAME;
    const dmg = path.join(workspace, dmgName);
    command('/usr/bin/hdiutil', dmgArguments(imageRoot, dmg), { env, stdio: 'inherit' });
    command('/usr/bin/hdiutil', ['verify', dmg], { env, stdio: 'inherit' });
    assertUnchanged(root, snapshot);
    const appSha256 = sha256(JSON.stringify(appFiles));
    const dmgSha256 = await hashFile(dmg);
    const installed = Object.entries(runtimeLock.packages).filter(([name]) => name && existsSync(path.join(backend, name, 'package.json')))
      .map(([name, entry]) => ({ path: name, version: entry.version, integrity: entry.integrity, resolved: entry.resolved }));
    const manifest = {
      format: 'rivet-private-desktop/v1', createdAt: new Date().toISOString(), release: RELEASE,
      distribution: 'private-local-alpha', signing: 'not requested', notarization: 'not requested', published: false,
      gitHead: snapshot.gitHead, workingTreeSnapshot: true, uncommittedChanges: snapshot.dirty,
      uncommittedChangesAtCompletion: Boolean(git(root, 'status', '--porcelain=v1', '--untracked-files=all')),
      files: snapshot.files.map(file => ({ path: file.path, size: file.bytes.length, sha256: file.sha256 })),
      node: { url: `${NODE_URL}${RELEASE.nodeArchive}`, checksumsUrl: `${NODE_URL}SHASUMS256.txt`, archiveSha256: RELEASE.nodeSha256,
        binarySha256: await hashFile(path.join(workspace, 'runtime/bin/node')), license: 'Contents/Resources/runtime/LICENSE' },
      electron: { version: RELEASE.electron, url: `${ELECTRON_URL}${ELECTRON_ARCHIVE}`, archiveSha256: electronSha256 },
      runtimeLockSha256: await hashFile(path.join(backend, 'package-lock.json')), installedDependencies: installed,
      app: { path: appName, inventorySha256: appSha256, inventoryHashFormat: 'SHA-256 of JSON.stringify(files), UTF-8', files: appFiles },
      dmg: { path: dmgName, sha256: dmgSha256, format: 'UDZO', readOnly: true, applicationsLink: '/Applications' },
    };
    renameSync(app, path.join(output, appName));
    renameSync(dmg, path.join(output, dmgName));
    writeJSON(path.join(output, 'manifest.json'), manifest);
    writeFileSync(path.join(output, 'SHA256SUMS'), `${dmgSha256}  ${dmgName}\n${await hashFile(path.join(output, 'manifest.json'))}  manifest.json\n`, { flag: 'wx' });
    await verifyDesktop(output);
    console.log(`Private local alpha written to ${output}. No signing, notarization or publication was requested.`);
    return manifest;
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Private Apple-silicon alpha (Node 24):\n  npm run desktop:package -- --output /outside/git/new-directory --confirm-code-stable\n  npm run desktop:verify -- /absolute/artifact-directory\n  npm run desktop:launch -- /absolute/artifact-directory\nPackaging requires parent code-stable confirmation. No signing, notarization or publication. Verification checks integrity, not authorship or public readiness. Launch uses normal Rivet Alpha app data; quit other Rivet copies first.');
    else if (options.verify) {
      const { manifest } = await verifyDesktop(options.verify);
      console.log(`Private desktop integrity verified at source ${manifest.gitHead}${manifest.uncommittedChanges ? ' plus recorded working-tree changes' : ''}. This is not signing, notarization or release approval.`);
    } else if (options.launch) {
      console.log('Launch uses normal Rivet Alpha app data. Quit other Rivet copies first. No settings or security-bypass flags are supplied.');
      await launchDesktop(options.launch);
    } else await packageDesktop(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
