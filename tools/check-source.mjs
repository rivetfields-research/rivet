import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_SHA } from './export-source.mjs';
import { validateLock } from '../scripts/package-desktop.mjs';
import { isReferenceMediaPath, validateReferenceMedia } from './reviewed-media.mjs';
import { SOURCE_LICENSE, validateProductLicense, validatePublicationApproval } from './source-license.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const json = name => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const manifest = json('SOURCE_MANIFEST.json');
validatePublicationApproval(manifest.publicationApproval);
assert.equal(manifest.sourceCommit, SOURCE_SHA);
assert.equal(manifest.files.length, manifest.exportedFileCount);
const changes = new Map((manifest.localChanges ?? []).map(file => [file.path, file]));
const expected = new Map(manifest.files.map(file => [file.path, changes.get(file.path)?.sha256 ?? file.sha256]));
for (const file of manifest.addedFiles ?? []) {
  assert(!expected.has(file.path), 'Added file duplicates upstream provenance');
  expected.set(file.path, file.sha256);
}
expected.set('SOURCE_MANIFEST.json', null);
assert(expected.has('LICENSE'), 'The approved product LICENSE is required');
const ignored = new Set(['node_modules', 'dist', '.local-checks']);
const files = [];
function walk(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    assert(!entry.isSymbolicLink(), `Linked candidate path: ${name}`);
    if (!prefix && entry.name === '.git' && entry.isDirectory()) continue;
    if (entry.isDirectory() && ((!prefix && ignored.has(entry.name)) || name === 'apps/desktop/node_modules')) continue;
    assert(!/(^|\/)(?:\.git|\.env(?:\..*)?|\.data|infra|fixtures|evals|screenshots|credentials)(?:\/|$)/.test(name), `Forbidden path: ${name}`);
    if (entry.isDirectory()) walk(path.join(directory, entry.name), `${name}/`);
    else { assert(entry.isFile(), `Non-regular path: ${name}`); files.push(name); }
  }
}
walk(root);
assert.deepEqual(files.sort(), [...expected.keys()].sort(), 'Unexpected or missing source paths');
for (const name of files) {
  assert(!name.startsWith('apps/web/public/'), 'Public artwork/assets are excluded');
  const content = readFileSync(path.join(root, name));
  if (/(^|\/)LICENSE(?:\.[^/]+)?$/.test(name)) validateProductLicense(name, content);
  if (isReferenceMediaPath(name)) validateReferenceMedia(name, content);
  else {
    assert(lstatSync(path.join(root, name)).size < 8 * 1024 * 1024, `Oversized source: ${name}`);
    assert(!content.includes(0), `Binary content: ${name}`);
  }
  if (expected.get(name)) assert.equal(createHash('sha256').update(content).digest('hex'), expected.get(name), `Unrecorded edit: ${name}`);
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bAKIA[A-Z0-9]{16}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/.test(content.toString('utf8')), `Potential credential material: ${name}`);
}
for (const directory of ['', 'apps/desktop/']) {
  const pkg = json(`${directory}package.json`), lock = json(`${directory}package-lock.json`);
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, SOURCE_LICENSE);
  assert.equal(lock.packages[''].license, SOURCE_LICENSE);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  validateLock(lock);
}
for (const [name, dependencies] of Object.entries(manifest.importGraph)) {
  assert(expected.has(name), `Missing graph node: ${name}`);
  for (const dependency of dependencies) assert(expected.has(dependency), `Missing import: ${dependency}`);
}
const localRecords = new Map([...(manifest.localChanges ?? []), ...(manifest.addedFiles ?? [])].map(file => [file.path, file]));
for (const batch of manifest.workingTreeImports ?? []) {
  assert.equal(batch.repository, 'rivetfields-research/harness');
  assert.match(batch.sourceHead, /^[0-9a-f]{40}$/);
  for (const captured of batch.files) {
    const record = localRecords.get(captured.path);
    assert(record && expected.has(captured.path), `Unrecorded working-tree import: ${captured.path}`);
    assert.equal(record.origin?.kind, 'parent-working-tree');
    assert.equal(record.origin.repository, batch.repository);
    assert.equal(record.origin.sourceHead, batch.sourceHead);
    assert.equal(record.origin.capturedSha256, captured.sha256);
    if (record.sha256 !== captured.sha256) assert(record.transformations?.length > 0, `Undocumented port transformation: ${captured.path}`);
  }
}
console.log(`Source boundary: ${files.length} inventoried files; provenance, approved Apache-2.0 metadata and selected credential/path checks passed.`);
console.log('This heuristic check does not certify rights, complete content safety or public readiness.');
