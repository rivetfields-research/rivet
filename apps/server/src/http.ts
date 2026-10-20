import { TabularInputError, type TabularValidation } from '../../../packages/core/src/tabular-validation.ts';
import { streamRun } from './run-stream.ts';
import { customerError, customerProvider, customerRun, customerRunUpdate } from './customer-model.ts';
import { socialAnalysisCsv } from '../../../packages/core/src/social-analysis.ts';
import { exportAnalysisCsv } from '../../../packages/data-layer/src/tabular/index.ts';
import { answerDocument } from '../../../packages/presentation/src/answer-export.ts';
import { savedReportAnalysis } from '../../../packages/core/src/saved-report.ts';
import { chartDownload } from './chart-download.ts';
import { postPresentations } from '../../../packages/data-layer/src/tabular/post-presentation.ts';
import type { CsvPreview } from '../../../packages/data-layer/src/tabular/types.ts';
import type { SourceObservation, SourceRecord, analyzeSources } from '../../../packages/data-layer/src/source-semantics.ts';
import type { TabularDatasetInput, TabularDatasetSummary, StoredTabularDataset } from '../../../packages/core/src/tabular-datasets.ts';
import type { Project, ProjectInput } from '../../../packages/core/src/types.ts';
import { validateSourceIds } from '../../../packages/core/src/source-scope.ts';
import type { SourceArchiveState, StartRunInput } from '../../../packages/core/src/types.ts';
import type { WorkflowSchedule, ScheduleCreateInput, ScheduleUpdateInput } from '../../../packages/core/src/workflow-schedules.ts';
import type { ReportEmailStore } from '../../../packages/core/src/report-email.ts';
import { driveRoute, driveStatus, type DriveHttpOptions } from './drive-http.ts';
import { createDesktopAccessGuard, type DesktopAccess } from './desktop-access.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { careRoute, type CareApi } from './care-http.ts';
import { isRunCancellation, WorkspaceAccessError, type WorkspaceAccess, type AuthorizedWorkspace } from './workspace-access.ts';
import type { ImportedWorkspaceFile } from '../../../packages/core/src/file-import.ts';
import type { UsageDatasetSummary, StoredUsageDataset, FinancialDatasetSummary, StoredFinancialDataset } from '../../../packages/core/src/index.ts';
import type { Connection } from '../../../packages/core/src/connections.ts';
import type { ConnectionListEntry, SyncAttempt, SyncJob, SyncScheduleInput } from '../../../packages/core/src/sync-jobs.ts';
import type { SchedulePin } from '../../../packages/core/src/workflow-schedules.ts';
import type { SocialDatasetSummary } from '../../../packages/core/src/index.ts';
import type { UsageCoverage } from '../../../packages/core/src/reporting-analysis.ts';
import type { FinancialCoverage, FinancialPeriod } from '../../../packages/core/src/financial-reporting.ts';
import type { Run, RunAccessContext, RunUpdate, RunSummary, SourceDocument, WorkspaceStatus, Workflow, WorkflowCreateInput, WorkflowUpdateInput } from '../../../packages/core/src/types.ts';
import type { ModelAllowanceSnapshot, WorkspaceDiagnostics } from '../../../packages/core/src/workspace-diagnostics.ts';
import { sourceDatasetId, sourceTableKind, type SavedSourceCalculation } from '../../../packages/core/src/source-table.ts';
import { sourceTablePage } from './source-table.ts';
import { organizationRoute, type OrganizationAdmin } from './organizations-http.ts';
import { oauthCookieHeader, readOAuthCookie } from '../../../packages/core/src/oauth.ts';
import { isRecipientSettingsPatch } from './recipient-settings-http.ts';
import { beginSignIn, callbackQuery, createConnectionSignIns, finishSignIn, redirectAfterSignIn, returnAfterLocalSignIn, SIGN_IN_PROVIDER, signInReturnPath, validSignInBody, type ConnectionSignIns, type SignInHarness } from './connection-sign-in.ts';

export interface HarnessApi extends SignInHarness {
  scheduleEmailStatus?(id: string, context?: RunAccessContext): Promise<ReturnType<ReportEmailStore['status']>>;
  updateScheduleEmail?(id: string, input: { version: number; enabled: boolean }, context?: RunAccessContext): Promise<ReturnType<ReportEmailStore['status']>>;
  testScheduleEmail?(id: string, input: { requestId: string; forceIntro?: boolean }, context?: RunAccessContext): Promise<ReturnType<ReportEmailStore['status']>>;
  listSchedules?(): WorkflowSchedule[];
  createSchedule?(input: ScheduleCreateInput, context?: RunAccessContext): Promise<WorkflowSchedule>;
  updateSchedule?(id: string, input: ScheduleUpdateInput, context?: RunAccessContext): Promise<WorkflowSchedule>;
  removeSchedule?(id: string, version: number, context?: RunAccessContext): Promise<void>;
  listSourceArchives?(): SourceArchiveState[];
  setSourceArchived?(sourceId: string, archived: boolean): SourceArchiveState;
  previewTabularDataset?(csv: string): CsvPreview;
  validateTabularDataset?(csv: string, mapping: TabularDatasetInput['mapping']): TabularValidation;
  /** The result also reports whether a raw receipt was written; the upload route never returns that. */
  importTabularDataset?(input: TabularDatasetInput): TabularDatasetSummary & {created?: boolean; receiptId?: string | null};
  listTabularDatasets?(): readonly TabularDatasetSummary[];
  getTabularDataset?(id: string): StoredTabularDataset | undefined;
  listProjects?(): Project[];
  getProject?(id: string): Project | undefined;
  saveProject?(input: ProjectInput): Project;
  projectRuns?(id: string): RunSummary[];
  importFile?(input: {name: string; content: string}): ImportedWorkspaceFile;
  listFiles?(): readonly ImportedWorkspaceFile[];
  workspace(): Promise<WorkspaceStatus>;
  runBudget?(): WorkspaceStatus['runBudget'];
  listRuns(workflowId?: string, before?: string): RunSummary[];
  getRun(id: string): Run | undefined;
  getRunByRequest?(requestId: string, context?: RunAccessContext): Run | undefined;
  cancelPendingRun?(input: StartRunInput, context?: RunAccessContext): Promise<Run>;
  getRunSession?(id: string): Run[] | undefined;
  getRunUpdate?(id: string, after: number): RunUpdate | undefined;
  subscribe?(id: string, listener: () => void): () => void;
  getSource(id: string): SourceDocument | undefined;
  getSourceCalculation?(id: string): SavedSourceCalculation | undefined;
  startRun(input: StartRunInput, context?: RunAccessContext): Promise<Run>;
  retryExplanation?(id: string, requestId: string, context?: RunAccessContext): Promise<Run>;
  cancelRun(id: string): Run | undefined;
  listWorkflows(): Workflow[];
  getWorkflow(id: string): Workflow | undefined;
  createWorkflow(input: WorkflowCreateInput): Workflow;
  updateWorkflow(id: string, input: WorkflowUpdateInput): Workflow;
  startWorkflowRun(id: string, input: {requestId: string; version: number; sourceIds?: string[]}, context?: RunAccessContext): Promise<Run>;
  importUsageDataset?(input: {csv: string; sourceName: string; weekStart: string; coverage?: UsageCoverage}): UsageDatasetSummary;
  listUsageDatasets?(): readonly UsageDatasetSummary[];
  getUsageDataset?(id: string): StoredUsageDataset | undefined;
  importFinancialDataset?(input: {csv: string; sourceName: string; period: FinancialPeriod; coverage?: FinancialCoverage}): FinancialDatasetSummary;
  listFinancialDatasets?(): readonly FinancialDatasetSummary[];
  getFinancialDataset?(id: string): StoredFinancialDataset | undefined;
  /** Already-fetched public social records only; this route never contacts a provider. */
  importSocialDataset?(input: {json: string | readonly unknown[]; platform: string; accountId: string; sourceName?: string; datasetId?: string | null; declaredCoverage?: 'complete' | 'partial' | 'unknown'; requestId?: string}): SocialDatasetSummary;
  /** Server-side provider fetch using configured credentials; callers never send tokens. */
  importApifySocialDataset?(input: {datasetId: string; platform: string; accountId: string; limit?: number; sourceName?: string; declaredCoverage?: 'complete' | 'partial' | 'unknown'; requestId?: string}): Promise<SocialDatasetSummary>;
  listSocialDatasets?(): readonly SocialDatasetSummary[];
  /** Runtime connection capability. `runtimeEnabled` false means no connection route is served. */
  connectionSettings?(): { runtimeEnabled: boolean; providers: { id: string; label: string; enabled: boolean }[] };
  /** Never includes the stored owner identity. */
  listConnections?(): readonly ConnectionListEntry[];
  beginBrokerConnection?(provider: string, context?: RunAccessContext): Promise<{ id: string; provider: string; url: string; expiresAt: string }>;
  readBrokerConnection?(provider: string, id: string, context?: RunAccessContext): Promise<unknown>;
  confirmBrokerConnection?(provider: string, id: string, input: unknown, context?: RunAccessContext): Promise<{ connections: { id: string }[] }>;
  cancelBrokerConnection?(provider: string, id: string, context?: RunAccessContext): Promise<unknown>;
  addConnection?(input: { provider: string; displayName: string; schedule?: SyncScheduleInput; apify?: unknown }, context?: RunAccessContext): Promise<{ connection: Omit<Connection, 'owner'>; job: SyncJob }>;
  syncConnection?(id: string, input: { version: number }, context?: RunAccessContext): Promise<{ attempt: PublicSyncAttempt; reused: boolean }>;
  updateConnectionSchedule?(id: string, input: SyncScheduleInput & { version: number }, context?: RunAccessContext): Promise<SyncJob>;
  /** `revoked` is present for providers with an account sign-in: whether the provider confirmed the revoke. */
  /** `shared`: the provider-side grant still serves another connection here (Meta), so it was not revoked. */
  disconnectConnection?(id: string, input: { version: number }, context?: RunAccessContext): Promise<{ connection: Omit<Connection, 'owner'>; job: SyncJob; revoked?: 'revoked' | 'failed' | 'not_needed' | 'shared' }>;
  /** A pending account choice after a sign-in that lists accounts (M8). Never a credential. */
  connectionChoice?(provider: string, choiceId: string, context?: RunAccessContext): Promise<{ provider: string; expiresAt: string; accounts: { id: string; provider: string; providerLabel: string; displayName: string; state: string }[] }>;
  chooseConnectionAccounts?(provider: string, choiceId: string, input: { accounts: { id: string; displayName: string }[] }, context?: RunAccessContext): Promise<{ connections: Omit<Connection, 'owner' | 'grantKey'>[] }>;
  cancelConnectionChoice?(provider: string, choiceId: string, context?: RunAccessContext): Promise<{ revoked: 'revoked' | 'failed' | 'shared' }>;
  listConnectionAttempts?(id: string, limit?: number): PublicSyncAttempt[];
  listConnectionSnapshots?(id: string): { id: string; sourceId: string; observedAt: string }[];
  listSourceObservations?(connectionId: string): SourceObservation[];
  getSourceObservation?(id: string, offset?: number): { observation: SourceObservation; records: SourceRecord[]; nextOffset: number | null };
  analyzeSourceObservations?(input: unknown): ReturnType<typeof analyzeSources>;
  sourceFreshness?(sourceIds: readonly string[]): SourceFreshness[];
  runFreshness?(runId: string): { runId: string; workspaceId?: string; scheduleAttemptId: string | null; presync: SchedulePin['presync'] | null; resolvedSources: SchedulePin['resolvedSources'] | null; sources: SourceFreshness[] } | undefined;
}
/** Acquisition keys and column mappings stay on the server. */
type PublicSyncAttempt = Omit<SyncAttempt, 'idempotencyKey' | 'files'> & { files: Omit<SyncAttempt['files'][number], 'key' | 'mapping'>[] };
/** `connections` lists every connection whose syncs produced this source (several can share identical data). */
interface SourceFreshness { sourceId: string; connectionId: string; displayName: string; observedAt: string; connections?: { connectionId: string; displayName: string }[] }
export interface HttpOptions {
  /** Per-launch desktop access, enforced before every API, callback and static request. */
  desktop?: DesktopAccess;
  /** Narrow signature/token-authenticated mail routes; never a general authentication bypass. */
  reportEmailPublic?: (request: IncomingMessage, response: ServerResponse, pathname: string) => Promise<boolean>;
  /** Separately authorized, opt-in Stripe test routes; never ordinary customer entitlements. */
  testBilling?: {handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>};
  extension?: (input: {pathname: string; url: URL; request: IncomingMessage; session?: AuthorizedWorkspace; readBody: () => Promise<Record<string,unknown>>}) => Promise<unknown | undefined>;
  port: number; webDir: string; care?: CareApi; drive?: DriveHttpOptions;
  /** Customer intake is connector-only; local QA keeps its manual import routes. */
  allowManualImports?: boolean;
  organizations?: OrganizationAdmin;
  customerWorkspaces?: {
    handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void>;
    /** The hosted root sign-in callback for a private runtime (D-4): identity, pending state, then that runtime. */
    connectionCallback?(request: IncomingMessage, response: ServerResponse, provider: string, url: URL): Promise<void>;
  };
  /** Pending account sign-ins, one store per process (M7). Defaults to one for this handler. */
  connectionSignIns?: ConnectionSignIns;
  customerWorkspace?: { organizationId: string; private?: boolean; testBilling?: true; localBillingPreview?: true; name(): string; isAdmin?: (identity: {issuer: string; subject: string}) => boolean };
  diagnostics?: {
    modelAllowance: () => ModelAllowanceSnapshot;
    members?: () => NonNullable<WorkspaceDiagnostics['access']['members']>;
  };
  /** A separately isolated harness instance bound to this exact server-selected workspace. */
  access?: { workspaceId: string; appOrigin: string; gate: WorkspaceAccess; recheckMs?: number; assertionHeader?: 'cf-access-jwt-assertion' | 'authorization' };
}

export class HttpDownload { constructor(public text: string) {} }

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** A 10 MiB dataset can expand under JSON escaping; the data layer enforces the decoded 10 MiB limit. */
const SOCIAL_BODY_LIMIT = 12 * 1024 * 1024 + 4096;

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  response.end(JSON.stringify(value));
}

const BODY_DRAIN_ALLOWANCE = 1024 * 1024;

async function body(request: IncomingMessage, limit = 16_384): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'content_type', 'Send an application/json request.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    // Keep reading (and discarding) a moderately oversized body so the client receives the 413 answer. Leaving the
    // loop early destroys the socket, and the client then sees a reset instead of the explanation. Past the drain
    // allowance the connection is dropped, which bounds the work an abusive request can cause.
    if (size > limit + BODY_DRAIN_ALLOWANCE) throw new HttpError(413, 'body_too_large', 'This request is too large.');
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new HttpError(413, 'body_too_large', 'This request is too large.');
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, 'invalid_json', 'Send a JSON object.'); }
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export function createApiServer(harness: HarnessApi, options: HttpOptions) {
  const handler = createApiHandler(harness, options);
  const server = createServer((request, response) => void handler(request, response));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

/** Each handler closes over one runtime. No request can replace its data store. */
export function createApiHandler(harness: HarnessApi, options: HttpOptions) {
  const desktop = options.desktop ? { ...options.desktop } : undefined;
  const desktopGuard = desktop ? createDesktopAccessGuard(desktop) : undefined;
  // Copy the trusted boundary once. Request parameters cannot select a workspace.
  const access = options.access ? { ...options.access } : undefined;
  let hostedOrigin: URL | undefined;
  if (access) {
    if (options.organizations?.mode === 'local') throw new Error('Hosted organization administration requires verified identity and an explicit staff allowlist.');
    hostedOrigin = new URL(access.appOrigin);
    if (hostedOrigin.protocol !== 'https:' || hostedOrigin.origin !== access.appOrigin || hostedOrigin.username || hostedOrigin.password ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(access.workspaceId) || typeof access.gate?.authorize !== 'function' ||
        (access.assertionHeader!==undefined&&!['cf-access-jwt-assertion','authorization'].includes(access.assertionHeader)) ||
        (access.recheckMs !== undefined && (!Number.isInteger(access.recheckMs) || access.recheckMs < 10 || access.recheckMs > 30_000))) {
      throw new Error('Configure a fixed HTTPS app origin, workspace and access verifier.');
    }
    if (options.care || options.drive) throw new Error('Shared identity cannot enable the preserved care profile or installation-wide Drive credentials.');
  }
  const allowedOrigins = new Set([
    `http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`,
    'http://127.0.0.1:5190', 'http://localhost:5190',
    'http://127.0.0.1:4320', 'http://localhost:4320',
  ]);
  if (options.drive) {
    const app = new URL(options.drive.appOrigin);
    if (!['http:', 'https:'].includes(app.protocol) || !['127.0.0.1', 'localhost'].includes(app.hostname) || app.origin !== options.drive.appOrigin) throw new Error('Google Drive requires a loopback app origin.');
    allowedOrigins.add(app.origin);
  }
  const root = path.resolve(options.webDir);
  // Hosted sign-ins need the process-wide store, so the root callback can find their runtime; without one (no sign-in
  // provider is registered, as in production today) no hosted sign-in route exists. Local mode keeps its own.
  const signIns = options.connectionSignIns ?? (access ? undefined : createConnectionSignIns('local'));
  // Only a server-issued, one-use handoff may switch local sign-in hostnames.
  const localSignInStarts = new Map<string, { destination: string; expires: number }>();
  let openStreams = 0;
  return async (request: IncomingMessage, response: ServerResponse, requestPath?: string) => {
    let modelAction = false;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://apis.google.com https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://www.googleapis.com https://content.googleapis.com https://docs.google.com; frame-src https://docs.google.com https://drive.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const desktopDenial = desktopGuard?.(request);
      if (desktopDenial) throw new HttpError(403, desktopDenial, 'Use the desktop workspace for this request.');
      const actualPort = request.socket.localPort ?? options.port;
      const allowedHosts = new Set(hostedOrigin ? [hostedOrigin.host] : [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      if (!allowedHosts.has(request.headers.host ?? '')) throw new HttpError(403, 'host_denied', 'Use the configured workspace address.');
      const url = new URL(requestPath ?? request.url ?? '/', `http://127.0.0.1:${options.port}`);
      const pathname = decodeURIComponent(url.pathname);
      // The local UI reads capability status even when connecting accounts is disabled.
      if (desktop && request.method === 'GET') {
        if (pathname === '/api/connections') return json(response, 200, { runtimeEnabled: false, unavailableReason: 'desktop', providers: [], connections: [] });
        if (pathname === '/api/connections/google-drive') return json(response, 200, driveStatus());
      }
      if (desktop && (/^\/(?:api\/)?connections(?:\/|$)/.test(pathname) ||
          /^\/api\/(?:admin|signup|team)(?:\/|$)/.test(pathname) || pathname.startsWith('/api/organization-') ||
          /^\/(?:admin|join|team|workspaces|onboarding|w|email)(?:\/|$)/.test(pathname) ||
          /^\/api\/schedules\/[^/]+\/email(?:\/|$)/.test(pathname) || pathname === '/api/datasets/social/apify')) {
        throw new HttpError(404, 'desktop_feature_disabled', 'This feature is not available in the desktop workspace.');
      }
      if (!desktop && !requestPath && options.reportEmailPublic &&
          (pathname === '/email/events/resend' || /^\/email\/unsubscribe\/[A-Za-z0-9_-]{48,128}$/.test(pathname)) &&
          await options.reportEmailPublic(request, response, pathname)) return;
      if (!desktop && !requestPath && options.testBilling && await options.testBilling.handle(request, response)) return;
      if (pathname === '/billing-test' || pathname === '/api/billing-test' || pathname.startsWith('/api/billing-test/'))
        throw new HttpError(404, 'not_found', 'Page not found.');
      const oauthCallback = request.method === 'GET' && pathname === '/api/connections/google-drive/callback';
      const origin = request.headers.origin;
      const writes = !['GET', 'HEAD'].includes(request.method ?? '');
      const navigation = request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
      const localStartToken = url.searchParams.get('token') ?? '';
      const localStart = !access && request.method === 'GET' && pathname === '/connections/local-start'
        ? localSignInStarts.get(localStartToken) : undefined;
      const validLocalStart = localStart && localStart.expires > Date.now() &&
        new URL(localStart.destination).host === request.headers.host &&
        (request.headers['sec-fetch-site'] !== 'cross-site' || navigation) &&
        (!origin || allowedOrigins.has(origin));
      const documentNavigation = !writes && !pathname.startsWith('/api/') && navigation;
      if (access && ((origin && origin !== access.appOrigin) || (writes && origin !== access.appOrigin) || (request.headers['sec-fetch-site'] === 'cross-site' && !documentNavigation))) {
        throw new HttpError(403, 'origin_denied', 'Use the workspace origin for this request.');
      }
      // Local account sign-in (M7): the provider returns the browser to exactly /api/connections/<provider>/callback
      // for a provider registered here, as a top-level navigation. Nothing else under /api is exempt.
      const localSignInCallback = !access && request.method === 'GET' && /^\/api\/connections\/([a-z][a-z0-9-]{0,39})\/callback$/.test(pathname) &&
        pathname !== '/api/connections/google-drive/callback' && (request.headers['sec-fetch-site'] !== 'cross-site' || navigation) &&
        Boolean(harness.connectionSignInProvider?.(pathname.split('/')[3]));
      if (!access && !oauthCallback && !localSignInCallback && !validLocalStart && ((origin && !allowedOrigins.has(origin)) || request.headers['sec-fetch-site'] === 'cross-site')) {
        throw new HttpError(403, 'origin_denied', 'This request did not come from the local workspace.');
      }
      if (validLocalStart) {
        localSignInStarts.delete(localStartToken);
        return returnAfterLocalSignIn(response, localStart.destination);
      }
      // Hosted account sign-in (D-4): one fixed root path per provider, handled here, before `/w/` dispatch, the
      // legacy membership gate and the static files. No proxy rule skips authentication for it.
      const hostedSignIn = access && signIns && !requestPath ? /^\/connections\/([^/]+)\/callback$/.exec(pathname) : null;
      if (hostedSignIn && access && signIns) {
        const provider = hostedSignIn[1];
        if (request.method !== 'GET' || !SIGN_IN_PROVIDER.test(provider)) throw new HttpError(404, 'not_found', 'Page not found.');
        response.setHeader('Set-Cookie', oauthCookieHeader(provider, 'hosted', '', 0));
        if (options.customerWorkspaces) {
          if (!options.customerWorkspaces.connectionCallback) throw new HttpError(404, 'not_found', 'Page not found.');
          return await options.customerWorkspaces.connectionCallback(request, response, provider, url);
        }
        // The shared pilot runtime: a verified member with mutate permission, then the person who started it.
        const authorized = await access.gate.authorize(request.headers[access.assertionHeader ?? 'cf-access-jwt-assertion'], 'mutate');
        if (authorized.workspaceId !== access.workspaceId) throw new HttpError(403, 'workspace_denied', 'This workspace is not available to your account.');
        const failed = () => redirectAfterSignIn(response, signInReturnPath({ result: 'failed', connectionId: null }));
        if (!harness.connectionSignInProvider?.(provider)) return failed();
        let pending;
        try { pending = signIns.take({ state: url.searchParams.get('state'), binding: readOAuthCookie(request.headers.cookie, provider, 'hosted'), provider, actor: { issuer: authorized.identity.issuer, subject: authorized.identity.subject } }); }
        catch { return failed(); }
        if (pending.context.workspaceId !== access.workspaceId || pending.context.organizationId !== null) return failed();
        // canManageSources (C8): in the shared pilot only owners manage connections; never operators or reviewers.
        if (authorized.role !== 'owner') return redirectAfterSignIn(response, signInReturnPath({ result: 'failed', connectionId: pending.context.connectionId }));
        const outcome = await finishSignIn(harness, signIns, pending, callbackQuery(url), { workspaceId: authorized.workspaceId, actor: { issuer: authorized.identity.issuer, subject: authorized.identity.subject } });
        return redirectAfterSignIn(response, signInReturnPath(outcome));
      }
      if (!requestPath && pathname.startsWith('/w/')) {
        if (!options.customerWorkspaces) throw new HttpError(404, 'workspaces_disabled', 'Customer workspaces are not enabled.');
        return await options.customerWorkspaces.handle(request, response, pathname);
      }
      const adminApi = pathname.startsWith('/api/admin/') || pathname.startsWith('/api/signup/') || pathname.startsWith('/api/team/') || pathname === '/api/organization-session' || pathname === '/api/organization-join' || pathname === '/api/organization-workspaces' || pathname === '/api/organization-workspaces/open';
      if (adminApi) {
        if (!options.organizations) throw new HttpError(404, 'admin_not_configured', 'Organization management is not enabled on this server.');
        const result = await organizationRoute(options.organizations, request, pathname, () => body(request), access?.assertionHeader ?? 'authorization');
        return json(response, result.status, result.value);
      }
      // Administration and join pages use verified identity independently of the pilot's membership.
      // Only static application assets bypass the pilot gate; every data API retains it.
      const adminStatic = options.organizations && !writes && (pathname === '/admin' || pathname === '/join' || pathname === '/join/complete' || pathname === '/team' || pathname === '/workspaces' || pathname === '/onboarding' || pathname === '/favicon.svg' || pathname.startsWith('/assets/'));
      if (adminStatic) {
        const identity = await options.organizations!.authenticate(request.headers[access?.assertionHeader ?? 'authorization']);
        if (pathname === '/admin' && !options.organizations!.isStaff(identity)) throw new HttpError(403, 'staff_required', 'Organization administration is available only to Rivet staff.');
      }
      if (options.customerWorkspaces && options.organizations && pathname === '/' && !writes) {
        await options.organizations.authenticate(request.headers[access?.assertionHeader ?? 'authorization']);
        response.writeHead(303, {Location: '/workspaces', 'Cache-Control': 'no-store'});
        response.end(); return;
      }
      let session: AuthorizedWorkspace | undefined;
      const testCancellation = (options.customerWorkspace?.testBilling || options.customerWorkspace?.localBillingPreview) && isRunCancellation(pathname, request.method);
      const authorize = async () => {
        if (!access) return undefined;
        const profileEdit = options.customerWorkspace?.private && options.extension && isRecipientSettingsPatch(pathname, request.method);
        const authorized = await access.gate.authorize(request.headers[access.assertionHeader ?? 'cf-access-jwt-assertion'], testCancellation ? 'cancel' : writes && !profileEdit ? 'mutate' : 'read');
        if (authorized.workspaceId !== access.workspaceId) throw new HttpError(403, 'workspace_denied', 'This workspace is not available to your account.');
        if (testCancellation && session && (session.identity.issuer !== authorized.identity.issuer || session.identity.subject !== authorized.identity.subject))
          throw new HttpError(409, 'workspace_account_changed', 'Your signed-in account changed. Reload this tab before continuing.');
        const browserScope = request.headers['x-rivet-workspace-scope'];
        if (options.customerWorkspace?.private && browserScope !== undefined && browserScope !== createHash('sha256').update(JSON.stringify([authorized.workspaceId, authorized.identity.issuer, authorized.identity.subject])).digest('hex')) {
          throw new HttpError(409, 'workspace_account_changed', 'Your signed-in account changed. Reload this tab before continuing.');
        }
        if (options.customerWorkspaces && options.organizations && (writes || !(options.organizations.isAccountOwner ?? options.organizations.isStaff)(authorized.identity))) throw new HttpError(403, 'workspace_denied', 'Open your private workspace to continue.');
        return authorized;
      };
      if (access && !adminStatic) {
        try { session = await authorize(); }
        catch (error) {
          // A customer landing at the product root is not a pilot member.
          // Redirect only the page, never a protected API or workspace request.
          if (options.organizations && pathname === '/' && ['GET', 'HEAD'].includes(request.method ?? '') &&
              error instanceof WorkspaceAccessError && error.code === 'workspace_denied') {
            await options.organizations.authenticate(request.headers[access.assertionHeader ?? 'cf-access-jwt-assertion']);
            response.writeHead(303, {Location: '/workspaces', 'Cache-Control': 'no-store'});
            response.end();
            return;
          }
          throw error;
        }
      }
      const runAccess: RunAccessContext | undefined = session ? {workspaceId:session.workspaceId,actor:{issuer:session.identity.issuer,subject:session.identity.subject}} : undefined;
      // canManageSources (C8): local, owners, and private-workspace operators. Never reviewers or legacy operators.
      const managesSources = (current: AuthorizedWorkspace | undefined) => !current || current.role === 'owner' || Boolean(options.customerWorkspace?.private && current.role === 'operator');
      const requireManager = async () => {
        const current = await authorize();
        if (!managesSources(current)) throw new HttpError(403, 'connection_manager_required', "You don't have permission to manage this workspace's connections.");
      };
      /** Connecting a schedule to connections, or asking it to refresh them, is connection management. */
      const schedulesConnections = (input: Record<string, unknown>) => (Array.isArray(input.connectionIds) && input.connectionIds.length > 0) || input.refreshBeforeRun === true;
      if (pathname.startsWith('/api/')) {
        if (options.allowManualImports === false && request.method === 'POST' && [
          '/api/datasets/tabular/preview', '/api/datasets/tabular/validate', '/api/datasets/tabular',
          '/api/datasets/usage', '/api/datasets/financial', '/api/datasets/social', '/api/datasets/social/apify', '/api/files',
        ].includes(pathname)) {
          throw new HttpError(409, 'manual_imports_disabled', 'Connect a source to bring data into this workspace. Manual uploads and CSV mapping are no longer available.');
        }
        if (options.extension) {
          const result = await options.extension({pathname,url,request,session,readBody:async () => { const input = await body(request); await authorize(); return input; }});
          if (result !== undefined) { await authorize(); if(result instanceof HttpDownload) {response.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename=report.csv','Cache-Control':'no-store'});response.end(result.text);return;} return json(response,200,result); }
        }
        const calculationMatch = /^\/api\/sources\/([a-zA-Z0-9_.:-]{1,200})\/calculation$/.exec(pathname);
        if (calculationMatch && request.method === 'GET') {
          const saved = harness.getSourceCalculation?.(calculationMatch[1]);
          if (!saved || (access && saved.workspaceId !== access.workspaceId)) throw new HttpError(404, 'source_calculation_not_found', 'No complete saved calculation is available for this source.');
          await authorize();
          return json(response, 200, { runId: saved.runId, analysis: saved.analysis });
        }
        const sourceTableMatch = /^\/api\/sources\/([a-zA-Z0-9_.:-]{1,200})\/table$/.exec(pathname);
        if (sourceTableMatch && request.method === 'GET') {
          const source = harness.getSource(sourceTableMatch[1]);
          const datasetId = source && sourceDatasetId(source);
          const kind = source && sourceTableKind(source);
          if (!source || !kind) throw new HttpError(404,'source_table_not_found','No saved CSV rows are available for this source.');
          const dataset = datasetId ? kind === 'usage' ? harness.getUsageDataset?.(datasetId) : kind === 'financial' ? harness.getFinancialDataset?.(datasetId) : harness.getTabularDataset?.(datasetId) : undefined;
          const page = sourceTablePage(source,dataset,url.searchParams);
          await authorize();
          return json(response,200,page);
        }
        const sourceSemanticsEnabled = Boolean(harness.connectionSettings?.().runtimeEnabled);
        const observationsMatch = /^\/api\/connections\/([a-zA-Z0-9_.:-]{1,200})\/observations$/.exec(pathname);
        if (sourceSemanticsEnabled && observationsMatch && request.method === 'GET' && harness.listSourceObservations) {
          const observations = harness.listSourceObservations(observationsMatch[1]!);
          await authorize();
          return json(response, 200, { observations });
        }
        const observationMatch = /^\/api\/source-observations\/([a-zA-Z0-9_.:-]{1,200})$/.exec(pathname);
        if (sourceSemanticsEnabled && observationMatch && request.method === 'GET' && harness.getSourceObservation) {
          const offset = url.searchParams.get('offset') ?? '0';
          if (!/^\d{1,4}$/.test(offset) || [...url.searchParams.keys()].some(key => key !== 'offset')) throw new HttpError(400, 'invalid_offset', 'Choose a valid record offset.');
          const page = harness.getSourceObservation(observationMatch[1]!, Number(offset));
          await authorize();
          return json(response, 200, page);
        }
        if (sourceSemanticsEnabled && pathname === '/api/source-analysis' && request.method === 'POST' && harness.analyzeSourceObservations) {
          const input = await body(request, 32768);
          await authorize();
          const result = harness.analyzeSourceObservations(input);
          await authorize();
          return json(response, 200, result);
        }
        if (pathname === '/api/workspace/diagnostics' && request.method === 'GET') {
          const current = await authorize();
          if (current && current.role !== 'owner') throw new HttpError(403,'owner_required','Only the workspace owner can inspect operating limits and access.');
          let allowance: WorkspaceDiagnostics['allowance'] = {status:'not-configured'};
          if (options.diagnostics) {
            try { allowance = {status:'available',snapshot:options.diagnostics.modelAllowance()}; }
            catch { allowance = {status:'unavailable'}; }
          }
          const members = current ? options.diagnostics?.members?.() ?? null : null;
          const verified = await authorize();
          if (verified && verified.role !== 'owner') throw new HttpError(403,'owner_required','Only the workspace owner can inspect operating limits and access.');
          const diagnostics: WorkspaceDiagnostics = {
            checkedAt:new Date().toISOString(),allowance,
            access:{mode:current ? access?.assertionHeader === 'authorization' ? 'entra' : 'cloudflare' : 'local',role:current ? 'owner' : 'local',members},
          };
          return json(response,200,diagnostics);
        }
        if (pathname === '/api/source-archives' && request.method === 'GET') return json(response,200,{archives:harness.listSourceArchives?.() ?? []});
        const archiveMatch = /^\/api\/sources\/([a-zA-Z0-9_.:-]{1,200})\/archive$/.exec(pathname);
        if (archiveMatch && request.method === 'PATCH' && harness.setSourceArchived) {
          const input = await body(request);
          if (Object.keys(input).length !== 1 || typeof input.archived !== 'boolean') throw new HttpError(400,'invalid_archive','Choose whether this input is archived.');
          const current = await authorize();
          if (current && current.role !== 'owner' && !(options.customerWorkspace?.private && current.role === 'operator')) throw new HttpError(403,'owner_required','You cannot archive these inputs.');
          return json(response,200,harness.setSourceArchived(archiveMatch[1],input.archived));
        }
        if (pathname === '/api/datasets/tabular' && request.method === 'GET' && harness.listTabularDatasets) return json(response,200,{datasets:harness.listTabularDatasets()});
        if (pathname === '/api/datasets/tabular/preview' && request.method === 'POST' && harness.previewTabularDataset) {
          const input = await body(request,6*1024*1024+4096);
          if (typeof input.csv !== 'string' || Object.keys(input).some(key => key !== 'csv')) throw new HttpError(400,'invalid_dataset','Provide CSV text to preview.');
          await authorize();
          return json(response,200,harness.previewTabularDataset(input.csv));
        }
        if (pathname === '/api/datasets/tabular/validate' && request.method === 'POST' && harness.validateTabularDataset) {
          const input = await body(request,6*1024*1024+16384);
          if (typeof input.csv !== 'string' || !input.mapping || typeof input.mapping !== 'object' || Array.isArray(input.mapping) || Object.keys(input).some(key => !['csv','mapping'].includes(key))) throw new HttpError(400,'invalid_dataset','Provide CSV text and a column mapping to check.');
          await authorize();
          return json(response,200,harness.validateTabularDataset(input.csv,input.mapping as TabularDatasetInput['mapping']));
        }
        if (pathname === '/api/datasets/tabular' && request.method === 'POST' && harness.importTabularDataset) {
          const input = await body(request,6*1024*1024+16384);
          if (typeof input.csv !== 'string' || typeof input.sourceName !== 'string' || !input.mapping || typeof input.mapping !== 'object' || Array.isArray(input.mapping) || Object.keys(input).some(key => !['csv','sourceName','mapping'].includes(key))) throw new HttpError(400,'invalid_dataset','Provide a CSV file and confirmed column mapping.');
          await authorize();
          // Acquisition bookkeeping stays server-side: the upload answer is the saved snapshot only.
          const {created: _created, receiptId: _receiptId, ...saved} = harness.importTabularDataset(input as unknown as TabularDatasetInput);
          await authorize();
          return json(response,201,saved);
        }
        const tabularDatasetMatch = /^\/api\/datasets\/tabular\/([a-zA-Z0-9_-]{1,160})$/.exec(pathname);
        if (tabularDatasetMatch && request.method === 'GET' && harness.getTabularDataset) {
          const dataset = harness.getTabularDataset(tabularDatasetMatch[1]);
          if (!dataset) throw new HttpError(404,'dataset_not_found','That dataset was not found.');
          await authorize();
          return json(response,200,dataset);
        }
        if (pathname === '/api/files' && request.method === 'GET' && harness.listFiles) return json(response,200,{files:harness.listFiles()});
        if (pathname === '/api/files' && request.method === 'POST' && harness.importFile) {
          const input = await body(request,6*65536+2048);
          if (Object.keys(input).length !== 2 || Object.keys(input).some(key => !['name','content'].includes(key)) || typeof input.name !== 'string' || typeof input.content !== 'string') throw new HttpError(400,'invalid_file','Provide the file name and UTF-8 content.');
          await authorize();
          return json(response,201,harness.importFile(input as {name:string;content:string}));
        }
        if (pathname === '/api/session' && request.method === 'GET') {
          let organizationAdmin = false;
          // A broken optional staff file must deny admin access without disabling the shared pilot.
          try { organizationAdmin = Boolean(options.organizations && (!session || options.organizations.isStaff(session.identity))) || Boolean(session && options.customerWorkspace?.isAdmin?.(session.identity)); } catch { /* The admin endpoint reports its configuration error. */ }
          return json(response, 200, session ? {
          mode:'authenticated',workspaceId:session.workspaceId,role:session.role,signInUrl:access?.assertionHeader==='authorization'?'/oauth2/start':'/',
          signOutUrl:access?.assertionHeader==='authorization'?'/oauth2/sign_out?rd=%2Fsigned-out':'/cdn-cgi/access/logout',
          ...(session.identity.displayName ? {displayName:session.identity.displayName} : {}),
          ...(session.identity.email ? {email:session.identity.email} : {}),
          ...(options.customerWorkspace ? {organizationId:options.customerWorkspace.organizationId,workspaceName:options.customerWorkspace.name(), privateWorkspace:Boolean(options.customerWorkspace.private),
            browserScope:createHash('sha256').update(JSON.stringify([session.workspaceId,session.identity.issuer,session.identity.subject])).digest('hex')} : {}),
          ...(organizationAdmin ? {organizationAdmin:true} : {}),
          ...((options.customerWorkspaces || options.customerWorkspace) ? {workspacesEnabled:true} : {}),
          ...(options.customerWorkspace?.testBilling ? {testBilling:true} : {}),
        } : {mode:'local',...(organizationAdmin ? {organizationAdmin:true} : {})});
        }
        if (pathname === '/api/datasets/usage' && request.method === 'GET' && harness.listUsageDatasets) return json(response, 200, {datasets:harness.listUsageDatasets()});
        if (pathname === '/api/datasets/usage' && request.method === 'POST' && harness.importUsageDataset) {
          // JSON escaping can expand a valid 1 MiB CSV; the importer checks decoded size.
          const input = await body(request, 6 * 1024 * 1024 + 4096);
          if (Object.keys(input).some(key => !['csv','sourceName','weekStart','coverage'].includes(key)) || typeof input.csv !== 'string' || typeof input.sourceName !== 'string' || typeof input.weekStart !== 'string') {
            throw new HttpError(400, 'invalid_dataset', 'Provide CSV text, its file name and the reporting week.');
          }
          await authorize();
          return json(response, 201, harness.importUsageDataset(input as {csv:string;sourceName:string;weekStart:string;coverage?:UsageCoverage}));
        }
        if (pathname === '/api/datasets/social' && request.method === 'GET' && harness.listSocialDatasets) return json(response, 200, {datasets: harness.listSocialDatasets()});
        if (pathname === '/api/datasets/social/apify' && request.method === 'POST' && harness.importApifySocialDataset) {
          // Server-side Apify fetch. The token comes only from server configuration; this route
          // intentionally refuses caller-supplied tokens or URLs.
          const input = await body(request, 8192);
          const coverage = input.coverage === undefined ? 'unknown' : input.coverage;
          if (Object.keys(input).some(key => !['datasetId','platform','accountId','limit','sourceName','coverage','requestId'].includes(key)) ||
              typeof input.datasetId !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(input.datasetId) ||
              typeof input.platform !== 'string' || input.platform.length > 32 ||
              typeof input.accountId !== 'string' || input.accountId.length > 120 ||
              (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)) ||
              (input.sourceName !== undefined && (typeof input.sourceName !== 'string' || input.sourceName.length > 200)) ||
              !['complete','partial','unknown'].includes(coverage as string) ||
              (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId)))) {
            throw new HttpError(400, 'invalid_dataset', 'Provide an Apify dataset id, platform, account, optional bounded limit, source name, coverage declaration and request id. Do not send tokens or provider URLs.');
          }
          await authorize();
          return json(response, 201, await harness.importApifySocialDataset({
            datasetId: input.datasetId, platform: input.platform, accountId: input.accountId,
            ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
            ...(input.sourceName !== undefined ? { sourceName: input.sourceName as string } : {}),
            declaredCoverage: coverage as 'complete' | 'partial' | 'unknown',
            ...(input.requestId !== undefined ? { requestId: input.requestId as string } : {}),
          }));
        }
        if (pathname === '/api/datasets/social' && request.method === 'POST' && harness.importSocialDataset) {
          // The body carries an already-fetched dataset. No URL, token or dataset id is ever
          // fetched by this route: transport belongs to the operator, not to the server.
          const input = await body(request, SOCIAL_BODY_LIMIT);
          const coverage = input.coverage === undefined ? 'unknown' : input.coverage;
          const records = input.json;
          if (Object.keys(input).some(key => !['json','platform','accountId','sourceName','datasetId','coverage','requestId'].includes(key)) ||
              !(typeof records === 'string' || Array.isArray(records)) ||
              typeof input.platform !== 'string' || input.platform.length > 32 ||
              typeof input.accountId !== 'string' || input.accountId.length > 120 ||
              (input.sourceName !== undefined && (typeof input.sourceName !== 'string' || input.sourceName.length > 200)) ||
              (input.datasetId !== undefined && input.datasetId !== null && (typeof input.datasetId !== 'string' || input.datasetId.length > 200)) ||
              !['complete','partial','unknown'].includes(coverage as string) ||
              (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId)))) {
            throw new HttpError(400, 'invalid_dataset', 'Provide fetched dataset JSON, its platform, the account it belongs to, and optionally a source name, dataset id, coverage declaration and request id.');
          }
          await authorize();
          return json(response, 201, harness.importSocialDataset({
            json: records as string | readonly unknown[], platform: input.platform, accountId: input.accountId,
            ...(input.sourceName !== undefined ? { sourceName: input.sourceName } : {}),
            ...(input.datasetId !== undefined ? { datasetId: input.datasetId as string | null } : {}),
            declaredCoverage: coverage as 'complete' | 'partial' | 'unknown',
            ...(input.requestId !== undefined ? { requestId: input.requestId as string } : {}),
          }));
        }
        const datasetMatch = /^\/api\/datasets\/usage\/([a-zA-Z0-9_-]{1,160})$/.exec(pathname);
        if (datasetMatch && request.method === 'GET' && harness.getUsageDataset) {
          const dataset = harness.getUsageDataset(datasetMatch[1]);
          if (!dataset) throw new HttpError(404, 'dataset_not_found', 'That dataset was not found.');
          return json(response, 200, dataset);
        }
        if (pathname === '/api/datasets/financial' && request.method === 'GET' && harness.listFinancialDatasets) return json(response, 200, {datasets:harness.listFinancialDatasets()});
        if (pathname === '/api/datasets/financial' && request.method === 'POST' && harness.importFinancialDataset) {
          // Permit JSON-escaped CSV while the core importer enforces the decoded 1 MiB cap.
          const input = await body(request, 6 * 1024 * 1024 + 4096);
          const period = input.period;
          if (Object.keys(input).some(key => !['csv','sourceName','period','coverage'].includes(key)) || typeof input.csv !== 'string' || typeof input.sourceName !== 'string' ||
              !period || typeof period !== 'object' || Array.isArray(period) || Object.keys(period).length !== 2 ||
              Object.keys(period).some(key => !['from','through'].includes(key)) || typeof (period as Record<string, unknown>).from !== 'string' || typeof (period as Record<string, unknown>).through !== 'string') {
            throw new HttpError(400, 'invalid_dataset', 'Provide CSV text, its file name and a period with from and through dates.');
          }
          await authorize();
          return json(response, 201, harness.importFinancialDataset(input as {csv:string;sourceName:string;period:FinancialPeriod;coverage?:FinancialCoverage}));
        }
        const financialDatasetMatch = /^\/api\/datasets\/financial\/([a-zA-Z0-9_-]{1,160})$/.exec(pathname);
        if (financialDatasetMatch && request.method === 'GET' && harness.getFinancialDataset) {
          const dataset = harness.getFinancialDataset(financialDatasetMatch[1]);
          if (!dataset) throw new HttpError(404, 'dataset_not_found', 'That dataset was not found.');
          return json(response, 200, dataset);
        }
        // Scheduled data connections. Connection IDs are `conn_<24 hex>`, so these routes can
        // never collide with the Drive routes under `/api/connections/google-drive/`.
        // Disabled runtimes register no connection route at all; the request falls through to 404.
        const connectionSettings = harness.connectionSettings?.();
        if (connectionSettings?.runtimeEnabled) {
          const manages = managesSources;
          const brokerRoute = /^\/api\/connections\/([a-z][a-z0-9-]{0,39})\/broker(?:\/([A-Za-z0-9_-]{43}))?$/.exec(pathname);
          if (brokerRoute && harness.beginBrokerConnection) {
            await requireManager();
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('Referrer-Policy', 'no-referrer');
            const [, provider, id] = brokerRoute;
            if (!id && request.method === 'POST') {
              const input = await body(request);
              if (Object.keys(input).length) throw new HttpError(400, 'invalid_connection', 'Start the connection without account details.');
              return json(response, 201, await harness.beginBrokerConnection(provider, runAccess));
            }
            if (id && request.method === 'GET' && harness.readBrokerConnection) return json(response, 200, await harness.readBrokerConnection(provider, id, runAccess));
            if (id && request.method === 'POST' && harness.confirmBrokerConnection) return json(response, 201, await harness.confirmBrokerConnection(provider, id, await body(request), runAccess));
            if (id && request.method === 'DELETE' && harness.cancelBrokerConnection) return json(response, 200, await harness.cancelBrokerConnection(provider, id, runAccess));
          }
          if (pathname === '/api/connections' && request.method === 'GET') {
            const current = await authorize();
            return json(response, 200, { ...connectionSettings, connections: manages(current) ? harness.listConnections?.() ?? [] : [] });
          }
          if (pathname === '/api/connections' && request.method === 'POST' && harness.addConnection) {
            const input = await body(request);
            const schedule = input.schedule as Record<string, unknown> | undefined;
            // `apify` (M9): the owner's Apify setup, including the API token, which the runtime seals and never returns.
            // Only its shape is checked here; the runtime validates each field without repeating a value.
            const apify = input.apify as Record<string, unknown> | undefined;
            if (Object.keys(input).some(key => !['provider', 'displayName', 'schedule', 'apify'].includes(key)) || typeof input.provider !== 'string' || typeof input.displayName !== 'string' ||
                (schedule !== undefined && (!schedule || typeof schedule !== 'object' || Array.isArray(schedule) || Object.keys(schedule).some(key => !['frequency', 'timeUtc', 'weekday', 'enabled', 'localTime', 'timezone'].includes(key)))) ||
                (apify !== undefined && (!apify || typeof apify !== 'object' || Array.isArray(apify) || Object.keys(apify).some(key => !['token', 'source', 'id', 'platform', 'account'].includes(key)) ||
                  Object.values(apify).some(value => typeof value !== 'string' || value.length > 512)))) {
              throw new HttpError(400, 'invalid_connection', 'Provide a provider, a display name, an optional sync schedule and, for Apify, its setup.');
            }
            await requireManager();
            return json(response, 201, await harness.addConnection(input as { provider: string; displayName: string; schedule?: SyncScheduleInput; apify?: Record<string, string> }, runAccess));
          }
          // Account sign-in (M7), only for providers registered with a sign-in. Others (Google Drive) fall through.
          const signInRoute = /^\/api\/connections\/([a-z][a-z0-9-]{0,39})\/(authorize|callback)$/.exec(pathname);
          const signInProvider = signInRoute ? harness.connectionSignInProvider?.(signInRoute[1]) : undefined;
          if (signInRoute && signInProvider && signIns && signInRoute[2] === 'authorize' && request.method === 'POST' && harness.prepareConnectionSignIn) {
            const input = await body(request);
            if (!validSignInBody(input)) throw new HttpError(400, 'invalid_connection', 'Provide a name for a new connection, or the connection to reconnect.');
            await requireManager();
            const pageOrigin = origin && allowedOrigins.has(origin) ? origin : `http://${request.headers.host}`;
            const started = await beginSignIn(harness, signIns, { provider: signInProvider, body: input, runAccess,
              workspaceId: access?.workspaceId ?? 'local', organizationId: options.customerWorkspace?.private ? options.customerWorkspace.organizationId : null,
              mode: access ? { mode: 'hosted', appOrigin: access.appOrigin } : { mode: 'local', pageOrigin, port: actualPort } });
            if (started.value.restart && !access) {
              for (const [token, entry] of localSignInStarts) if (entry.expires <= Date.now()) localSignInStarts.delete(token);
              const token = randomBytes(32).toString('base64url');
              localSignInStarts.set(token, { destination: started.value.url, expires: Date.now() + 60_000 });
              started.value.url = `${new URL(started.value.url).origin}/connections/local-start?token=${token}`;
            }
            if (started.cookie) response.setHeader('Set-Cookie', started.cookie);
            return json(response, 200, started.value);
          }
          if (signInRoute && signInProvider && signIns && signInRoute[2] === 'callback' && request.method === 'GET' && !access) {
            const provider = signInProvider.id;
            response.setHeader('Set-Cookie', oauthCookieHeader(provider, 'local', '', 0));
            let pending;
            try { pending = signIns.take({ state: url.searchParams.get('state'), binding: readOAuthCookie(request.headers.cookie, provider, 'local'), provider, actor: null }); }
            catch { return returnAfterLocalSignIn(response, signInReturnPath({ result: 'failed', connectionId: null })); }
            if (pending.context.workspaceId !== 'local') return returnAfterLocalSignIn(response, signInReturnPath({ result: 'failed', connectionId: null }));
            const outcome = await finishSignIn(harness, signIns, pending, callbackQuery(url), undefined);
            // Back to the page that started it: an allowed loopback origin saved with the pending sign-in, through a
            // same-origin page so a cross-site provider (Meta) does not leave the return navigation cross-site.
            return returnAfterLocalSignIn(response, signInReturnPath(outcome, `${pending.context.returnOrigin ?? ''}/`));
          }
          // Account choice after a sign-in that lists accounts (M8): read it, pick accounts, or cancel. Managers only, and
          // only the signed-in person who made it (checked again in the runtime).
          const choiceRoute = /^\/api\/connections\/([a-z][a-z0-9-]{0,39})\/choices\/([A-Za-z0-9_-]{43})$/.exec(pathname);
          if (choiceRoute && harness.connectionSignInProvider?.(choiceRoute[1]) && harness.connectionChoice) {
            if (request.method === 'GET') { await requireManager(); return json(response, 200, await harness.connectionChoice(choiceRoute[1], choiceRoute[2], runAccess)); }
            if (request.method === 'POST' && harness.chooseConnectionAccounts) {
              const input = await body(request);
              const accounts = input.accounts;
              if (Object.keys(input).length !== 1 || !Array.isArray(accounts) || accounts.length < 1 || accounts.length > 20 ||
                  accounts.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'displayName'].includes(key)) ||
                    typeof (item as Record<string, unknown>).id !== 'string' || typeof (item as Record<string, unknown>).displayName !== 'string')) {
                throw new HttpError(400, 'invalid_connection', 'Choose one or more accounts to connect, each with a name.');
              }
              await requireManager();
              return json(response, 201, await harness.chooseConnectionAccounts(choiceRoute[1], choiceRoute[2], { accounts: accounts as { id: string; displayName: string }[] }, runAccess));
            }
            if (request.method === 'DELETE' && harness.cancelConnectionChoice) { await requireManager(); return json(response, 200, await harness.cancelConnectionChoice(choiceRoute[1], choiceRoute[2], runAccess)); }
          }
          const managed = /^\/api\/connections\/(conn_[0-9a-f]{24})\/(sync|schedule|disconnect|attempts|snapshots)$/.exec(pathname);
          const versionOnly = (input: Record<string, unknown>) => {
            if (Object.keys(input).length !== 1 || !Number.isSafeInteger(input.version) || (input.version as number) < 1) throw new HttpError(400, 'invalid_connection', 'Provide the current connection version.');
            return { version: input.version as number };
          };
          if (managed?.[2] === 'sync' && request.method === 'POST' && harness.syncConnection) {
            const input = versionOnly(await body(request));
            await requireManager();
            return json(response, 202, await harness.syncConnection(managed[1], input, runAccess));
          }
          if (managed?.[2] === 'schedule' && request.method === 'PUT' && harness.updateConnectionSchedule) {
            const input = await body(request);
            if (Object.keys(input).some(key => !['version', 'frequency', 'timeUtc', 'weekday', 'enabled', 'localTime', 'timezone'].includes(key)) || !Number.isSafeInteger(input.version) || (input.version as number) < 1) {
              throw new HttpError(400, 'invalid_sync_job', 'Provide the sync job version, a frequency, a UTC time, an optional weekday and whether it is enabled.');
            }
            await requireManager();
            return json(response, 200, { job: await harness.updateConnectionSchedule(managed[1], input as unknown as SyncScheduleInput & { version: number }, runAccess) });
          }
          if (managed?.[2] === 'disconnect' && request.method === 'POST' && harness.disconnectConnection) {
            const input = versionOnly(await body(request));
            await requireManager();
            return json(response, 200, await harness.disconnectConnection(managed[1], input, runAccess));
          }
          if (managed?.[2] === 'snapshots' && request.method === 'GET' && harness.listConnectionSnapshots) {
            await requireManager();
            return json(response, 200, { snapshots: harness.listConnectionSnapshots(managed[1]) });
          }
          if (managed?.[2] === 'attempts' && request.method === 'GET' && harness.listConnectionAttempts) {
            const values = url.searchParams.getAll('limit');
            if (values.length > 1 || (values.length === 1 && !/^([1-9]|[1-9][0-9]|100)$/.test(values[0]))) throw new HttpError(400, 'invalid_limit', 'Request 1–100 sync attempts.');
            await requireManager();
            return json(response, 200, { attempts: harness.listConnectionAttempts(managed[1], values.length ? Number(values[0]) : 20) });
          }
          // Freshness describes data every admitted member can already read (D-1), so it needs only read access.
          // Which connection supplied it is connection management information, returned to managers only.
          const visible = async (sources: SourceFreshness[]) => manages(await authorize()) ? sources
            : sources.map(({ sourceId, observedAt }) => ({ sourceId, observedAt }));
          if (pathname === '/api/sources/freshness' && request.method === 'GET' && harness.sourceFreshness) {
            const values = url.searchParams.getAll('ids');
            if (values.length !== 1 || values[0].length > 12_000) throw new HttpError(400, 'invalid_source_ids', 'Request freshness for 1–50 different source IDs.');
            return json(response, 200, { sources: await visible(harness.sourceFreshness(values[0].split(','))) });
          }
          const runFreshnessMatch = /^\/api\/runs\/([a-zA-Z0-9_-]{1,100})\/freshness$/.exec(pathname);
          if (runFreshnessMatch && request.method === 'GET' && harness.runFreshness) {
            const freshness = harness.runFreshness(runFreshnessMatch[1]);
            if (!freshness || (access && freshness.workspaceId !== access.workspaceId)) throw new HttpError(404, 'run_not_found', 'That run was not found.');
            const { workspaceId: _workspace, ...value } = freshness;
            return json(response, 200, { ...value, sources: await visible(value.sources) });
          }
        }
        const connectionResult = await driveRoute(options.drive, request, response, url, () => body(request));
        if (connectionResult) {
          if ('handled' in connectionResult) return;
          return json(response, connectionResult.status, connectionResult.value);
        }
        const streamMatch = /^\/api\/runs\/([a-zA-Z0-9_-]{1,100})\/events$/.exec(pathname);
        if (streamMatch && request.method === 'GET' && harness.getRunUpdate && harness.subscribe) {
          const rawCursor = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
          if (typeof rawCursor !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(rawCursor)) throw new HttpError(400, 'invalid_cursor', 'Provide a valid event cursor.');
          if (openStreams >= 16) throw new HttpError(429, 'stream_limit', 'Too many live task views are open. Close another view and retry.');
          const source = { getRunUpdate: (id: string, after: number) => {
            const update = harness.getRunUpdate!(id, after);
            return update && customerRunUpdate(update);
          }, subscribe: harness.subscribe };
          if (!source.getRunUpdate(streamMatch[1], Number(rawCursor))) throw new HttpError(404, 'run_not_found', 'That task was not found.');
          openStreams++;
          response.once('close', () => { openStreams--; });
          if (access) {
            let checking = false;
            const timer = setInterval(() => {
              if (checking || response.destroyed || response.writableEnded) return;
              checking = true;
              void authorize().catch(() => { response.end(); }).finally(() => { checking = false; });
            }, access.recheckMs ?? 30_000);
            timer.unref();
            response.once('close', () => clearInterval(timer));
          }
          streamRun(source, streamMatch[1], Number(rawCursor), response);
          return;
        }
        if (pathname.startsWith('/api/care/')) {
          const result = await careRoute(options.care, request.method ?? '', pathname, () => body(request));
          return json(response, result.status, result.value);
        }
        if (request.method === 'GET' && pathname === '/api/health') return json(response, 200, {status:'ok',mode:access ? 'authenticated' : 'local'});
        if (request.method === 'GET' && pathname === '/api/run-budget') return json(response, 200, (harness.runBudget ? harness.runBudget() : (await harness.workspace()).runBudget) ?? null);
        if (request.method === 'GET' && pathname === '/api/workspace') {
          const workspace = await harness.workspace();
          const sources = managesSources(session) ? workspace.sources
            : workspace.sources.map(({ connections: _connections, ...source }) => source);
          return json(response, 200, { ...workspace, sources, ...(desktop ? { desktop: true } : {}), provider: customerProvider(workspace.provider) });
        }
        if (request.method === 'GET' && pathname === '/api/tables') {
          const values=url.searchParams.getAll('before');
          if (values.length>1 || (values.length===1&&!/^[a-zA-Z0-9_-]{1,100}$/.test(values[0]))) throw new HttpError(400,'invalid_run_cursor','Use the returned table cursor.');
          const runs=harness.listRuns(undefined,values[0]);
          const tables=runs.flatMap(summary=>{
            const run=harness.getRun(summary.id);
            if (!run || (access && run.workspaceId !== access.workspaceId)) return [];
            const analysis=savedReportAnalysis(run);
            if (!analysis) return [];
            const rowCount=analysis.kind==='tabular' ? analysis.result.counts.includedRows
              : analysis.result.operation==='review' ? analysis.result.counts.includedRecords
              : analysis.result.operation==='compare' ? analysis.result.matchedRecords : analysis.result.eligiblePairs;
            const sourceName=analysis.kind==='tabular' ? harness.getSource(analysis.sourceId)?.title ?? 'Saved dataset'
              : [...new Set(analysis.result.observations.flatMap(item=>{ const source=item.sourceId ? harness.getSource(item.sourceId) : null; return source ? [source.title] : []; }))].join(' · ') || 'Connected source analysis';
            return [{runId:run.id,title:run.result?.title ?? run.task,createdAt:run.createdAt,rowCount,groupCount:analysis.result.rows.length,...(analysis.kind==='tabular' ? {datasetId:analysis.datasetId} : {}),calculationSourceId:analysis.sourceId,sourceName}];
          });
          return json(response,200,{tables,nextCursor:runs.length===100?runs.at(-1)!.id:null});
        }
        if (request.method === 'GET' && pathname === '/api/projects') return json(response,200,{projects:harness.listProjects?.() ?? []});
        if (request.method === 'POST' && pathname === '/api/projects' && harness.saveProject) {
          const input = await body(request);
          await authorize();
          return json(response,200,harness.saveProject(input as unknown as ProjectInput));
        }
        const projectMatch = /^\/api\/projects\/([a-zA-Z0-9_-]{16,80})$/.exec(pathname);
        if (request.method === 'GET' && projectMatch) {
          const project = harness.getProject?.(projectMatch[1]);
          if (!project) throw new HttpError(404,'project_not_found','That project was not found.');
          return json(response,200,{project,runs:(harness.projectRuns?.(project.id) ?? []).map(customerRun)});
        }
        if (request.method === 'GET' && pathname === '/api/schedules') return json(response,200,{schedules:harness.listSchedules?.() ?? [],runtimeEnabled:Boolean(harness.createSchedule)});
        if (request.method === 'POST' && pathname === '/api/schedules' && harness.createSchedule) {
          const input=await body(request,32_768);
          if (schedulesConnections(input)) await requireManager(); else await authorize();
          return json(response,201,await harness.createSchedule(input as unknown as ScheduleCreateInput,runAccess));
        }
        const scheduleMatch=/^\/api\/schedules\/([a-zA-Z0-9_-]{1,100})$/.exec(pathname);
        const scheduleEmailMatch = /^\/api\/schedules\/([a-zA-Z0-9_-]{1,100})\/email$/.exec(pathname);
        const scheduleEmailTestMatch = /^\/api\/schedules\/([a-zA-Z0-9_-]{1,100})\/email\/test$/.exec(pathname);
        if (scheduleEmailTestMatch && request.method === 'POST' && harness.testScheduleEmail) {
          const input = await body(request, 1024);
          await requireManager();
          return json(response, 200, await harness.testScheduleEmail(scheduleEmailTestMatch[1], input as { requestId: string; forceIntro?: boolean }, runAccess));
        }
        if (scheduleEmailMatch && request.method === 'GET' && harness.scheduleEmailStatus) {
          await requireManager();
          return json(response, 200, await harness.scheduleEmailStatus(scheduleEmailMatch[1], runAccess));
        }
        if (scheduleEmailMatch && request.method === 'PUT' && harness.updateScheduleEmail) {
          const input = await body(request, 1024);
          if (Object.keys(input).length !== 2 || Object.keys(input).some(key => !['version', 'enabled'].includes(key)) ||
              !Number.isSafeInteger(input.version) || (input.version as number) < 0 || typeof input.enabled !== 'boolean') throw new HttpError(400, 'invalid_report_email', 'Provide an email opt-in and current version only.');
          await requireManager();
          return json(response, 200, await harness.updateScheduleEmail(scheduleEmailMatch[1], input as { version: number; enabled: boolean }, runAccess));
        }
        if (scheduleMatch && request.method === 'PUT' && harness.updateSchedule) {
          const input=await body(request,32_768);
          if (schedulesConnections(input)) await requireManager(); else await authorize();
          return json(response,200,await harness.updateSchedule(scheduleMatch[1],input as unknown as ScheduleUpdateInput,runAccess));
        }
        if (scheduleMatch && request.method === 'DELETE' && harness.removeSchedule) {
          const input=await body(request);
          if (Object.keys(input).length!==1 || !Number.isSafeInteger(input.version) || (input.version as number)<1) throw new HttpError(400,'invalid_schedule','Provide the current schedule version.');
          await authorize();
          await harness.removeSchedule(scheduleMatch[1],input.version as number,runAccess);
          return json(response,200,{removed:true});
        }
        if (request.method === 'GET' && pathname === '/api/workflows') return json(response, 200, {workflows:harness.listWorkflows()});
        if (request.method === 'POST' && pathname === '/api/workflows') {
          const input = await body(request,32_768);
          if (input.weeklyReview !== undefined) await requireManager(); else await authorize();
          return json(response, 201, harness.createWorkflow(input as unknown as WorkflowCreateInput));
        }
        const workflowMatch = /^\/api\/workflows\/([a-zA-Z0-9_-]{1,100})(\/runs)?$/.exec(pathname);
        if (workflowMatch && request.method === 'GET') {
          const workflow = harness.getWorkflow(workflowMatch[1]);
          if (!workflow) throw new HttpError(404,'workflow_not_found','That workflow was not found.');
          return json(response, 200, workflowMatch[2] ? {runs:harness.listRuns(workflow.id).map(customerRun)} : workflow);
        }
        if (workflowMatch && request.method === 'PUT' && !workflowMatch[2]) {
          const input = await body(request,32_768);
          await authorize();
          if (input.weeklyReview !== undefined || harness.getWorkflow(workflowMatch[1])?.weeklyReview) await requireManager();
          return json(response, 200, harness.updateWorkflow(workflowMatch[1], input as unknown as WorkflowUpdateInput));
        }
        if (workflowMatch && request.method === 'POST' && workflowMatch[2]) {
          const value = await body(request,32_768);
          if (Object.keys(value).some(key => !['requestId','version','sourceIds'].includes(key)) || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.requestId) || !Number.isSafeInteger(value.version) || (value.version as number) < 1) throw new HttpError(400,'invalid_request','Provide a request ID and the saved workflow version.');
          const workflowSourceIds=value.sourceIds === undefined ? undefined : validateSourceIds(value.sourceIds);
          await authorize();
          if (harness.getWorkflow(workflowMatch[1])?.weeklyReview) await requireManager();
          modelAction = true;
          return json(response, 202, customerRun(await harness.startWorkflowRun(workflowMatch[1], {requestId:value.requestId,version:value.version as number,...(workflowSourceIds === undefined ? {} : {sourceIds:workflowSourceIds})}, runAccess)));
        }
        if (request.method === 'GET' && pathname === '/api/runs') {
          const values=url.searchParams.getAll('before');
          if (values.length>1 || (values.length===1&&!/^[a-zA-Z0-9_-]{1,100}$/.test(values[0]))) throw new HttpError(400,'invalid_run_cursor','Use the run ID returned as nextCursor.');
          const runs=harness.listRuns(undefined,values[0]);
          return json(response,200,{runs:runs.map(customerRun),nextCursor:runs.length===100?runs.at(-1)!.id:null});
        }
        const pendingRequestMatch = /^\/api\/run-requests\/([a-zA-Z0-9_-]{16,80})$/.exec(pathname);
        if (request.method === 'GET' && pendingRequestMatch && harness.getRunByRequest) {
          const run = harness.getRunByRequest(pendingRequestMatch[1],runAccess);
          return json(response,200,{run:run ? customerRun(run) : null});
        }
        if (request.method === 'POST' && pathname === '/api/run-requests/cancel' && harness.cancelPendingRun) {
          const value = await body(request,32_768);
          if (Object.keys(value).some(key => !['task','requestId','sourceIds'].includes(key)) || typeof value.task !== 'string' || !value.task.trim() || value.task.length > 4000 || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.requestId)) throw new HttpError(400,'invalid_request','Provide the original Home task and request ID.');
          const sourceIds=value.sourceIds === undefined ? undefined : validateSourceIds(value.sourceIds);
          await authorize();
          return json(response,200,customerRun(await harness.cancelPendingRun({task:value.task,requestId:value.requestId,...(sourceIds === undefined ? {} : {sourceIds})},runAccess)));
        }
        if (request.method === 'POST' && pathname === '/api/runs') {
          const value = await body(request,32_768);
          if (Object.keys(value).some(key => !['task','requestId','parentRunId','projectId','sourceIds'].includes(key))) throw new HttpError(400,'invalid_request','Only task, requestId, parentRunId, projectId and sourceIds are accepted.');
          if (value.projectId !== undefined && (typeof value.projectId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.projectId))) throw new HttpError(400,'invalid_project','Provide a valid project.');
          if (typeof value.task !== 'string' || !value.task.trim() || value.task.length > 4000) throw new HttpError(400,'invalid_task','Enter a task of 1–4,000 characters.');
          if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.requestId)) throw new HttpError(400,'invalid_request_id','A valid request ID is required.');
          if (value.parentRunId !== undefined && (typeof value.parentRunId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.parentRunId))) throw new HttpError(400,'invalid_parent_run','Provide a valid previous task.');
          const sourceIds=value.sourceIds === undefined ? undefined : validateSourceIds(value.sourceIds);
          await authorize();
          modelAction = true;
          return json(response, 202, customerRun(await harness.startRun({task:value.task.trim(), requestId:value.requestId, ...(sourceIds === undefined ? {} : {sourceIds}), ...(value.projectId !== undefined ? {projectId:value.projectId as string} : {}), ...(value.parentRunId !== undefined ? {parentRunId:value.parentRunId as string} : {})}, runAccess)));
        }
        const explanationRetryMatch = /^\/api\/runs\/([a-zA-Z0-9_-]{1,100})\/retry-explanation$/.exec(pathname);
        if (explanationRetryMatch && request.method === 'POST' && harness.retryExplanation) {
          const value = await body(request,4096);
          if (Object.keys(value).length !== 1 || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.requestId)) throw new HttpError(400,'invalid_request','Only a valid request ID is accepted. The saved calculation cannot be replaced.');
          await authorize();
          modelAction = true;
          return json(response,202,customerRun(await harness.retryExplanation(explanationRetryMatch[1],value.requestId,runAccess)));
        }
        const answerExportMatch = /^\/api\/runs\/([a-zA-Z0-9_-]{1,100})\/answer\.md$/.exec(pathname);
        if (answerExportMatch && request.method === 'GET') {
          const run = harness.getRun(answerExportMatch[1]);
          if (!run || (access && run.workspaceId !== access.workspaceId)) throw new HttpError(404,'export_not_found','That saved answer was not found.');
          const output = run.result ?? run.reply;
          const analysis = output?.tabularAnalysis;
          const dataset = analysis && !analysis.postLabels ? harness.getTabularDataset?.(analysis.datasetId) : undefined;
          const enriched = dataset && analysis ? {...output!,tabularAnalysis:{...analysis,postLabels:Object.fromEntries(postPresentations(dataset.dataset,analysis.result))}} : output;
          const document = answerDocument({...run,...(run.result ? {result:enriched as NonNullable<typeof run.result>} : {reply:enriched})});
          if (!document) throw new HttpError(404,'export_not_found','That task has no saved answer.');
          await authorize();
          const filename = document.title.replace(/[^a-z0-9]+/gi,'-').slice(0,70) || 'rivet-answer';
          response.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="${filename}.md"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
          return response.end(document.content);
        }
        const chartExportMatch = /^\/api\/runs\/([a-zA-Z0-9_-]{1,100})\/(tabular|source)\.svg$/.exec(pathname);
        if (chartExportMatch && request.method === 'GET') {
          const run = harness.getRun(chartExportMatch[1]);
          if (!run || (access && run.workspaceId !== access.workspaceId)) throw new HttpError(404,'export_not_found','That saved chart was not found.');
          const svg = chartDownload(run,chartExportMatch[2] as 'tabular'|'source',url.searchParams);
          await authorize();
          response.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Content-Disposition':'attachment; filename="rivet-chart.svg"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"});
          return response.end(svg);
        }
        const tabularExportMatch = /^\/api\/runs\/([a-zA-Z0-9_-]{1,100})\/tabular\.(csv|json)$/.exec(pathname);
        if (tabularExportMatch && request.method === 'GET') {
          const run = harness.getRun(tabularExportMatch[1]);
          const analysis = run?.result?.tabularAnalysis ?? run?.reply?.tabularAnalysis ?? run?.savedCalculation?.analysis;
          if (!run || !analysis || (access && run.workspaceId !== access.workspaceId)) throw new HttpError(404,'export_not_found','No saved CSV analysis is available for export.');
          await authorize();
          if (tabularExportMatch[2] === 'json') return json(response,200,analysis);
          const dataset = !analysis.postLabels ? harness.getTabularDataset?.(analysis.result.datasetId) : undefined;
          const labels = analysis.postLabels ? new Map(Object.entries(analysis.postLabels)) : dataset ? postPresentations(dataset.dataset,analysis.result) : undefined;
          response.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="social-analysis.csv"','Cache-Control':'no-store'});
          return response.end(exportAnalysisCsv(analysis.result, labels));
        }
        const socialCsvMatch = /^\/api\/runs\/([a-zA-Z0-9_-]{1,100})\/social\.csv$/.exec(pathname);
        if (socialCsvMatch && request.method === 'GET') {
          const run = harness.getRun(socialCsvMatch[1]);
          const analysis = run?.result?.socialAnalysis;
          if (!run || !analysis || (access && run.workspaceId !== access.workspaceId)) throw new HttpError(404, 'export_not_found', 'No saved social report is available for export.');
          response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="social-posts.csv"', 'Cache-Control': 'no-store' });
          return response.end(socialAnalysisCsv(analysis));
        }
        const sessionMatch = /^\/api\/runs\/([a-zA-Z0-9_-]{1,100})\/session$/.exec(pathname);
        if (sessionMatch && request.method === 'GET') {
          const turns = harness.getRunSession?.(sessionMatch[1]) ?? (harness.getRun(sessionMatch[1]) ? [harness.getRun(sessionMatch[1])!] : undefined);
          if (!turns) throw new HttpError(404,'run_not_found','That conversation was not found.');
          return json(response, 200, {turns:turns.map(customerRun)});
        }
        const runMatch = /^\/api\/runs\/([a-zA-Z0-9_-]{1,100})(\/cancel)?$/.exec(pathname);
        if (runMatch && request.method === 'GET' && !runMatch[2]) {
          const run = harness.getRun(runMatch[1]);
          if (!run) throw new HttpError(404,'run_not_found','That run was not found.');
          return json(response, 200, customerRun(run));
        }
        if (runMatch && request.method === 'POST' && runMatch[2]) {
          await body(request);
          await authorize();
          const run = harness.cancelRun(runMatch[1]);
          if (!run) throw new HttpError(404,'run_not_found','That run was not found.');
          return json(response, 200, customerRun(run));
        }
        const sourceMatch = /^\/api\/sources\/([a-zA-Z0-9_.-]{1,160})$/.exec(pathname);
        if (sourceMatch && request.method === 'GET') {
          const source = harness.getSource(sourceMatch[1]);
          if (!source) throw new HttpError(404,'source_not_found','That source was not found.');
          return json(response, 200, source);
        }
        throw new HttpError(404,'not_found','That API route was not found.');
      }
      if (!['GET','HEAD'].includes(request.method ?? '')) throw new HttpError(405,'method_not_allowed','This route only accepts GET.');
      let target = path.resolve(root, '.' + pathname);
      if (target !== root && !target.startsWith(root + path.sep)) throw new HttpError(404,'not_found','Page not found.');
      if (pathname === '/' || pathname === '/onboarding' || (options.organizations && ['/admin','/join','/join/complete','/team','/workspaces'].includes(pathname))) target = path.join(root, 'index.html');
      let file;
      try {
        if (!(await stat(target)).isFile()) throw new Error();
        file = await readFile(target);
        if (pathname === '/onboarding') {
          const mode = access ? options.organizations ? 'authenticated' : 'pilot' : options.organizations?.mode ?? 'local';
          file = Buffer.from(file.toString('utf8').replace('<head>', `<head><meta name="rivet-onboarding" content="${mode}">`));
        }
        const billingMarker = options.customerWorkspace?.testBilling ? 'hosted' : options.customerWorkspace?.localBillingPreview ? 'local' : undefined;
        if (billingMarker && path.extname(target) === '.html')
          file = Buffer.from(file.toString('utf8').replace('<head>', `<head><meta name="rivet-test-billing" content="${billingMarker}">`));
      } catch { throw new HttpError(404,'not_found','Run npm run build, or open the development workspace on port 5190.'); }
      response.writeHead(200, {'Content-Type':mime[path.extname(target)] ?? 'application/octet-stream','Cache-Control':'no-cache'});
      response.end(request.method === 'HEAD' ? undefined : file);
    } catch (error) {
      if (response.headersSent) return response.end();
      const candidate = error as {status?:number;code?:string;message?:string};
      const known = Number.isInteger(candidate.status) && candidate.status! >= 400 && candidate.status! <= 599;
      json(response, known ? candidate.status! : 500, {error:{code:known ? candidate.code ?? 'request_failed' : 'internal_error',message:known ? (modelAction ? customerError(candidate.code, candidate.message) : candidate.message) : 'The request could not be completed.',...(error instanceof TabularInputError ? {diagnostics:error.diagnostics} : {})}});
    }
  };
}
