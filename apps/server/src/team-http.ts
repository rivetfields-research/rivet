import type { IncomingMessage } from 'node:http';
import type { OrganizationIdentity } from '../../../packages/core/src/organization-types.ts';
import type { OrganizationAdmin } from './organizations-http.ts';
import { OrganizationError, organizationIdentityKey } from './organizations.ts';
import { InvitationDeliveryError } from './entra-invitations.ts';

const invalid = () => new OrganizationError(400, 'invalid_input', 'Unexpected fields in this request.');
function fields(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw invalid();
}
export async function teamRoute(options: OrganizationAdmin, request: IncomingMessage, pathname: string,
  readBody: () => Promise<Record<string, unknown>>, identity: OrganizationIdentity, header: string) {
  const match = /^\/api\/team\/([\w-]{1,64})(?:\/(invitations|members)(?:\/([\w-]{1,64})(?:\/(cancel))?)?)?$/.exec(pathname);
  if (!match || options.mode !== 'authenticated') throw new OrganizationError(404, 'route_not_found', 'Team action not found.');
  const [, id, kind, target, action] = match, store = options.store;
  const owner = () => { if (store.lookupMembership(id, identity)?.role !== 'owner') throw new OrganizationError(403, 'team_admin_required', 'Only this team’s administrator can manage its members.'); };
  const recheck = async () => {
    const current = await options.authenticate(request.headers[header]);
    if (organizationIdentityKey(current) !== organizationIdentityKey(identity)) throw new OrganizationError(403, 'account_changed', 'Your signed-in account changed. Reload before continuing.');
    owner();
  };
  owner();
  if (!kind && request.method === 'GET') return {status: 200, value: store.detail(id)};
  const input = await readBody(), fresh = await options.authenticate(request.headers[header]);
  if (organizationIdentityKey(fresh) !== organizationIdentityKey(identity)) throw new OrganizationError(403, 'account_changed', 'Your signed-in account changed. Reload before continuing.');
  owner();
  if (kind === 'invitations' && !target && request.method === 'POST') {
    fields(input, ['version', 'email', 'role']);
    const delivery = options.invitationDelivery;
    if (!delivery) throw new OrganizationError(409, 'invitations_disabled', 'Team invitation delivery is not configured.');
    const created = store.invite(id, input, fresh, true);
    const check = () => { owner(); store.checkInvitation(id, created.invitationId); };
    try {
      await delivery.deliver({email: String(input.email).trim(), organization: created.detail.name, token: created.token},
        person => { check(); store.bindInvitation(id, created.invitationId, person); }, check);
      await recheck();
      return {status: 201, value: {detail: store.invitationDelivery(id, created.invitationId, 'submitted', fresh), delivery: 'submitted'}};
    } catch (error) {
      const issue = error instanceof InvitationDeliveryError ? error : null;
      store.invitationDelivery(id, created.invitationId, 'failed', fresh, issue?.stage);
      await recheck();
      return {status: 201, value: {detail: store.detail(id), delivery: 'failed',
        deliveryMessage: issue?.message ?? 'Invitation setup did not complete. Check its status before sending again.'}};
    }
  }
  if (kind === 'invitations' && target && action === 'cancel' && request.method === 'POST') {
    fields(input, ['version']); return {status: 200, value: store.invitationAction(id, target, 'cancel', input.version, fresh)};
  }
  if (kind === 'members' && target && !action && request.method === 'PATCH') {
    fields(input, ['version', 'role', 'active']); return {status: 200, value: store.member(id, target, input, fresh)};
  }
  throw new OrganizationError(404, 'route_not_found', 'Team action not found.');
}
