import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_FILES } from './export-source.mjs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
if (!/^24\./.test(process.versions.node)) throw new Error('Use Node 24 for candidate checks.');
const work = path.join(root, '.local-checks');
for (const name of ['home', 'tmp', 'cache', 'data', 'sources']) mkdirSync(path.join(work, name), { recursive: true, mode: 0o700 });
const env = {
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: path.join(work, 'home'),
  TMPDIR: path.join(work, 'tmp'), XDG_CACHE_HOME: path.join(work, 'cache'), LANG: 'en_US.UTF-8', CI: '1',
  npm_config_cache: path.join(work, 'cache/npm'), npm_config_userconfig: '/dev/null', npm_config_globalconfig: path.join(work, 'absent-global-npmrc'),
  ELECTRON_SKIP_BINARY_DOWNLOAD: '1', npm_execpath: process.env.npm_execpath,
  HARNESS_DATA_DIR: path.join(work, 'data'), HARNESS_SOURCE_DIR: path.join(work, 'sources'),
  HARNESS_CONNECTIONS_ENABLED: '0', HARNESS_REPORT_EMAIL_MODE: 'off', HARNESS_BILLING_MODE: 'off', HARNESS_ORG_ADMIN: '0',
  // Disposable Git fixtures must not discover the enclosing private workspace.
  GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const guard = fileURLToPath(new URL('./offline-guard.mjs', import.meta.url));
const phases = {
  source: ['tools/check-source.mjs'],
  typecheck: ['node_modules/typescript/bin/tsc', '--noEmit'],
  test: ['--import', guard, '--import', import.meta.resolve('tsx'), '--test', '--test-concurrency=4',
    '--test-reporter=spec', ...TEST_FILES, 'tools/offline-guard.test.mjs', 'tools/audit-index.test.mjs', 'tools/reviewed-media.test.mjs',
    'apps/web/src/desktop-model-notice.test.tsx', 'apps/web/src/source-connect-options.test.tsx', 'apps/web/src/tables-library.test.tsx',
    'packages/core/src/desktop-report.test.ts', 'tools/source-license.test.mjs'],
  build: ['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts'],
};
const requested = process.argv[2] ?? 'all';
const names = requested === 'all' ? Object.keys(phases) : [requested];
for (const name of names) {
  if (!phases[name]) throw new Error('Expected all, source, typecheck, test or build.');
  console.log(`Candidate check: ${name}`);
  const result = spawnSync(process.execPath, phases[name], { cwd: root, env, stdio: 'inherit', timeout: 240_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
