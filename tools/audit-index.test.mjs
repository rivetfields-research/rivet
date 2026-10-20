import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditIndex } from './audit-index.mjs';
import { SOURCE_SHA } from './export-source.mjs';
import { PUBLICATION_APPROVAL } from './source-license.mjs';

const license = readFileSync(new URL('../LICENSE', import.meta.url));

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'rivet-index-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  const content = '# Synthetic source\n';
  writeFileSync(path.join(root, 'README.md'), content);
  writeFileSync(path.join(root, 'LICENSE'), license);
  writeFileSync(path.join(root, '.git/info/exclude'), 'node_modules/\n.env\n.local-checks/\n');
  writeFileSync(path.join(root, 'SOURCE_MANIFEST.json'), JSON.stringify({ sourceCommit: SOURCE_SHA,
    publicationApproval: PUBLICATION_APPROVAL,
    files: [{ path: 'README.md', sha256: createHash('sha256').update(content).digest('hex') },
      { path: 'LICENSE', sha256: createHash('sha256').update(license).digest('hex') }] }));
  git(root, 'add', '--', 'README.md', 'LICENSE', 'SOURCE_MANIFEST.json');
  return root;
}

test('index audit accepts reviewed source while ignored generated data remains unstaged', t => {
  const root = fixture(t);
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'node_modules/generated.js'), 'synthetic dependency');
  writeFileSync(path.join(root, '.env'), 'SYNTHETIC_FIXTURE=1\n');
  assert.equal(auditIndex(root, { initial: true }).files, 3);
});
test('index audit rejects a force-added ignored dependency', t => {
  const root = fixture(t);
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'node_modules/generated.js'), 'synthetic dependency');
  git(root, 'add', '-f', '--', 'node_modules/generated.js');
  assert.throws(() => auditIndex(root), /Unexpected or missing staged paths/);
});
test('index audit rejects a staged file that differs from the working tree', t => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'README.md'), '# Changed after staging\n');
  assert.throws(() => auditIndex(root), /Staged\/worktree bytes differ/);
});
test('index audit rejects content staged without an updated reviewed hash', t => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'README.md'), '# Unreviewed source\n');
  git(root, 'add', '--', 'README.md');
  assert.throws(() => auditIndex(root), /Unreviewed content/);
});
test('initial audit accepts one root commit and refuses added history', t => {
  const root = fixture(t);
  const commit = () => git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-qm', 'synthetic fixture');
  commit();
  assert.equal(auditIndex(root, { initial: true }).files, 3);
  commit();
  assert.throws(() => auditIndex(root, { initial: true }), /one fresh root commit/);
});

function stageBinary(root, name) {
  const bytes = Buffer.from('GIF89a\x01\0\x01\0\0\0\0;');
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), bytes);
  const manifest = JSON.parse(readFileSync(path.join(root, 'SOURCE_MANIFEST.json'), 'utf8'));
  manifest.addedFiles = [{ path: name, sha256: createHash('sha256').update(bytes).digest('hex') }];
  writeFileSync(path.join(root, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest));
  git(root, 'add', '--', 'SOURCE_MANIFEST.json', name);
}
test('index audit rejects binary media under any unapproved filename even when inventoried', t => {
  const root = fixture(t);
  stageBinary(root, 'docs/media/private.gif');
  assert.throws(() => auditIndex(root), /Forbidden staged path/);
});
test('a media source-manifest entry cannot approve unreviewed GIF bytes by itself', t => {
  const root = fixture(t);
  stageBinary(root, 'docs/media/rivet-workflow.gif');
  assert.throws(() => auditIndex(root), /not approved|byte count mismatch|SHA-256 mismatch/);
});

test('an inventoried product license still requires the exact approved text', t => {
  const root = fixture(t);
  const changed = Buffer.concat([license, Buffer.from('unapproved addition')]);
  writeFileSync(path.join(root, 'LICENSE'), changed);
  const manifest = JSON.parse(readFileSync(path.join(root, 'SOURCE_MANIFEST.json'), 'utf8'));
  manifest.files.find(file => file.path === 'LICENSE').sha256 = createHash('sha256').update(changed).digest('hex');
  writeFileSync(path.join(root, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest));
  git(root, 'add', '--', 'LICENSE', 'SOURCE_MANIFEST.json');
  assert.throws(() => auditIndex(root), /differs from the approved/);
});

test('the index cannot omit the initial source-publication approval', t => {
  const root = fixture(t);
  const manifest = JSON.parse(readFileSync(path.join(root, 'SOURCE_MANIFEST.json'), 'utf8'));
  delete manifest.publicationApproval;
  writeFileSync(path.join(root, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest));
  git(root, 'add', '--', 'SOURCE_MANIFEST.json');
  assert.throws(() => auditIndex(root), /approval is missing or changed/);
});
