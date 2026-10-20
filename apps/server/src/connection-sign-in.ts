import type { ServerResponse } from 'node:http';
import {
  createOAuthPendingStore, localSignInRedirect, newOAuthBinding, oauthCookieHeader, oauthRedirectUri,
  type LocalCallbackHost, type OAuthActor, type OAuthPendingStore, type PendingOAuth,
} from '../../../packages/core/src/oauth.ts';
import type { Connection } from '../../../packages/core/src/connections.ts';
import type { RunAccessContext } from '../../../packages/core/src/types.ts';
import { HarnessError } from '../../../packages/core/src/errors.ts';
import { reportSignInFailure } from './connection-sign-in-failure.ts';

/*
 * Account sign-in routes for scheduled data connections (M7). The runtime decides who may connect and seals the
 * tokens; this module owns the HTTP parts: the one-use pending sign-ins, the browser-binding cookie, the exact
 * redirect URI and where the browser returns. Failure logs contain only fixed categories, never codes or tokens.
 *
 *   Local:  POST /api/connections/<provider>/authorize, then GET /api/connections/<provider>/callback (cross-site
 *           exemption for exactly that path, top-level navigations only).
 *   Hosted: POST …/api/connections/<provider>/authorize inside the runtime, then the one fixed root path
 *           GET /connections/<provider>/callback, handled by the outer server before `/w/` dispatch and the legacy
 *           gate (D-4). It needs the verified issuer and subject that started the sign-in and `mutate` permission.
 */

/** Provider IDs that can have a sign-in route: the OAuth core's path- and cookie-safe form. */
export const SIGN_IN_PROVIDER = /^[a-z][a-z0-9-]{0,39}$/;
/** Ten minutes, the pending sign-in's lifetime. */
const COOKIE_SECONDS = 600;

/** What a pending sign-in remembers. Never a secret: the PKCE verifier lives beside it in the pending store. */
export interface SignInContext {
  /** The runtime's connection workspace: `local`, the pilot workspace, or a private `person_<uuid>`. */
  workspaceId: string;
  /** Customer mode: the organization whose private workspace started the sign-in. */
  organizationId: string | null;
  /** The connection to reconnect, or null for a new one (created only when the sign-in completes). */
  connectionId: string | null;
  displayName: string;
  /** The platform selected in Rivet, within a shared sign-in such as Meta. */
  product?: string;
  /** The exact redirect URI sent to the provider; the code exchange must use the same one. */
  redirectUri: string;
  /** Local mode: the allowed loopback app origin to return to. */
  returnOrigin: string | null;
}
export type ConnectionSignIns = OAuthPendingStore<SignInContext>;

/**
 * One store per process. The legacy runtime and every private runtime share it, so the hosted root callback can
 * find the runtime a sign-in belongs to (state hash → workspace and verified actor). In memory only: a restart
 * ends every sign-in in progress, and nothing about it is written to disk.
 */
export function createConnectionSignIns(mode: 'local' | 'hosted', now?: () => number): ConnectionSignIns {
  return createOAuthPendingStore<SignInContext>({ mode, ...(now ? { now } : {}) });
}

/** The runtime calls the routes need (`createHarness` provides them when connections are enabled). */
export interface SignInHarness {
  connectionSignInProvider?(provider: string): { id: string; label: string; localHost: LocalCallbackHost } | undefined;
  prepareConnectionSignIn?(input: { provider: string; displayName?: string; connectionId?: string; product?: string }, context?: RunAccessContext): Promise<{ connectionId: string | null; displayName: string; product?: string }>;
  connectionAuthorizationUrl?(provider: string, input: { state: string; codeChallenge?: string; redirectUri: string }): string;
  /** Answers with the connection, or (a sign-in that lists accounts, M8) a one-use choice of accounts to connect. */
  completeConnectionSignIn?(input: { provider: string; code: unknown; verifier: string; redirectUri: string; target: { connectionId: string | null; displayName: string; product?: string }; actor: OAuthActor | null; current?: () => boolean }, context?: RunAccessContext): Promise<{ connection?: Omit<Connection, 'owner' | 'grantKey'>; choice?: { id: string } }>;
}

export function validSignInBody(input: Record<string, unknown>): input is { displayName?: string; connectionId?: string; product?: string } {
  return !Object.keys(input).some(key => !['displayName', 'connectionId', 'product'].includes(key)) &&
    (input.product === undefined || (typeof input.product === 'string' && SIGN_IN_PROVIDER.test(input.product))) &&
    (input.displayName === undefined || typeof input.displayName === 'string') &&
    (input.connectionId === undefined || (typeof input.connectionId === 'string' && /^conn_[0-9a-f]{24}$/.test(input.connectionId)));
}

/**
 * `POST …/api/connections/<provider>/authorize`. The caller has already been authorized as a connection manager
 * with `mutate`. Returns the provider URL and the cookie that binds the sign-in to this browser.
 */
export async function beginSignIn(harness: SignInHarness, signIns: ConnectionSignIns, input: {
  provider: { id: string; localHost: LocalCallbackHost };
  body: { displayName?: string; connectionId?: string; product?: string };
  runAccess: RunAccessContext | undefined;
  workspaceId: string;
  organizationId: string | null;
  /** Hosted: the configured HTTPS app origin. Local: the page's allowed loopback origin and the server's own port. */
  mode: { mode: 'hosted'; appOrigin: string } | { mode: 'local'; pageOrigin: string; port: number };
}): Promise<{ value: { url: string; restart?: true }; cookie?: string }> {
  const { provider, mode } = input;
  if (mode.mode === 'local') {
    // A cookie set on 127.0.0.1 never reaches localhost (and the reverse): start on the callback host first.
    const page = new URL(mode.pageOrigin);
    const destination = new URLSearchParams({ view: 'tables', ...(input.body.connectionId
      ? { sourceConnection: input.body.connectionId } : { connect: input.body.product ?? provider.id }) });
    const restart = localSignInRedirect(page.host, provider, Number(page.port || 80), `/?${destination}`);
    if (restart) return { value: { url: restart, restart: true } };
  }
  const target = await harness.prepareConnectionSignIn!({ provider: provider.id, ...input.body }, input.runAccess);
  const redirectUri = mode.mode === 'hosted' ? oauthRedirectUri(provider, { mode: 'hosted', appOrigin: mode.appOrigin }) : oauthRedirectUri(provider, { mode: 'local', port: mode.port });
  const binding = newOAuthBinding();
  const actor = input.runAccess ? { issuer: input.runAccess.actor.issuer, subject: input.runAccess.actor.subject } : null;
  const begun = signIns.begin({ provider: provider.id, actor, binding, context: {
    workspaceId: input.workspaceId, organizationId: input.organizationId, connectionId: target.connectionId, displayName: target.displayName, redirectUri,
    ...(target.product ? { product: target.product } : {}),
    returnOrigin: mode.mode === 'local' ? new URL(mode.pageOrigin).origin : null,
  } });
  const url = harness.connectionAuthorizationUrl!(provider.id, { state: begun.state, codeChallenge: begun.codeChallenge, redirectUri });
  return { value: { url }, cookie: oauthCookieHeader(provider.id, mode.mode, binding, COOKIE_SECONDS) };
}

/** The callback's query: the provider's error, or a code. The state is read separately. */
export function callbackQuery(url: URL): { code: string | null; providerError: boolean } {
  return { code: url.searchParams.get('code'), providerError: url.searchParams.has('error') };
}

/**
 * Completes a taken sign-in in its runtime. Every failure (the user cancelled at the provider, a refused code,
 * a changed membership, a missing key) is the same plain "failed" result; only a safe category is logged.
 */
export type SignInOutcome = { result: 'connected' | 'failed'; connectionId: string | null; reason?: 'instagram_account_missing' } | { result: 'choose'; connectionId: null; provider: string; choiceId: string };
export async function finishSignIn(harness: SignInHarness, signIns: ConnectionSignIns, pending: PendingOAuth<SignInContext>, query: { code: string | null; providerError: boolean }, runAccess: RunAccessContext | undefined): Promise<SignInOutcome> {
  const failed = { result: 'failed' as const, connectionId: pending.context.connectionId };
  if (query.providerError || !query.code || !harness.completeConnectionSignIn) {
    const reason = query.providerError ? 'oauth_provider_declined' : !query.code ? 'oauth_code_missing' : 'oauth_handler_missing';
    reportSignInFailure(new HarnessError('Sign-in did not finish.', 400, reason));
    return failed;
  }
  try {
    const { connection, choice } = await harness.completeConnectionSignIn({ provider: pending.provider, code: query.code, verifier: pending.verifier,
      redirectUri: pending.context.redirectUri, target: { connectionId: pending.context.connectionId, displayName: pending.context.displayName,
        ...(pending.context.product ? { product: pending.context.product } : {}) },
      actor: pending.actor, current: () => signIns.isLatest(pending) }, runAccess);
    if (choice && /^[A-Za-z0-9_-]{43}$/.test(choice.id)) return { result: 'choose', connectionId: null, provider: pending.provider, choiceId: choice.id };
    return connection ? { result: 'connected', connectionId: connection.id } : failed;
  } catch (error) {
    reportSignInFailure(error);
    return error instanceof HarnessError && error.code === 'oauth_no_instagram_accounts' ? { ...failed, reason: 'instagram_account_missing' } : failed;
  }
}

/**
 * Where the browser returns: the Settings view of the workspace that started the sign-in. A sign-in that lists
 * accounts (M8) returns with its one-use choice, which is useless to anyone but the signed-in actor who made it.
 */
export function signInReturnPath(outcome: SignInOutcome, base = '/'): string {
  const query = new URLSearchParams({ view: outcome.result === 'failed' && outcome.reason === 'instagram_account_missing' ? 'tables' : 'workspace',
    ...(outcome.result === 'failed' && outcome.reason === 'instagram_account_missing' ? { connect: 'instagram', reason: outcome.reason } : {}),
    ...(outcome.connectionId ? { connection: outcome.connectionId } : {}), result: outcome.result,
    ...(outcome.result === 'choose' ? { provider: outcome.provider, choice: outcome.choiceId } : {}) });
  return `${base}?${query.toString()}`;
}

/** 303 to the app; the one-use cookie is cleared on every callback answer. */
export function redirectAfterSignIn(response: ServerResponse, location: string) {
  response.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  response.end();
}

/**
 * Local mode only. A provider whose login is on another site (Meta: facebook.com, then `localhost`) makes every hop of
 * the redirect chain cross-site, and the local server refuses cross-site requests outside the exact callback path
 * (C9). So the local callback answers with a tiny page that sends the browser on from this origin, which makes the next
 * navigation same-origin; the local cross-site rule stays exactly as strict. No script (the CSP allows none inline).
 */
export function returnAfterLocalSignIn(response: ServerResponse, location: string) {
  if (!/^(http:\/\/(127\.0\.0\.1|localhost):\d{1,5})?\/\?[A-Za-z0-9=&_.:-]*$/.test(location)) throw new Error('Unexpected sign-in return address.');
  const escaped = location.replace(/&/g, '&amp;');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escaped}"><title>Returning to Rivet</title></head>`
    + `<body><p><a href="${escaped}">Return to Rivet</a></p></body></html>`);
}
