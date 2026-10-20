import { OrganizationError } from './organizations.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { OrganizationIdentity } from '../../../packages/core/src/organization-types.ts';

const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface InvitationDelivery {
  deliver(input: {email: string; organization: string; token: string}, bind: (identity: OrganizationIdentity) => void, check: () => void): Promise<void>;
}

type Stage = 'credentials' | 'guest' | 'access' | 'email';
const messages: Record<Stage, string> = {
  credentials: 'Invitation setup could not authenticate with Microsoft. Contact a Rivet administrator.',
  guest: 'Microsoft could not prepare the guest account. Use Send again to retry.',
  access: 'Microsoft app access could not be confirmed. No invitation email was requested. Use Send again to retry.',
  email: 'App access is ready, but Microsoft did not confirm the email request. Check the inbox before using Send again.',
};
export class InvitationDeliveryError extends OrganizationError {
  constructor(public stage: Stage, public diagnostic: {status?: number; requestId?: string; providerCode?: string} = {}) {
    super(503, 'invitation_delivery_failed', messages[stage]);
  }
}
class GraphFailure extends Error {
  constructor(public status: number, public retryAfter: number, public missingPrincipal: boolean,
    public diagnostic: InvitationDeliveryError['diagnostic']) { super('Microsoft invitation request failed.'); }
}
const providerCodes = new Set(['Request_BadRequest', 'Request_ResourceNotFound', 'Authorization_RequestDenied', 'TooManyRequests', 'ServiceUnavailable', 'InternalServerError']);

export function createEntraInvitations(config: {clientId: string; tenantId: string; servicePrincipalId: string; appOrigin: string}, fetcher: typeof fetch = fetch,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = async (ms, signal) => { await delay(ms, undefined, {signal}); }): InvitationDelivery {
  if (![config.clientId, config.tenantId, config.servicePrincipalId].every(value => guid.test(value)) || new URL(config.appOrigin).origin !== config.appOrigin || !config.appOrigin.startsWith('https://')) throw new Error('Configure the invitation managed identity, tenant, Rivet application and HTTPS origin.');
  return {
    async deliver(input, bind, check) {
      const deadline = AbortSignal.timeout(45000);
      let stage: Stage = 'credentials';
      const unavailable = () => new InvitationDeliveryError(stage);
      const retry = async <T>(operation: () => Promise<T>): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          check(); deadline.throwIfAborted();
          try { return await operation(); }
          catch (error) {
            const transient = error instanceof GraphFailure &&
              (error.status === 429 || error.status >= 500 || (stage === 'access' && (error.status === 404 || error.status === 409 || error.missingPrincipal)));
            if (!transient || attempt >= 4) throw error;
            check();
            await wait(Math.min(45000, Math.max(1000 * 2 ** attempt, error.retryAfter)), deadline);
          }
        }
      };
      try {
        check();
        const metadata = new URL('http://169.254.169.254/metadata/identity/oauth2/token');
        metadata.search = new URLSearchParams({'api-version': '2018-02-01', resource: 'https://graph.microsoft.com/', client_id: config.clientId}).toString();
        const response = await fetcher(metadata, {headers: {Metadata: 'true'}, redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)])});
        if (!response.ok) throw unavailable();
        const credentials = await response.json() as {access_token?: string};
        if (!credentials.access_token) throw unavailable();
        const graph = async (route: string, body?: unknown) => {
          check();
          let result: Response;
          try { result = await fetcher(`https://graph.microsoft.com/v1.0${route}`, {
            method: body === undefined ? 'GET' : 'POST', headers: {Authorization: `Bearer ${credentials.access_token}`, 'Content-Type': 'application/json'},
            ...(body === undefined ? {} : {body: JSON.stringify(body)}), redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]),
          }); } catch {
            // Access operations are reconciled before retry; email is never blindly replayed.
            throw new GraphFailure(503, 0, false, {});
          }
          if (!result.ok) {
            const data = await result.json().catch(() => null) as {error?: {code?: string; message?: string}} | null;
            const requestId = result.headers.get('request-id');
            const retryAfter = result.headers.get('retry-after');
            const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 0;
            const date = retryAfter && !/^\d+$/.test(retryAfter) ? Date.parse(retryAfter) : NaN;
            throw new GraphFailure(result.status, Math.max(seconds * 1000, Number.isFinite(date) ? date - Date.now() : 0),
              result.status === 400 && /does not exist|not (?:a )?valid reference|resource.+not found/i.test(data?.error?.message ?? ''), {
                status: result.status, ...(requestId && guid.test(requestId) ? {requestId} : {}),
                ...(providerCodes.has(data?.error?.code ?? '') ? {providerCode: data!.error!.code} : {}),
              });
          }
          return await result.json();
        };
        const redirect = new URL('/join', config.appOrigin);
        redirect.hash = input.token;
        const invitation = {invitedUserEmailAddress: input.email, inviteRedirectUrl: redirect.href};
        // Prepare access before requesting email, so a fast click cannot race assignment.
        stage = 'guest';
        const prepared = await retry(() => graph('/invitations', {...invitation, sendInvitationMessage: false}));
        const userId = prepared.invitedUser?.id;
        if (typeof userId !== 'string' || !guid.test(userId)) throw unavailable();
        const route = `/servicePrincipals/${config.servicePrincipalId}/appRoleAssignedTo`;
        stage = 'access';
        const hasAssignment = async () => {
          let next: string | undefined = `${route}?${new URLSearchParams({'$select': 'principalId,appRoleId', '$top': '999'})}`;
          for (let page = 0; next && page < 10; page++) {
            const existing = await graph(next);
            if (!Array.isArray(existing.value)) throw unavailable();
            if (existing.value.some((item: {principalId: string}) => item.principalId === userId)) return true;
            const continuation = existing['@odata.nextLink'];
            if (continuation) {
              const url = new URL(continuation);
              if (url.origin !== 'https://graph.microsoft.com' || url.pathname !== `/v1.0${route}`) throw unavailable();
              next = `${route}${url.search}`;
            } else next = undefined;
          }
          if (next) throw unavailable();
          return false;
        };
        await retry(async () => {
          if (await hasAssignment()) return;
          try {
            await graph(route, {principalId: userId, resourceId: config.servicePrincipalId, appRoleId: '00000000-0000-0000-0000-000000000000'});
          } catch (error) {
            // A duplicate or lost response may mean another request already granted access.
            if (error instanceof GraphFailure && [400, 409, 503, 504].includes(error.status) && await hasAssignment()) return;
            throw error;
          }
          if (!await hasAssignment()) throw new GraphFailure(409, 0, false, {status: 409});
        });
        check();
        bind({issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`, subject: userId});
        // Supplying invitedUser invokes a higher-privilege redemption operation.
        // A normal repeat invitation reuses the guest by the original email.
        stage = 'email';
        const sent = await graph('/invitations', {...invitation, sendInvitationMessage: true,
          invitedUserMessageInfo: {customizedMessageBody: `You have been invited to ${input.organization} on Rivet. Accept this invitation and sign in to join. Your Rivet invitation expires in 7 days.`}});
        if (sent.invitedUser?.id !== userId) throw unavailable();
      } catch (error) {
        if (error instanceof OrganizationError) throw error;
        throw new InvitationDeliveryError(stage, error instanceof GraphFailure ? error.diagnostic : {});
      }
    },
  };
}
