import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

const root = fileURLToPath(new URL('..', import.meta.url));
const repository = 'https://github.com/rivetfields-research/rivet';
const entries = ['README.md', 'CONTRIBUTING.md'];
const parse = name => unified().use(remarkParse).parse(readFileSync(path.join(root, name), 'utf8'));
function* nodes(node) {
  yield node;
  for (const child of node.children ?? []) yield* nodes(child);
}
const text = node => node.value ?? node.alt ?? (node.children ?? []).map(text).join('');
const links = tree => [...nodes(tree)].filter(node => ['link', 'image', 'definition'].includes(node.type));
function headings(tree) {
  const counts = new Map();
  return [...nodes(tree)].filter(node => node.type === 'heading').map(node => {
    const slug = text(node).toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  });
}

test('README offers named star, contribution and bug-report links before the preview', () => {
  const tree = parse('README.md');
  const preview = [...nodes(tree)].find(node => node.type === 'image');
  assert(preview, 'Keep the reviewed workflow preview');
  const actions = links(tree).filter(node => node.type === 'link' && node.position.start.offset < preview.position.start.offset);
  assert(actions.some(node => /star/i.test(text(node)) && node.url === repository), 'A named link should lead to the repository Star control');
  assert(actions.some(node => /contribut/i.test(text(node)) && node.url === '#your-first-contribution'), 'Make the first-contribution path easy to find');
  const report = actions.find(node => /report.*issue/i.test(text(node)));
  assert(report, 'A named report-issue link should open the bug template');
  const url = new URL(report.url);
  assert.equal(`${url.origin}${url.pathname}`, `${repository}/issues/new`);
  assert.equal(url.searchParams.get('template'), 'bug_report.md');
  assert(existsSync(path.join(root, '.github/ISSUE_TEMPLATE', url.searchParams.get('template'))));
});

test('developer-entry links resolve to repository files and existing Markdown headings', () => {
  for (const name of entries) {
    for (const node of links(parse(name))) {
      if (/^(?:https?:|mailto:)/i.test(node.url)) continue;
      const url = new URL(node.url, `https://repository.invalid/${name}`);
      assert.equal(url.origin, 'https://repository.invalid', `Unexpected link scheme in ${name}: ${node.url}`);
      const target = decodeURIComponent(url.pathname.slice(1));
      assert(existsSync(path.join(root, target)), `Missing link in ${name}: ${node.url}`);
      if (url.hash && target.endsWith('.md')) {
        assert(headings(parse(target)).includes(decodeURIComponent(url.hash.slice(1))), `Missing heading in ${name}: ${node.url}`);
      }
    }
  }
});

test('documented source-check commands exist and the first PR includes provenance and index review', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const name of entries) {
    const commands = [...nodes(parse(name))].filter(node => node.type === 'code' && node.lang === 'sh').map(node => node.value).join('\n');
    for (const match of commands.matchAll(/\bnpm run ([\w:-]+)/g)) {
      assert(Object.hasOwn(pkg.scripts, match[1]), `Unknown npm command in ${name}: ${match[0]}`);
    }
    if (name === 'CONTRIBUTING.md') {
      for (const command of ['npm ci --ignore-scripts --no-audit --no-fund', 'npm run check',
        'node tools/record-provenance.mjs', 'npm run audit:staged', 'git diff --cached --check']) {
        assert(commands.split('\n').includes(command), `Missing first-PR check: ${command}`);
      }
      assert(existsSync(path.join(root, 'tools/record-provenance.mjs')));
    }
  }
});
