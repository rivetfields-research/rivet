import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE, REQUIRED_SOURCES, SHELL_FILES, allowedSource, assertLockedDependencies, assertUnchanged,
  backendSource, buildEnvironment, checkPackagingSource, copyRuntimeResources, dmgArguments, expectedChecksum, hashFile, packageDesktop, packagerOptions,
  launchDesktop, parseArgs, reserveOutput, runtimeMetadata, snapshotSources, sourceBytes, treeInventory, validateHost,
  validateLock, verifyArchive, verifyDesktop } from './package-desktop.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function temporary(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'rivet-desktop-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function put(root, name, bytes = 'synthetic fixture') {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}
function git(directory, ...args) {
  const result = spawnSync('/usr/bin/git', ['-C', directory, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fixture(t) {
  const directory = temporary(t);
  const source = path.join(directory, 'source');
  mkdirSync(source);
  git(source, 'init', '-q');
  for (const name of REQUIRED_SOURCES) put(source, name);
  // A synthetic empty commit exists only in this disposable test repository.
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-qm', 'fixture');
  return { directory, source };
}

test('packaging requires explicit parent stability confirmation and native Node 24 arm64', async t => {
  assert.deepEqual(parseArgs(['--output', '/tmp/new alpha', '--confirm-code-stable']), { output: '/tmp/new alpha', codeStable: true });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  for (const args of [[], ['--output', '/tmp/a'], ['--output', '/tmp/a', '--force'], ['--output', '/tmp/a', '--confirm-code-stable', '--sign']]) assert.throws(() => parseArgs(args), /Usage/);
  validateHost('24.19.0', 'darwin', 'arm64');
  assert.throws(() => validateHost('26.3.1', 'darwin', 'arm64'), /Node 24/);
  assert.throws(() => validateHost('24.19.0', 'darwin', 'x64'), /native Apple silicon/);
  assert.throws(() => validateHost('24.19.0', 'linux', 'arm64'), /native Apple silicon/);
  const output = path.join(temporary(t), 'never-created');
  await assert.rejects(packageDesktop({ output, codeStable: false }), /confirmation/);
  assert.equal(existsSync(output), false);
});

test('root desktop commands expose packaging, read-only verification and explicit launch without changing install behavior', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
  assert.equal(pkg.scripts['desktop:package'], 'node scripts/package-desktop.mjs');
  assert.equal(pkg.scripts['desktop:verify'], 'node scripts/package-desktop.mjs --verify');
  assert.equal(pkg.scripts['desktop:launch'], 'node scripts/package-desktop.mjs --launch');
  for (const mode of ['verify', 'launch']) {
    assert.deepEqual(parseArgs([`--${mode}`, '/tmp/private alpha ; output']), { [mode]: '/tmp/private alpha ; output' });
    assert.deepEqual(parseArgs([`--${mode}`, '--help']), { help: true });
    for (const args of [[`--${mode}`], [`--${mode}`, '--output'], [`--${mode}`, '/tmp/a', '--force'],
      [`--${mode}`, '/tmp/a', '--args', '--no-sandbox']]) assert.throws(() => parseArgs(args), /Usage/);
  }
  for (const name of ['install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[name], undefined);
});

test('packaging source preflight runs the existing guard with no inherited credentials and fails closed', t => {
  const directory = temporary(t);
  put(directory, 'tools/check-source.mjs', `
    // macOS adds text encoding even when spawn receives only PATH.
    if (Object.keys(process.env).some(name => !['PATH', '__CF_USER_TEXT_ENCODING'].includes(name))) throw Error('Inherited build environment');
  `);
  checkPackagingSource(directory);
  put(directory, 'tools/check-source.mjs', "throw Error('Synthetic source boundary refusal');");
  assert.throws(() => checkPackagingSource(directory), /failed/);
  rmSync(path.join(directory, 'tools/check-source.mjs'));
  assert.throws(() => checkPackagingSource(directory), /failed/);
});

test('unreviewed source cannot reserve an output directory or begin packaging', async t => {
  const { directory, source } = fixture(t);
  const output = path.join(directory, 'never-created');
  await assert.rejects(packageDesktop({ output, codeStable: true }, source), /failed|native Apple silicon/);
  assert.equal(existsSync(output), false);
});

test('allowlist excludes private data, customer branding, checkout dist, tools and operational launchers', () => {
  for (const name of ['.env', '.env.example', '.data/private.sqlite', 'credentials.key', 'screenshots/page.png',
    'apps/web/public/branding/unapproved-icon.svg', 'apps/web/public/branding/unapproved-icon.webp',
    'apps/web/public/unreviewed.js', 'apps/web/public/.env', 'dist/web/index.html', 'node_modules/tsx/package.json',
    'apps/desktop/node_modules/electron/index.js', 'apps/desktop/output/Rivet.app', 'apps/desktop/unknown.cjs',
    'apps/server/src/.secret/key.ts', 'apps/server/src/node_modules/private.ts', 'apps/server/src/credentials.key',
    'apps/server/src/main-hosted.ts', 'apps/server/src/main-local-azure.ts', 'scripts/deploy.mjs',
    'fixtures/notes/customer.md', 'fixtures/notes/finance-handoff.md', 'apps/web/public/branding/platforms/LICENSE.md',
    'apps/web/public/connectors/github.svg', 'scripts/e2e/fake-meta-graph.mjs', 'scripts/e2e/fake-meta-graph.d.mts',
    'fixtures/connectors/meta/debug-token.json', '../package.json', '/package.json',
    'apps/server/src/../secret.ts', 'apps\\server\\src\\index.ts', 'apps/server/src/line\n.ts']) {
    assert.equal(allowedSource(name), false, name);
  }
  for (const name of ['apps/server/src/index.ts', 'apps/web/src/main.tsx', 'packages/core/src/index.ts',
    'apps/web/index.html', 'apps/web/vite.config.ts']) {
    assert.equal(allowedSource(name), true, name);
  }
  for (const file of SHELL_FILES) assert.equal(allowedSource(`apps/desktop/${file}`), true);
});

test('backend ships current shared sources and notices, but not build inputs or tests', () => {
  for (const name of ['apps/server/src/index.ts', 'apps/server/src/hosted.ts', 'packages/core/src/provider.ts',
    'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'tsconfig.json']) assert.equal(backendSource(name), true, name);
  for (const name of ['apps/web/src/main.tsx', 'apps/desktop/main.cjs', 'apps/server/src/http.test.ts',
    'packages/core/src/oauth.contract.test.ts', 'scripts/e2e/fake-oauth.mjs', 'scripts/package-desktop.mjs',
    'package.json', 'package-lock.json', 'apps/server/src/main-hosted.ts']) assert.equal(backendSource(name), false, name);
});

test('snapshot hashes current dirty source and detects edits and newly added allowed files', t => {
  const { source } = fixture(t);
  put(source, '.env', 'synthetic private value');
  put(source, 'dist/web/index.html', 'stale checkout build');
  put(source, 'apps/web/public/branding/unapproved-icon.svg');
  const snapshot = snapshotSources(source);
  assert.equal(snapshot.dirty, true);
  assert.match(snapshot.gitHead, /^[0-9a-f]{40}$/);
  assert.equal(snapshot.files.some(file => /\.env|dist\/|unapproved-icon/.test(file.path)), false);
  for (const file of snapshot.files) assert.equal(file.sha256, hash(readFileSync(path.join(source, file.path))));
  assertUnchanged(source, snapshot);
  put(source, 'apps/server/src/new.ts');
  assert.throws(() => assertUnchanged(source, snapshot), /Source changed/);
  rmSync(path.join(source, 'apps/server/src/new.ts'));
  put(source, 'apps/server/src/index.ts', 'edited after capture');
  assert.throws(() => assertUnchanged(source, snapshot), /Source changed/);
});

test('snapshot refuses missing files, file symlinks and linked source directories', t => {
  const { directory, source } = fixture(t);
  const target = path.join(source, 'apps/server/src/index.ts');
  rmSync(target);
  assert.throws(() => snapshotSources(source), /Required desktop source/);
  symlinkSync(put(directory, 'outside.ts'), target);
  assert.throws(() => sourceBytes(source, 'apps/server/src/index.ts'), /Linked or non-regular/);
  rmSync(target);
  rmSync(path.join(source, 'apps/server/src'), { recursive: true });
  mkdirSync(path.join(directory, 'linked'));
  put(directory, 'linked/index.ts');
  symlinkSync(path.join(directory, 'linked'), path.join(source, 'apps/server/src'));
  assert.throws(() => sourceBytes(source, 'apps/server/src/index.ts'), /Linked or non-regular/);
});

test('output reservation refuses any Git tree, symlink aliases, existing directories and dangling links', t => {
  const { source, directory } = fixture(t);
  assert.throws(() => reserveOutput(source, path.join(source, 'output')), /outside Git/);
  symlinkSync(source, path.join(directory, 'alias'));
  assert.throws(() => reserveOutput(source, path.join(directory, 'alias/output')), /outside Git/);
  const other = path.join(directory, 'other-repo');
  mkdirSync(other);
  git(other, 'init', '-q');
  assert.throws(() => reserveOutput(source, path.join(other, 'output')), /outside Git/);
  assert.throws(() => reserveOutput(source, path.join(other, '.git/output')), /outside Git/);
  const bare = path.join(directory, 'bare.git');
  git(directory, 'init', '--bare', '-q', bare);
  assert.throws(() => reserveOutput(source, path.join(bare, 'output')), /outside Git/);
  const output = reserveOutput(source, path.join(directory, 'new alpha'));
  put(output, 'keep', 'existing bytes');
  assert.throws(() => reserveOutput(source, output), /refusing to overwrite/);
  assert.equal(readFileSync(path.join(output, 'keep'), 'utf8'), 'existing bytes');
  symlinkSync(path.join(directory, 'missing'), path.join(directory, 'dangling'));
  assert.throws(() => reserveOutput(source, path.join(directory, 'dangling')), /refusing to overwrite/);
  assert.throws(() => reserveOutput(source, 'relative'), /absolute/);
});

test('Node checksums are exact, unambiguous and checked before archive use', async t => {
  const bytes = Buffer.from('synthetic archive');
  const digest = hash(bytes);
  const filename = put(temporary(t), 'archive.tar.gz', bytes);
  assert.equal(expectedChecksum(`${digest}  archive.tar.gz\r\n`, 'archive.tar.gz'), digest);
  assert.equal(expectedChecksum(`${digest} *archive.tar.gz\n`, 'archive.tar.gz'), digest);
  assert.throws(() => expectedChecksum(`${digest}  other.tar.gz`, 'archive.tar.gz'), /missing/);
  assert.throws(() => expectedChecksum(`${digest}  archive.tar.gz\n${digest}  archive.tar.gz`, 'archive.tar.gz'), /duplicated/);
  await verifyArchive(filename, digest);
  await assert.rejects(verifyArchive(filename, '0'.repeat(64)), /extraction refused/);
  assert.equal(await hashFile(filename), digest);
  assert.equal(RELEASE.nodeSha256, '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d');
});

test('build environment excludes inherited credentials, Node hooks, Vite variables and npm/Electron mirrors', () => {
  const env = buildEnvironment('/isolated/node/bin/node', '/isolated/build');
  assert.deepEqual(Object.keys(env).sort(), ['CI', 'ELECTRON_SKIP_BINARY_DOWNLOAD', 'HOME', 'LANG', 'PATH', 'TMPDIR',
    'npm_config_arch', 'npm_config_cache', 'npm_config_globalconfig', 'npm_config_platform', 'npm_config_registry', 'npm_config_userconfig'].sort());
  assert.equal(env.PATH, '/isolated/node/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(env.npm_config_arch, 'arm64');
  assert.equal(env.npm_config_userconfig, '/isolated/build/npm-user.conf');
  assert.notEqual(env.npm_config_globalconfig, env.npm_config_userconfig);
});

test('runtime metadata promotes locked tsx/esbuild and preserves upstream dependencies and overrides', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json')));
  const before = JSON.stringify(lock);
  const runtime = runtimeMetadata(pkg, lock);
  assert.equal(JSON.stringify(lock), before);
  assert.equal(runtime.package.private, true);
  assert.equal(runtime.package.type, 'module');
  assert.equal(runtime.package.scripts, undefined);
  assert.equal(runtime.package.devDependencies, undefined);
  assert.deepEqual(runtime.package.overrides, pkg.overrides);
  for (const [name, version] of Object.entries(pkg.dependencies)) assert.equal(runtime.package.dependencies[name], version);
  for (const name of ['tsx', 'esbuild']) assert.equal(runtime.package.dependencies[name], lock.packages[`node_modules/${name}`].version);
  assert.deepEqual(runtime.lock.packages[''].dependencies, runtime.package.dependencies);
  assertLockedDependencies(lock, runtime.lock);
  runtime.lock.packages['node_modules/tsx'].version = '999.0.0';
  assert.throws(() => assertLockedDependencies(lock, runtime.lock), /dependency drift/);
});

test('dependency audit rejects absent integrity, external/local resolutions and unpinned additions', () => {
  const original = JSON.parse(readFileSync(path.join(root, 'package-lock.json')));
  for (const patch of [{ integrity: undefined }, { resolved: 'file:../../private' }, { resolved: 'https://example.invalid/pkg.tgz' }, { link: true }]) {
    const changed = structuredClone(original);
    Object.assign(changed.packages['node_modules/tsx'], patch);
    assert.throws(() => validateLock(changed), /locked npm registry/);
  }
  const added = structuredClone(original);
  added.packages['node_modules/unknown'] = { ...original.packages['node_modules/tsx'] };
  assert.throws(() => assertLockedDependencies(original, added), /dependency drift/);
  assert.throws(() => validateLock({ lockfileVersion: 2 }), /v3 lockfile/);
});

test('npm normalizes the real runtime lock offline without changing resolutions or omitting tsx/esbuild', t => {
  const located = process.env.npm_execpath || spawnSync('which', ['npm'], { encoding: 'utf8' }).stdout?.trim();
  assert.ok(located && existsSync(located), 'npm is required for the runtime lock regression check');
  const npm = realpathSync(located);
  const directory = temporary(t);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
  const original = JSON.parse(readFileSync(path.join(root, 'package-lock.json')));
  const runtime = runtimeMetadata(pkg, original);
  put(directory, 'package.json', JSON.stringify(runtime.package));
  put(directory, 'package-lock.json', JSON.stringify(runtime.lock));
  const env = buildEnvironment(process.execPath, directory);
  for (const name of [env.HOME, env.TMPDIR]) mkdirSync(name);
  const result = spawnSync(process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
    { cwd: directory, env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const derived = JSON.parse(readFileSync(path.join(directory, 'package-lock.json')));
  assertLockedDependencies(original, derived);
  for (const name of ['tsx', 'esbuild', '@esbuild/darwin-arm64']) {
    assert.ok(derived.packages[`node_modules/${name}`], name);
    assert.notEqual(derived.packages[`node_modules/${name}`].dev, true, name);
  }
  assert.equal(derived.packages['node_modules/typescript'], undefined);
  assert.equal(existsSync(path.join(directory, 'node_modules')), false);
});

test('Electron shell contains only the agreed files and gets separate resources, with official checked downloads', async () => {
  const opts = packagerOptions('/stage/apps/desktop', '/stage', 'a'.repeat(64));
  assert.equal(opts.name, 'Rivet Alpha');
  assert.equal(opts.appBundleId, 'com.rivetfields.rivet.alpha');
  assert.equal(opts.appVersion, '0.1.1');
  assert.equal(opts.electronVersion, '44.9.0');
  assert.equal(opts.arch, 'arm64');
  assert.equal(opts.overwrite, false);
  assert.equal(opts.osxSign, undefined);
  assert.equal(opts.osxNotarize, undefined);
  assert.equal(opts.ignore(''), false);
  for (const file of SHELL_FILES) assert.equal(opts.ignore(`/${file}`), false, file);
  for (const file of ['node_modules', 'node_modules/electron/package.json', 'package-lock.json', '.env', 'output', 'desktop.test.cjs']) assert.equal(opts.ignore(`/${file}`), true, file);
  assert.equal(opts.extraResource, undefined);
  assert.equal(opts.download.unsafelyDisableChecksums, false);
  assert.equal(opts.download.checksums['electron-v44.9.0-darwin-arm64.zip'], 'a'.repeat(64));
  assert.equal(await opts.download.mirrorOptions.resolveAssetURL(), 'https://github.com/electron/electron/releases/download/v44.9.0/electron-v44.9.0-darwin-arm64.zip');
});

test('DMG command is read-only compressed, accepts literal spaces/metacharacters, and has no overwrite/sign flags', () => {
  const source = '/tmp/alpha $(touch nope); staging';
  const output = '/tmp/alpha ; output.dmg';
  assert.deepEqual(dmgArguments(source, output), ['create', '-volname', 'Rivet Alpha', '-srcfolder', source, '-format', 'UDZO', '-fs', 'HFS+', output]);
});

test('inventory records file hashes and internal symlinks and rejects escapes', async t => {
  const directory = temporary(t);
  const bundle = path.join(directory, 'app');
  put(bundle, 'Resources/source.ts', 'current source');
  symlinkSync('source.ts', path.join(bundle, 'Resources/current'));
  const files = await treeInventory(bundle);
  assert.deepEqual(files.find(file => file.type === 'symlink'), { path: 'Resources/current', type: 'symlink', target: 'source.ts' });
  assert.equal(files.find(file => file.type === 'file').sha256, hash('current source'));
  put(directory, 'private');
  symlinkSync('../../private', path.join(bundle, 'Resources/escape'));
  await assert.rejects(treeInventory(bundle), /Escaping bundle symlink/);
});

test('resource copy preserves relocatable dependencies and carries Electron and Node licenses inside the app', async t => {
  const directory = temporary(t);
  const packaged = path.join(directory, 'packaged');
  const app = path.join(packaged, `${RELEASE.name}.app`);
  mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  put(directory, 'backend/node_modules/tsx/dist/cli.mjs');
  mkdirSync(path.join(directory, 'backend/node_modules/.bin'));
  symlinkSync('../tsx/dist/cli.mjs', path.join(directory, 'backend/node_modules/.bin/tsx'));
  put(directory, 'runtime/bin/node');
  put(directory, 'runtime/LICENSE', 'Node license fixture');
  put(packaged, 'LICENSE', 'Electron license fixture');
  put(packaged, 'LICENSES.chromium.html', 'Chromium notices fixture');
  copyRuntimeResources(packaged, directory);
  const files = await treeInventory(app);
  assert.equal(files.find(file => file.path.endsWith('node_modules/.bin/tsx')).target, '../tsx/dist/cli.mjs');
  for (const name of ['runtime/LICENSE', 'licenses/LICENSE', 'licenses/LICENSES.chromium.html']) {
    assert.ok(files.some(file => file.path === `Contents/Resources/${name}`), name);
  }
  assert.throws(() => copyRuntimeResources(packaged, directory), /exists|EEXIST/);
});

test('separate desktop metadata and lock pin the package contract and integrity', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json')));
  const lock = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package-lock.json')));
  assert.equal(pkg.main, 'main.cjs');
  assert.equal(pkg.private, true);
  assert.equal(pkg.version, RELEASE.version);
  assert.equal(pkg.productName, RELEASE.name);
  assert.equal(pkg.devDependencies.electron, RELEASE.electron);
  assert.equal(pkg.devDependencies['@electron/packager'], RELEASE.packager);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  validateLock(lock);
  for (const name of ['electron', '@electron/packager']) assert.equal(lock.packages[`node_modules/${name}`].version, pkg.devDependencies[name]);
});

async function artifact(t) {
  const directory = path.join(temporary(t), 'private alpha ; output');
  const appName = `${RELEASE.name}.app`;
  const app = path.join(directory, appName);
  // All payloads are inert fixtures; neither Electron nor any executable is run.
  for (const name of [`Contents/MacOS/${RELEASE.name}`, 'Contents/Info.plist', 'Contents/Resources/app.asar',
    'Contents/Resources/runtime/bin/node', 'Contents/Resources/runtime/LICENSE',
    'Contents/Resources/backend/apps/server/src/index.ts', 'Contents/Resources/backend/package-lock.json',
    'Contents/Resources/backend/node_modules/tsx/dist/loader.mjs',
    'Contents/Resources/backend/node_modules/@esbuild/darwin-arm64/bin/esbuild',
    'Contents/Resources/backend/dist/web/index.html',
    'Contents/Resources/licenses/LICENSE', 'Contents/Resources/licenses/LICENSES.chromium.html']) put(app, name);
  for (const name of [`Contents/MacOS/${RELEASE.name}`, 'Contents/Resources/runtime/bin/node',
    'Contents/Resources/backend/node_modules/@esbuild/darwin-arm64/bin/esbuild']) chmodSync(path.join(app, name), 0o755);
  const dmgName = `Rivet-Alpha-${RELEASE.version}-darwin-arm64.dmg`;
  const dmg = put(directory, dmgName, 'synthetic DMG, not an installer');
  const files = await treeInventory(app);
  const manifest = { format: 'rivet-private-desktop/v1', distribution: 'private-local-alpha', published: false,
    release: { ...RELEASE }, gitHead: 'a'.repeat(40), uncommittedChanges: true,
    app: { path: appName, files, inventorySha256: hash(JSON.stringify(files)) },
    dmg: { path: dmgName, sha256: await hashFile(dmg) } };
  const record = async () => {
    const file = put(directory, 'manifest.json', JSON.stringify(manifest));
    put(directory, 'SHA256SUMS', `${manifest.dmg.sha256}  ${dmgName}\n${await hashFile(file)}  manifest.json\n`);
  };
  await record();
  return { directory, app, manifest, dmg, record };
}

test('desktop verification checks the existing package manifest and complete bundle without launching or modifying it', async t => {
  const { directory, app, manifest } = await artifact(t);
  const before = await treeInventory(directory);
  const result = await verifyDesktop(directory);
  assert.equal(result.app, app);
  assert.deepEqual(result.manifest, manifest);
  assert.deepEqual(await treeInventory(directory), before);
  await assert.rejects(verifyDesktop('relative/output'), /absolute artifact/);
});

test('verification rejects checksum drift and missing, extra or changed app bytes', async t => {
  for (const mutate of [
    item => put(item.directory, 'manifest.json', '{}'),
    item => put(item.directory, path.basename(item.dmg), 'changed image'),
    item => put(item.app, 'Contents/Resources/backend/dist/web/index.html', 'changed renderer'),
    item => put(item.app, 'Contents/Resources/unrecorded.txt'),
    item => rmSync(path.join(item.app, 'Contents/Resources/runtime/bin/node')),
    item => chmodSync(path.join(item.app, 'Contents/Resources/runtime/bin/node'), 0o644),
  ]) {
    const item = await artifact(t);
    mutate(item);
    await assert.rejects(verifyDesktop(item.directory), /SHA-256 mismatch|inventory changed/);
  }
});

test('a newly hashed inventory cannot hide a missing or non-executable required runtime', async t => {
  for (const mutate of [
    item => rmSync(path.join(item.app, 'Contents/Resources/backend/node_modules/tsx/dist/loader.mjs')),
    item => chmodSync(path.join(item.app, 'Contents/Resources/backend/node_modules/@esbuild/darwin-arm64/bin/esbuild'), 0o644),
  ]) {
    const item = await artifact(t);
    mutate(item);
    item.manifest.app.files = await treeInventory(item.app);
    item.manifest.app.inventorySha256 = hash(JSON.stringify(item.manifest.app.files));
    await item.record();
    await assert.rejects(verifyDesktop(item.directory), /ENOENT|not executable/);
  }
});

test('manifest paths and release metadata cannot redirect launch outside the private package contract', async t => {
  for (const mutate of [
    value => { value.app.path = '../outside.app'; },
    value => { value.dmg.path = '../outside.dmg'; },
    value => { value.published = true; },
    value => { value.release.electron = '999.0.0'; },
    value => { value.gitHead = 'not a source SHA'; },
    value => { value.app.files = []; },
  ]) {
    const item = await artifact(t);
    mutate(item.manifest);
    await item.record();
    await assert.rejects(verifyDesktop(item.directory), /package contract|inventory changed/);
  }
});

test('artifact verification rejects linked output, manifest, app and escaping bundle entries', async t => {
  const output = await artifact(t);
  const alias = path.join(path.dirname(output.directory), 'alias');
  symlinkSync(output.directory, alias);
  await assert.rejects(verifyDesktop(alias), /real directory/);
  for (const name of ['manifest.json', `${RELEASE.name}.app`]) {
    const item = await artifact(t);
    const target = path.join(item.directory, name);
    const original = path.join(path.dirname(item.directory), name);
    if (name.endsWith('.app')) {
      mkdirSync(original);
      rmSync(target, { recursive: true });
    } else {
      put(path.dirname(item.directory), name, readFileSync(target));
      rmSync(target);
    }
    symlinkSync(original, target);
    await assert.rejects(verifyDesktop(item.directory), /linked artifact|real directory/);
  }
  const item = await artifact(t);
  const outside = put(path.dirname(item.directory), 'outside.txt');
  symlinkSync(outside, path.join(item.app, 'Contents/Resources/escape'));
  await assert.rejects(verifyDesktop(item.directory), /Escaping bundle symlink/);
});

test('launch dispatch is literal and credential-free, and never runs before successful integrity verification', async t => {
  const item = await artifact(t);
  const calls = [];
  const run = (...args) => { calls.push(args); };
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    await assert.rejects(launchDesktop(item.directory, run), /native Apple silicon/);
    assert.equal(calls.length, 0);
    return;
  }
  await launchDesktop(item.directory, run);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/usr/bin/open');
  assert.deepEqual(calls[0][1], ['-n', '-a', item.app]);
  assert.deepEqual(Object.keys(calls[0][2].env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
  calls.length = 0;
  put(item.app, 'Contents/Resources/app.asar', 'changed shell');
  await assert.rejects(launchDesktop(item.directory, run), /inventory changed/);
  assert.equal(calls.length, 0);
});
