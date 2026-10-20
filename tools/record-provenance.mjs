// Record only the reviewed staging overlays; unexpected paths fail closed.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReferenceMediaPath, validateReferenceMedia } from './reviewed-media.mjs';
import { PUBLICATION_APPROVAL } from './source-license.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = path.join(root, 'SOURCE_MANIFEST.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const parentImport = {
  "repository": "rivetfields-research/harness",
  "sourceHead": "1574d8b7533b0f63e0b882c36b346e03ffea913d",
  "state": "working-tree snapshot; these file contents are not claimed as blobs from sourceHead",
  "files": [
    {
      "path": "apps/web/src/connection-model.ts",
      "sha256": "e906f42405439b15fedde1f9763e97746f31a9c4d32b366b1c79a1223b69be8b"
    },
    {
      "path": "apps/web/src/source-connect-page.tsx",
      "sha256": "16129cf3c3828fc2ec7fa60e24b76f7acdb8fd828a8b15aeedfba922622f1e11"
    },
    {
      "path": "apps/web/src/source-connect-page.css",
      "sha256": "daa38f6d6e65894062d925b8f700109f43986e14633e672277def359a30732d2"
    },
    {
      "path": "apps/web/src/tables-library.tsx",
      "sha256": "f76f4d96a1ddf483498c6d8b223e643f884dc3f6bbf24c21fdd983290bc7e032"
    },
    {
      "path": "apps/web/src/workspace.tsx",
      "sha256": "32e60ef23e468d8c61829c7a1ea01c151b159f3674b373c35b0df860f59599a1"
    },
    {
      "path": "apps/web/src/desktop-model-notice.tsx",
      "sha256": "7771b7ce91743804b0d99cd8f19c6e6a65f34571fc1d598eddf20716e93874c2"
    },
    {
      "path": "apps/web/src/desktop-model-notice.test.tsx",
      "sha256": "9ff56cb8f90d9b4fbf91ec283fa536c9a8ea10e1862d9538b69fb5b16e93b6ae"
    },
    {
      "path": "apps/server/src/http.ts",
      "sha256": "97c134a7f48bb58fa2be89b2574a040467e5f254a5bfb697ea0e62e268fcaeb0"
    },
    {
      "path": "apps/server/src/desktop-access.test.ts",
      "sha256": "d3e3c727f8efcde48d6090b9cafe8df0a3cf1e8505c2fedef55728984c22b9f1"
    },
    {
      "path": "apps/server/src/index.ts",
      "sha256": "27e1d72f6793e4879ead2a4e1bdfef30c716da070bbcafa23299ead9562e8500"
    },
    {
      "path": "packages/core/src/index.ts",
      "sha256": "01707fbd80425a6d936ed116d0e84b8e74dfd5f31478078a7d0e9e84154a4926"
    },
    {
      "path": "packages/core/src/provider.ts",
      "sha256": "712d04a26061f2ecb474ecddd4b99f48ee08906aefc48bef46793816cf6558e0"
    },
    {
      "path": "packages/core/src/provider.test.ts",
      "sha256": "64f91a80aed4bf5a18dc7c7e72af4fced3612b78811036b92c9e418e4cb7b12e"
    },
    {
      "path": "packages/core/src/tabular-followup.ts",
      "sha256": "8fedb82a99cda7b4b1f9419c87faf4e715043e1b56de70ba0bd46a7b7911a49a"
    },
    {
      "path": "packages/core/src/types.ts",
      "sha256": "65b10de7b83970b2bd9a8a7d42e1b6dbb7ca03a265e169d5487eee047a58f2b0"
    },
    {
      "path": "apps/desktop/main.cjs",
      "sha256": "7c2cc24d4613b171b32ec13d12743b2cfcaae7ad66a2afdf28010b174d9c9632"
    },
    {
      "path": "apps/desktop/workspace-preload.cjs",
      "sha256": "49395d976e88876918049ecb46e1d65736ceacc34b63eb4b13b95354d66e9217"
    },
    {
      "path": "scripts/desktop-main.test.mjs",
      "sha256": "5de9732cf975018c55c4f2ee017c685d4ec4058a2cc93b0280d0fea049371836"
    },
    {
      "path": "apps/web/src/source-connect-options.test.tsx",
      "sha256": "3349b35dcea3125e2bf3874b19e190b12e559b66dbdedc965f9951fa5495dea2"
    },
    {
      "path": "apps/web/src/tables-library.test.tsx",
      "sha256": "f7e59471333fcd5821b2ac5d8789980a7b6f69477f64088c3c0b6b5acb0c8150"
    }
  ]
};
const parentFiles = new Map(parentImport.files.map(file => [file.path, file]));
const reasons = new Map(Object.entries({
  '.nvmrc': 'Pin source checks and CI to the tested Node 24.19.0 runtime.',
  ...Object.fromEntries(parentImport.files.map(file => [file.path,
    'Port the approved parent working-tree desktop capability, catalog/model-settings UI and associated tests; original pinned blob provenance remains unchanged.'])),
  ...Object.fromEntries(['apps/server/src/index.ts', 'apps/server/src/desktop-access.test.ts',
    'packages/core/src/index.ts', 'packages/core/src/provider.ts', 'packages/core/src/provider.test.ts',
    'packages/core/src/tabular-followup.ts'].map(name => [name,
    'Port the tested r3 desktop JSON-object output, bounded selected-dataset recovery and explicit publication-period checks; preserve parser, permission, action and time limits.'])),
  'package.json': 'Owner-approved Apache-2.0 source-alpha metadata with npm publication disabled; isolated checks and private package/verify/launch commands; patch Vite to 8.3.4; omit unused browser/Stripe CLI tools and unimported Stripe/Svix hosted SDKs.',
  'package-lock.json': 'Synchronize approved Apache-2.0 source-alpha metadata, prune unused tools/hosted SDKs and lock Vite 8.3.4 with required development-toolchain updates; preserve unrelated resolutions/integrities.',
  'apps/desktop/package.json': 'Apply the owner-approved Apache-2.0 source license, keep npm publication disabled and expose only isolated contributor tests.',
  'apps/desktop/package-lock.json': 'Synchronize the owner-approved Apache-2.0 source license; preserve locked desktop runtime versions/integrities.',
  'apps/web/index.html': 'Remove reference to excluded product favicon artwork.',
  'apps/web/src/platform-icon.tsx': 'Use existing Lucide Cable icon in place of excluded public brand artwork.',
  'apps/web/src/connectors.tsx': 'Use existing Lucide Cable icon in place of excluded Google Drive artwork.',
  'apps/web/src/team-admin.tsx': 'Remove one inherited trailing-whitespace-only line for the initial staged-source check; no runtime behavior change.',
  'scripts/package-desktop.mjs': 'Keep the curated ancillary allowlist, omitted assets/fixtures/helpers and workspace preload; preserve approved LICENSE/NOTICE in local packages; verify the complete app inventory and DMG before normal macOS launch with no security bypass.',
  'scripts/package-desktop.test.mjs': 'Cover exact packaging commands, retained product notices, artifact integrity, executable runtimes, safe paths and inert launch dispatch; retain the narrow source boundary and generic brand fixture names.',
  'packages/presentation/src/weekly-review-email.test.ts': 'Replace a person-shaped example email with a generic fictional address.',
}));
const added = new Set([
  '.gitignore', 'AGENTS.md', 'CONTRIBUTING.md', 'README.md', 'SECURITY.md', 'SOURCE_BOUNDARY.md',
  'tools/export-source.mjs', 'tools/configure-candidate.mjs', 'tools/record-provenance.mjs',
  'tools/check.mjs', 'tools/check-source.mjs', 'tools/offline-guard.mjs', 'tools/offline-guard.test.mjs',
  'tools/audit-index.mjs', 'tools/audit-index.test.mjs',
  '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md',
  '.github/pull_request_template.md', '.github/workflows/checks.yml',
  'apps/web/src/desktop-model-notice.tsx', 'apps/web/src/desktop-model-notice.test.tsx',
  'apps/desktop/workspace-preload.cjs', 'apps/web/src/source-connect-options.test.tsx', 'apps/web/src/tables-library.test.tsx',
  'packages/core/src/desktop-report.test.ts',
  'LICENSE', 'NOTICE', 'CHANGELOG.md', 'tools/source-license.mjs', 'tools/source-license.test.mjs',
  'tools/reviewed-media.mjs', 'tools/reviewed-media.test.mjs',
  'docs/media/rivet-workflow.gif', 'docs/media/rivet-workflow.mp4',
]);
const original = new Map(manifest.files.map(file => [file.path, file]));
const changes = [], additions = [];
function walk(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (!prefix && entry.name === '.git' && entry.isDirectory()) continue;
    if (entry.isDirectory() && ((!prefix && ['node_modules', 'dist', '.local-checks'].includes(entry.name)) || name === 'apps/desktop/node_modules')) continue;
    if (entry.isSymbolicLink()) throw new Error(`Linked source: ${name}`);
    if (entry.isDirectory()) { walk(path.join(directory, entry.name), `${name}/`); continue; }
    if (name === 'SOURCE_MANIFEST.json') continue;
    const bytes = readFileSync(path.join(root, name));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const media = isReferenceMediaPath(name) ? validateReferenceMedia(name, bytes) : null;
    if (original.has(name)) {
      if (original.get(name).sha256 !== hash) {
        if (!reasons.has(name)) throw new Error(`Unexpected upstream edit: ${name}`);
        changes.push({ path: name, sha256: hash, reason: reasons.get(name),
          ...(parentFiles.has(name) ? { origin: { kind: 'parent-working-tree', repository: parentImport.repository,
            sourceHead: parentImport.sourceHead, capturedSha256: parentFiles.get(name).sha256 } } : {}) });
      }
    } else {
      if (!added.has(name)) throw new Error(`Unexpected added file: ${name}`);
      additions.push({ path: name, sha256: hash,
        ...(media ? { bytes: media.bytes, mediaType: media.mediaType,
          origin: { kind: 'reviewed-reference-media', reviewedSha256: media.sha256,
            source: 'Parent-reviewed final export; raw frames, metadata and private crops excluded.',
            approvalScope: 'Owner-approved public source inclusion, including media rights, on 2026-10-20.',
            capture: 'Edited hosted UI using a 240-row QA/sample social CSV; not verified live-account performance, completed OAuth, native-desktop parity or email-delivery proof.' } } : {}),
        ...(name === 'apps/web/src/source-connect-options.test.tsx' ? {
          transformations: ['Replace three upstream artwork expectations with assertions for the retained generic Cable icons and absence of excluded brand images.'] } : {}),
        ...(parentFiles.has(name) ? { origin: { kind: 'parent-working-tree', repository: parentImport.repository,
          sourceHead: parentImport.sourceHead, capturedSha256: parentFiles.get(name).sha256 } } : {}) });
    }
  }
}
walk(root);
manifest.localChanges = changes.sort((a, b) => a.path.localeCompare(b.path));
manifest.addedFiles = additions.sort((a, b) => a.path.localeCompare(b.path));
manifest.workingTreeImports = [parentImport];
manifest.rightsStatus = 'Apache-2.0; repository owner confirmed rights for included source, examples and reviewed demo media on 2026-10-20; third-party licenses retained';
manifest.publicationApproval = PUBLICATION_APPROVAL;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Recorded ${changes.length} staging edits and ${additions.length} added source/support files.`);
