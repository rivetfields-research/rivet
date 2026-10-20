#!/usr/bin/env node
// Read Git objects only; never copy the checkout or its history.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SOURCE_SHA = '1574d8b7533b0f63e0b882c36b346e03ffea913d';
export const TEST_FILES = [
  'scripts/desktop-main.test.mjs', 'scripts/desktop-runtime.test.mjs',
  'scripts/desktop-setup.test.mjs', 'scripts/package-desktop.test.mjs',
  'apps/server/src/desktop-access.test.ts',
  'packages/core/src/provider.test.ts', 'packages/core/src/calculation-recovery.test.ts',
  'packages/core/src/source-scope.test.ts', 'packages/core/src/context-budget.test.ts',
  'packages/core/src/credential-vault.test.ts', 'packages/core/src/file-import.test.ts',
  'packages/data-layer/src/csv.test.ts', 'packages/data-layer/src/tabular-ranking.test.ts',
  'packages/data-layer/src/tabular-filters.test.ts', 'packages/data-layer/src/tabular-labels.test.ts',
  'packages/data-layer/src/source-semantics.test.ts',
  'packages/presentation/src/weekly-review-email.test.ts',
  'apps/web/src/draft-store.test.tsx', 'apps/web/src/tabular-interpretation.test.tsx',
  'apps/web/src/report-takeaways.test.tsx', 'apps/web/src/agent-session-evidence.test.tsx',
];
const EXACT = [
  'package.json', 'package-lock.json', 'tsconfig.json', '.nvmrc', 'THIRD_PARTY_NOTICES.txt',
  'apps/web/index.html', 'apps/web/vite.config.ts',
  ...['package.json', 'package-lock.json', 'main.cjs', 'runtime.cjs', 'preload.cjs',
    'setup.html', 'setup.css', 'setup.js'].map(name => `apps/desktop/${name}`),
  'scripts/package-desktop.mjs',
];
const PREFIXES = ['apps/server/src/', 'apps/web/src/', 'packages/core/src/',
  'packages/data-layer/src/', 'packages/presentation/src/'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function runGit(source, args) {
  const result = spawnSync('/usr/bin/git', ['-C', source, ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Git object read failed: ${args[0]}`);
  return result.stdout;
}

export function exportSource(source, destination, typescriptPath) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (destination === source || destination.startsWith(`${source}${path.sep}`)) throw new Error('Export must be outside the source checkout.');
  const ts = createRequire(import.meta.url)(typescriptPath);
  const tree = runGit(source, ['ls-tree', '-r', '-z', '--full-tree', SOURCE_SHA]).toString().split('\0').filter(Boolean);
  const entries = new Map(tree.map(record => {
    const [meta, name] = record.split('\t');
    const [mode, type, blob] = meta.split(' ');
    return [name, { mode, type, blob }];
  }));
  const cache = new Map();
  const bytes = name => {
    if (!cache.has(name)) {
      const entry = entries.get(name);
      if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`Non-regular or missing tracked file: ${name}`);
      const value = runGit(source, ['cat-file', 'blob', entry.blob]);
      if (value.length > 8 * 1024 * 1024 || value.includes(0)) throw new Error(`Non-text or oversized source: ${name}`);
      cache.set(name, value);
    }
    return cache.get(name);
  };
  const selected = new Set(EXACT);
  const graph = {};
  function visit(name) {
    if (Object.hasOwn(graph, name)) return;
    const text = bytes(name).toString('utf8');
    selected.add(name);
    graph[name] = [];
    if (!/\.(?:[cm]?[jt]sx?)$/.test(name)) return;
    const info = ts.preProcessFile(text, true, true);
    for (const { fileName: specifier } of info.importedFiles) {
      if (!specifier.startsWith('.')) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
      const resolved = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`].find(p => entries.has(p));
      if (!resolved || resolved.startsWith('../')) throw new Error(`Unresolved tracked import in ${name}`);
      if (!PREFIXES.some(prefix => resolved.startsWith(prefix)) && !EXACT.includes(resolved) && !TEST_FILES.includes(resolved)) {
        throw new Error(`Import crosses the curated source boundary: ${name} -> ${resolved}`);
      }
      graph[name].push(resolved);
      visit(resolved);
    }
  }
  for (const name of ['apps/server/src/index.ts', 'apps/web/src/main.tsx', ...TEST_FILES]) visit(name);
  for (const name of EXACT) if (/\.(?:[cm]?[jt]sx?)$/.test(name)) visit(name);
  const files = [];
  for (const name of [...selected].sort()) {
    if (name.split('/').some(part => !part || part === '..' || (part.startsWith('.') && name !== '.nvmrc'))) throw new Error(`Unsafe path: ${name}`);
    const content = bytes(name);
    const target = path.join(destination, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: 'wx', mode: 0o644 });
    files.push({ path: name, gitBlob: entries.get(name).blob, sha256: digest(content), bytes: content.length });
  }
  const manifest = {
    format: 'rivet-desktop-source-candidate/v1', sourceCommit: SOURCE_SHA,
    method: 'git ls-tree + cat-file; TypeScript import closure; exact ancillary/test list',
    trackedFileCount: entries.size, exportedFileCount: files.length,
    excludedTrackedFileCount: entries.size - files.length,
    exclusions: ['Git history and metadata', 'operational and deployment records/configuration',
      'external fixtures and evaluation datasets', 'customer/tester documents and identifiers',
      'public brand/logo assets and invitation pages', 'generated builds/data and secrets',
      'hosted launchers and unrelated tests/tooling'],
    files, importGraph: graph,
    rightsStatus: 'UNLICENSED; local review only; no content or rights certification',
  };
  writeFileSync(path.join(destination, 'SOURCE_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ destination, sourceCommit: SOURCE_SHA, files: files.length, excluded: entries.size - files.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [source, destination, typescriptPath] = process.argv.slice(2);
  if (!source || !destination || !typescriptPath) throw new Error('Usage: node tools/export-source.mjs SOURCE NEW_DESTINATION ABSOLUTE_TYPESCRIPT_MODULE');
  exportSource(source, destination, typescriptPath);
}
