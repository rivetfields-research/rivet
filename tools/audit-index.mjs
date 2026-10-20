import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_SHA } from './export-source.mjs';
import { isReferenceMediaPath, validateReferenceMedia } from './reviewed-media.mjs';
import { validateProductLicense, validatePublicationApproval } from './source-license.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function git(root, args, optional = false) {
  const result = spawnSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });
  if (optional && result.status !== 0) return null;
  assert.equal(result.status, 0, `Git audit command failed: ${args[0]}`);
  return result.stdout;
}

export function auditIndex(root, { initial = false } = {}) {
  root = realpathSync(root);
  const metadata = lstatSync(path.join(root, '.git'));
  assert(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Audit requires an independent Git directory');
  assert.equal(realpathSync(git(root, ['rev-parse', '--show-toplevel']).toString().trim()), root);
  const manifest = JSON.parse(readFileSync(path.join(root, 'SOURCE_MANIFEST.json'), 'utf8'));
  validatePublicationApproval(manifest.publicationApproval);
  assert.equal(manifest.sourceCommit, SOURCE_SHA);
  const changes = new Map((manifest.localChanges ?? []).map(file => [file.path, file.sha256]));
  const expected = new Map(manifest.files.map(file => [file.path, changes.get(file.path) ?? file.sha256]));
  for (const file of manifest.addedFiles ?? []) {
    assert(!expected.has(file.path), 'Duplicate manifest path');
    expected.set(file.path, file.sha256);
  }
  expected.set('SOURCE_MANIFEST.json', null);
  assert(expected.has('LICENSE'), 'The approved product LICENSE is required');
  const entries = git(root, ['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean).map(record => {
    const [header, name] = record.split('\t');
    const [mode, blob, stage] = header.split(' ');
    return { name, mode, blob, stage };
  });
  assert.deepEqual(entries.map(file => file.name).sort(), [...expected.keys()].sort(), 'Unexpected or missing staged paths');
  let totalBytes = 0;
  for (const { name, mode, blob, stage } of entries) {
    assert.equal(stage, '0', 'Unmerged index entry');
    assert.equal(mode, '100644', `Only regular non-executable source files may be staged: ${name}`);
    assert(!/[\\\x00-\x1f\x7f]/.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe staged path');
    assert(!/(^|\/)(?:\.git|\.env(?:\..*)?|node_modules|dist|\.local-checks|\.data|infra|fixtures|evals|screenshots|test-results|outputs|credentials)(?:\/|$)/.test(name), `Forbidden staged path: ${name}`);
    if (!isReferenceMediaPath(name)) assert(!/\.(?:log|sqlite(?:-.*)?|db|key|pem|p12|pfx|dmg|zip|png|jpe?g|webp|gif|mp4)$/.test(name), `Forbidden staged path: ${name}`);
    assert(lstatSync(path.join(root, name)).isFile() && realpathSync(path.join(root, name)) === path.join(root, name), 'Staged source is linked or missing');
    const bytes = git(root, ['cat-file', 'blob', blob]);
    if (/(^|\/)LICENSE(?:\.[^/]+)?$/.test(name)) validateProductLicense(name, bytes);
    assert(bytes.equals(readFileSync(path.join(root, name))), `Staged/worktree bytes differ: ${name}`);
    if (isReferenceMediaPath(name)) validateReferenceMedia(name, bytes);
    else assert(bytes.length < 8 * 1024 * 1024 && !bytes.includes(0), `Non-text or oversized staged file: ${name}`);
    if (expected.get(name)) assert.equal(sha256(bytes), expected.get(name), `Unreviewed content: ${name}`);
    assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bAKIA[A-Z0-9]{16}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/.test(bytes.toString('utf8')), `Potential credential material: ${name}`);
    assert.equal(git(root, ['check-ignore', '--no-index', '--', name], true), null, `Ignored file is staged: ${name}`);
    totalBytes += bytes.length;
  }
  if (initial) {
    const head = git(root, ['rev-parse', '--verify', 'HEAD'], true);
    if (head) {
      assert.equal(git(root, ['rev-list', '--all', '--count']).toString().trim(), '1', 'Initial history must contain one fresh root commit');
      assert.equal(git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).toString().trim().split(' ').length, 1, 'Initial commit must not have a parent');
    } else assert.equal(git(root, ['show-ref'], true), null, 'Unexpected refs before initial commit');
    assert.equal(git(root, ['cat-file', '-e', `${SOURCE_SHA}^{commit}`], true), null, 'Original private history must not be present');
  }
  return { files: entries.length, bytes: totalBytes, initial, sourceCommit: SOURCE_SHA };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && args[0] === '--initial'), 'Usage: node tools/audit-index.mjs [--initial]');
  console.log(JSON.stringify(auditIndex(fileURLToPath(new URL('..', import.meta.url)), { initial: args.includes('--initial') })));
}
