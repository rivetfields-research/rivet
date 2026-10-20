import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = name => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const write = (name, value) => writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n');
const pkg = read('package.json');
pkg.name = 'rivet';
pkg.description = 'Open-source local social and data analyst desktop alpha';
pkg.version = '0.1.0-alpha.1';
pkg.private = true;
pkg.license = 'Apache-2.0';
pkg.scripts = {
  'check:source': 'node tools/check-source.mjs',
  'audit:staged': 'node tools/audit-index.mjs',
  typecheck: 'node tools/check.mjs typecheck',
  test: 'node tools/check.mjs test',
  build: 'node tools/check.mjs build',
  check: 'node tools/check.mjs all',
  'desktop:package': 'node scripts/package-desktop.mjs',
  'desktop:verify': 'node scripts/package-desktop.mjs --verify',
  'desktop:launch': 'node scripts/package-desktop.mjs --launch',
};
pkg.devDependencies.vite = '8.3.4';
delete pkg.devDependencies['@playwright/test'];
delete pkg.devDependencies['@stripe/cli'];
delete pkg.dependencies.stripe;
delete pkg.dependencies.svix;
write('package.json', pkg);
const lock = read('package-lock.json');
lock.name = pkg.name;
lock.version = pkg.version;
Object.assign(lock.packages[''], { name: pkg.name, version: pkg.version, license: pkg.license,
  dependencies: pkg.dependencies, devDependencies: pkg.devDependencies });
write('package-lock.json', lock);
const shell = read('apps/desktop/package.json');
shell.license = pkg.license;
shell.description = 'Local Rivet Alpha desktop shell';
shell.scripts = { test: 'node ../../tools/check.mjs test' };
write('apps/desktop/package.json', shell);
const shellLock = read('apps/desktop/package-lock.json');
shellLock.packages[''].license = shell.license;
write('apps/desktop/package-lock.json', shellLock);
