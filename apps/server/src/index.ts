import path from 'node:path';
import { existsSync } from 'node:fs';
import { createGoogleDrive } from '../../../packages/core/src/google-drive.ts';
import { createHarness, createSyncLimiter, credentialKeysFromEnv } from '../../../packages/core/src/index.ts';
import { createApiServer } from './http.ts';
import { desktopAccessFromEnv } from './desktop-access.ts';
import { createCareService } from '../../../packages/core/src/care.ts';
import { careFixtures } from '../../../packages/core/src/care-fixtures.ts';
import { createOrganizationAdmin } from './organizations-http.ts';
import { metaProviderFromEnv } from './meta-config.ts';
import { apifyEnabledFromEnv } from './apify-config.ts';
import { sourceAdaptersFromEnv } from './source-provider-config.ts';
import { reportEmailSenderFromEnv } from './report-email-sender.ts';
import { validReportEmailRecipient } from '../../../packages/core/src/report-email.ts';
import { composeWeeklyReviewEmail } from '../../../packages/presentation/src/weekly-review-email.ts';

// A desktop launch must not restore credentials or features stripped by its parent.
if (process.env.HARNESS_DESKTOP !== '1' && existsSync('.env')) process.loadEnvFile('.env');
const desktop = desktopAccessFromEnv(process.env);
if (desktop && typeof process.send !== 'function') throw new Error('Desktop mode requires a parent IPC channel.');
const port = Number(process.env.HARNESS_PORT ?? '4310');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('HARNESS_PORT must be between 1024 and 65535.');
const profile = process.env.HARNESS_PROFILE || 'workspace-analyst';
if (profile !== 'workspace-analyst' && profile !== 'healthcare-operations') throw new Error('HARNESS_PROFILE must be workspace-analyst or healthcare-operations.');
// Storage and feature settings are read once at startup; an invalid value never starts the server.
function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return parsed;
}
function flagEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value !== '0' && value !== '1') throw new Error(`${name} must be 0 or 1.`);
  return value === '1';
}
const tabularLimits = {
  snapshots: integerEnv('HARNESS_TABULAR_SNAPSHOT_LIMIT', 50, 1, 500),
  bytes: integerEnv('HARNESS_TABULAR_BYTES_LIMIT', 10 * 1024 * 1024, 1024 * 1024, 200 * 1024 * 1024),
};
const connectionLimits = {
  connections: integerEnv('HARNESS_CONNECTION_LIMIT', 25, 1, 200),
  versions: integerEnv('HARNESS_CONNECTION_VERSION_LIMIT', 500, 1, 10_000),
};
// Local development is single-user; connections default on here and off in hosted mode (N-3).
const connectionsEnabled = !desktop && flagEnv('HARNESS_CONNECTIONS_ENABLED', true);
// Installation-wide: at most this many syncs run at once in this process (D-6).
const syncConcurrency = integerEnv('HARNESS_SYNC_CONCURRENCY', 1, 1, 8);
// M8: Meta (Instagram, Facebook Pages) only when HARNESS_CONNECTOR_INSTAGRAM or HARNESS_CONNECTOR_FACEBOOK is 1 (default 0).
// Its local sign-in returns to http://localhost:<HARNESS_PORT>/api/connections/meta/callback (facts ML-04).
const meta = desktop ? undefined : metaProviderFromEnv(process.env);
const sourceAdapters = desktop ? [] : sourceAdaptersFromEnv(process.env);
// Validate the retired setting, but never register Apify for new acquisitions.
if (!desktop) apifyEnabledFromEnv(process.env);
const modelOptions = {
  modelBaseUrl:process.env.HARNESS_MODEL_BASE_URL || 'http://127.0.0.1:8001/v1',
  modelId:process.env.HARNESS_MODEL_ID || (desktop ? '' : undefined),
  modelApiKey:process.env.HARNESS_MODEL_API_KEY || undefined,
  ...(desktop ? { modelReasoningEffort: 'none' as const, modelResponseFormat: 'json_object' as const } : {}),
};
// Keep the earlier healthcare demonstration intact when switching profiles.
const dataDir = path.resolve(process.env.HARNESS_DATA_DIR || (profile === 'healthcare-operations' ? '.data' : '.data/workspace-analyst'));
const appOrigin = process.env.HARNESS_APP_ORIGIN || 'http://127.0.0.1:5190';
const appUrl = new URL(appOrigin);
if (!['http:', 'https:'].includes(appUrl.protocol) || !['localhost', '127.0.0.1'].includes(appUrl.hostname) || appUrl.origin !== appOrigin) throw new Error('HARNESS_APP_ORIGIN must be a loopback origin without a path.');
const redirectUri = `http://${appUrl.hostname}:${port}/api/connections/google-drive/callback`;
const drive = !desktop && profile === 'workspace-analyst' ? createGoogleDrive({ dataDir, clientId:process.env.HARNESS_GOOGLE_CLIENT_ID, clientSecret:process.env.HARNESS_GOOGLE_CLIENT_SECRET, redirectUri }) : undefined;
const sourceDir = path.resolve(process.env.HARNESS_SOURCE_DIR || (profile === 'healthcare-operations' ? 'fixtures/healthcare-referrals' : 'fixtures/notes'));
const reportEmail = desktop ? undefined : reportEmailSenderFromEnv(process.env);
const localRecipient = process.env.HARNESS_REPORT_EMAIL_LOCAL_RECIPIENT;
if (reportEmail && (!validReportEmailRecipient(localRecipient) || reportEmail.appOrigin !== appOrigin)) throw new Error('Local review email requires a configured local recipient and the local app origin.');
const harness = await createHarness({
  profile,
  dataDir,
  externalSources:drive,
  tabularLimits,
  connectionLimits,
  connections:{enabled:connectionsEnabled,providers:{...(meta ? {meta} : {})},adapters:sourceAdapters,limiter:createSyncLimiter(syncConcurrency)},
  apify:{token:null},
  // D-2: HARNESS_CREDENTIAL_KEY_FILE, or ~/.config/rivetfields/credentials.key created 0600 on the first seal (never
  // before). The key must sit outside the data and source directories. No provider uses it until one is registered.
  // `.data` is the parent of the default analyst directory and the healthcare profile's own, so it is covered too.
  credentialKeys:credentialKeysFromEnv(process.env,{mode:'local',dataDirs:[dataDir,sourceDir,path.resolve('.data')]}),
  sourceDir,
  ...(reportEmail ? { reportEmail: {
    sender: reportEmail.sender,
    owner: async () => ({ recipient: localRecipient!, accessContext: { workspaceId: 'local', actor: { issuer: 'local', subject: 'local' } } }),
    compose: (run, owner) => composeWeeklyReviewEmail(run, { from: reportEmail.from, replyTo: reportEmail.replyTo, to: owner.recipient,
      appUrl: appOrigin, manageUrl: `${appOrigin}/?view=schedules` }),
  } } : {}),
  ...modelOptions,
});
const care = profile === 'healthcare-operations' ? await createCareService({ dataDir, fixtures:careFixtures, ...modelOptions }) : undefined;
const organizations = !desktop && profile === 'workspace-analyst' && process.env.HARNESS_ORG_ADMIN === '1' ? createOrganizationAdmin(path.join(dataDir, 'organization-admin', 'registry.sqlite')) : undefined;
const server = createApiServer(harness, {port,desktop,webDir:path.resolve('dist/web'),care,organizations,drive:drive ? {service:drive,appOrigin,redirectUri,pickerApiKey:process.env.HARNESS_GOOGLE_PICKER_API_KEY,projectNumber:process.env.HARNESS_GOOGLE_PROJECT_NUMBER,cancelActiveRun:()=>{const id=harness.activeRunId();if(id)harness.cancelRun(id);}} : undefined});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const stopped = new Promise<void>(resolve => server.close(() => resolve()));
  // Streams or an unresponsive provider must not leave an orphan after the parent exits.
  const deadline = desktop ? setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 5_000) : undefined;
  deadline?.unref();
  try {
    await care?.close();
    await harness.close();
  } finally {
    organizations?.store.close();
    if (desktop) {
      server.closeAllConnections();
      await stopped;
      clearTimeout(deadline);
      if (process.connected) process.disconnect();
    }
  }
}
function shutdown() {
  void close().catch(() => { process.exitCode = 1; console.error('Rivetfield harness shutdown failed.'); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.once('error', (error: NodeJS.ErrnoException) => {
  process.exitCode = 1;
  console.error(`Rivetfield harness API could not listen: ${error.code ?? 'server_error'}.`);
  shutdown();
});
if (desktop) process.once('disconnect', shutdown);
// The parent may have disconnected while the runtime was opening its local stores.
if (desktop && !process.connected) shutdown();
else server.listen(port, '127.0.0.1', () => {
  if (closing) return;
  console.log(`Rivetfield harness API: http://127.0.0.1:${port}`);
  if (desktop) process.send!({ type: 'rivet-ready', port }, error => { if (error) shutdown(); });
});
