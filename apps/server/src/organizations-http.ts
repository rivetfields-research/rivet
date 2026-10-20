import { lstatSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AccessAuthenticator } from './access-auth.ts';
import { OrganizationError, OrganizationStore, organizationIdentityKey } from './organizations.ts';
import type { OrganizationDetail, OrganizationIdentity } from '../../../packages/core/src/organization-types.ts';
import type { ModelAllowanceSnapshot } from '../../../packages/core/src/workspace-diagnostics.ts';
import { InvitationDeliveryError, type InvitationDelivery } from './entra-invitations.ts';
import type { createUsageAdministration } from './usage-admin.ts';
import { teamRoute } from './team-http.ts';

export interface OrganizationAdmin {
  store: OrganizationStore;
  mode: 'local' | 'authenticated';
  authenticate(assertion: string | string[] | undefined): Promise<OrganizationIdentity>;
  isStaff(identity: OrganizationIdentity): boolean;
  accountOwners?: () => OrganizationIdentity[];
  isAccountOwner?: (identity: OrganizationIdentity) => boolean;
  provisionWorkspace?(id: string, version: unknown, actor: OrganizationIdentity): OrganizationDetail;
  workspaceUsage?(id: string): ModelAllowanceSnapshot | null;
  invitationDelivery?: InvitationDelivery;
  prepareWorkspace?(id: string, identity: OrganizationIdentity): string;
  usage?: ReturnType<typeof createUsageAdministration>;
}
export function readStaffFile(filename: string): OrganizationIdentity[] {
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || (stat.mode & 0o077)) throw new Error();
      const value = JSON.parse(readFileSync(filename, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.staff) || value.staff.length < 1 || value.staff.length > 20) throw new Error();
      const keys = value.staff.map((item: OrganizationIdentity) => organizationIdentityKey(item));
      if (new Set(keys).size !== keys.length) throw new Error();
      return value.staff;
    } catch { throw new OrganizationError(503, 'admin_unavailable', 'Staff access verification is temporarily unavailable.'); }
}
export function staffFileLookup(filename: string) {
  readStaffFile(filename);
  return (identity: OrganizationIdentity) => readStaffFile(filename).some(owner => organizationIdentityKey(owner) === organizationIdentityKey(identity));
}
export function createOrganizationAdmin(filename: string, options?: { auth: AccessAuthenticator; staffFile: string }): OrganizationAdmin {
  const isAccountOwner = options ? staffFileLookup(options.staffFile) : () => true;
  const store = new OrganizationStore(filename);
  return {
    store, mode: options ? 'authenticated' : 'local',
    isAccountOwner, accountOwners: options ? () => readStaffFile(options.staffFile) : () => [{issuer: 'local://organization-admin', subject: 'local-operator', displayName: 'Local administrator'}],
    isStaff: identity => isAccountOwner(identity) || store.hasStaffGrant(identity),
    authenticate: options ? assertion => options.auth.authenticate(assertion) : async () => ({issuer: 'local://organization-admin', subject: 'local-operator', displayName: 'Local administrator'}),
  };
}
export async function organizationRoute(options: OrganizationAdmin, request: IncomingMessage, pathname: string, readBody: () => Promise<Record<string, unknown>>, assertionHeader: string) {
  const identity = await options.authenticate(request.headers[assertionHeader]);
  if (pathname.startsWith('/api/signup/') || pathname.startsWith('/api/admin/signup-invitations')) throw new OrganizationError(410, 'signup_retired', 'Team creator signup has been retired. Ask Rivet staff to create your organization and invite you.');
  if (pathname.startsWith('/api/team/')) return teamRoute(options, request, pathname, readBody, identity, assertionHeader);
  if (pathname === '/api/organization-session' && request.method === 'GET') return {status: 200, value: {mode: options.mode, staff: options.isStaff(identity), displayName: identity.displayName ?? 'Your account', provisioningEnabled: Boolean(options.prepareWorkspace), usageEnabled: Boolean(options.usage), adminAccessEnabled: Boolean(options.accountOwners)}};
  if (pathname === '/api/organization-workspaces' && request.method === 'GET') {
    if (options.mode !== 'authenticated') throw new OrganizationError(409, 'sign_in_required', 'Customer workspaces require verified sign-in.');
    return {status: 200, value: {workspaces: options.store.workspacesFor(identity)}};
  }
  if (pathname === '/api/organization-join' && request.method === 'POST') {
    if (options.mode === 'local') throw new OrganizationError(409, 'sign_in_required', 'Invitation requests require the hosted Microsoft sign-in.');
    const input = await readBody();
    if (Object.keys(input).some(key => key !== 'token')) throw new OrganizationError(400, 'invalid_input', 'Send only the invitation token.');
    const fresh = await options.authenticate(request.headers[assertionHeader]);
    const joined = options.store.claim(input.token, fresh);
    const workspaceUrl = joined.state === 'accepted' ? options.prepareWorkspace?.(joined.organizationId, fresh) : undefined;
    return {status: 200, value: {...joined, ...(workspaceUrl ? {workspaceUrl} : {})}};
  }
  if (pathname === '/api/organization-workspaces/open' && request.method === 'POST') {
    const input = await readBody();
    if (Object.keys(input).length !== 1 || typeof input.organizationId !== 'string') throw new OrganizationError(400, 'invalid_input', 'Choose an organization.');
    const fresh = await options.authenticate(request.headers[assertionHeader]);
    if (options.mode !== 'authenticated' || !options.prepareWorkspace) throw new OrganizationError(409, 'workspaces_disabled', 'Private workspaces are not enabled.');
    return {status: 200, value: {workspaceUrl: options.prepareWorkspace(input.organizationId, fresh)}};
  }
  const staff = () => { if (!options.isStaff(identity)) throw new OrganizationError(403, 'staff_required', 'Organization administration is available only to Rivet staff.'); };
  staff();
  const method = request.method;
  const usage = () => {
    if (!options.usage) throw new OrganizationError(409, 'usage_disabled', 'Usage administration is not enabled.');
    return options.usage;
  };
  if (pathname === '/api/admin/usage' && method === 'GET') return {status: 200, value: usage().snapshot()};
  if (pathname === '/api/admin/staff' && method === 'GET' && options.accountOwners) return {status: 200, value: {
    canManage: Boolean(options.isAccountOwner?.(identity)), people: options.store.staffPeople(options.accountOwners()), history: options.store.controlHistory('staff'),
  }};
  if (pathname === '/api/admin/organizations' && method === 'GET') return {status: 200, value: {organizations: options.store.list()}};
  const match = /^\/api\/admin\/organizations\/([\w-]{1,64})(?:\/(invitations|members|teams|workspace)(?:\/([\w-]{1,64})(?:\/(approve|cancel))?)?)?$/.exec(pathname);
  if (match && !match[2] && method === 'GET') return {status: 200, value: options.store.detail(match[1])};
  if (match && match[2] === 'workspace' && !match[3] && method === 'GET') {
    return {status: 200, value: {workspace: options.store.detail(match[1]).workspace, allowance: options.workspaceUsage?.(match[1]) ?? null}};
  }
  if (!['POST','PATCH','PUT','DELETE'].includes(method ?? '')) throw new OrganizationError(404, 'route_not_found', 'This organization action is not available.');
  const input = await readBody();
  // Staff revocation while a body is arriving must win over a pending write.
  const fresh = await options.authenticate(request.headers[assertionHeader]);
  if (organizationIdentityKey(fresh) !== organizationIdentityKey(identity)) throw new OrganizationError(403, 'staff_required', 'Sign in again before saving.');
  staff();
  const fields = (allowed: string[]) => {
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new OrganizationError(400, 'invalid_input', 'Unexpected fields in this request.');
  };
  const store = options.store;
  const dailyLimit = /^\/api\/admin\/usage\/limits\/([a-f0-9-]{36})$/.exec(pathname);
  if (dailyLimit && method === 'PUT') {
    usage(); fields(['requestId', 'version', 'dailyRuns', 'reason']);
    const person = usage().snapshot().users.find(row => row.id === dailyLimit[1]);
    if (person && !person.dailyLimit) throw new OrganizationError(409, 'daily_limit_disabled', 'Customer workspaces have no daily task cap. Monthly allowances still apply.');
    return {status: 200, value: store.setDailyLimit(dailyLimit[1], input, identity)};
  }
  const staffMember = /^\/api\/admin\/staff\/([a-f0-9-]{36})$/.exec(pathname);
  if (staffMember && method === 'PUT') {
    if (!options.accountOwners || !options.isAccountOwner?.(identity)) throw new OrganizationError(403, 'owner_required', 'Only a Rivet account owner can grant or revoke customer-management admin access.');
    fields(['requestId','version','active','reason']);
    return {status: 200, value: store.setStaffAccess(staffMember[1], input, identity, options.accountOwners())};
  }
  if (pathname === '/api/admin/usage/resets' && method === 'POST') {
    fields(['requestId', 'scope', 'expected', 'reason']);
    return {status: 200, value: usage().reset(input, identity)};
  }
  if (pathname === '/api/admin/organizations' && method === 'POST') { fields(['requestId','name','contact','relationship']); return {status: 201, value: store.create(input, identity)}; }
  if (match) {
    const [, id, kind, target, action] = match;
    if (kind === 'workspace' && !target && method === 'POST') {
      fields(['version']);
      if (!options.provisionWorkspace || options.mode !== 'authenticated') throw new OrganizationError(409, 'workspaces_disabled', 'Customer workspace provisioning is not enabled.');
      return {status: 200, value: options.provisionWorkspace(id, input.version, identity)};
    }
    if (!kind && method === 'PATCH') { fields(['version','name','contact','relationship','status']); return {status: 200, value: store.update(id, input, identity)}; }
    if (kind === 'invitations' && !target && method === 'POST') {
      fields(['version','email','role']);
      const delivery = options.invitationDelivery;
      const created = store.invite(id, input, identity, Boolean(delivery));
      if (!delivery) return {status: 201, value: created};
      const check = () => { staff(); store.checkInvitation(id, created.invitationId); };
      try {
        await delivery.deliver({email: String(input.email).trim(), organization: created.detail.name, token: created.token},
          person => store.bindInvitation(id, created.invitationId, person), check);
        return {status: 201, value: {detail: store.invitationDelivery(id, created.invitationId, 'submitted', identity), delivery: 'submitted'}};
      } catch (error) {
        const issue = error instanceof InvitationDeliveryError ? error : null;
        console.warn(JSON.stringify({event: 'invitation_delivery_failed', organizationId: id, invitationId: created.invitationId,
          stage: issue?.stage ?? 'unknown', ...issue?.diagnostic}));
        return {status: 201, value: {detail: store.invitationDelivery(id, created.invitationId, 'failed', identity, issue?.stage), delivery: 'failed',
          deliveryMessage: issue?.message ?? 'Invitation setup did not complete. Refresh its status before using Send again.'}};
      }
    }
    if (kind === 'invitations' && target && (action === 'approve' || action === 'cancel') && method === 'POST') { fields(['version']); return {status: 200, value: store.invitationAction(id, target, action, input.version, identity)}; }
    if (kind === 'members' && target && !action && method === 'PATCH') { fields(['version','role','active']); return {status: 200, value: store.member(id, target, input, identity)}; }
    if (kind === 'teams' && !action && ((!target && method === 'POST') || (target && method === 'PUT'))) { fields(['version','name','memberIds']); return {status: 200, value: store.team(id, target, input, identity)}; }
    if (kind === 'teams' && target && !action && method === 'DELETE') { fields(['version']); return {status: 200, value: store.deleteTeam(id, target, input.version, identity)}; }
  }
  throw new OrganizationError(404, 'route_not_found', 'This organization action is not available.');
}
