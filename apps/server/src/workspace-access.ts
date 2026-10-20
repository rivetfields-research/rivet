import type { AccessAuthenticator, AccessIdentity } from './access-auth.ts';

export type WorkspaceRole = 'owner' | 'operator' | 'reviewer';
export type WorkspaceAction = 'read' | 'mutate' | 'cancel' | 'review';

export const isRunCancellation = (pathname: string, method: string | undefined) => method === 'POST' &&
  (pathname === '/api/run-requests/cancel' || /^\/api\/runs\/[a-zA-Z0-9_-]{1,100}\/cancel$/.test(pathname));
export interface MembershipKey { workspaceId: string; issuer: string; subject: string; }
export interface WorkspaceMembership extends MembershipKey { active: boolean; role: WorkspaceRole; }
export interface WorkspaceAccessOptions {
  /** Server-selected workspace. Never derive this from a request body or query. */
  workspaceId: string;
  auth: AccessAuthenticator;
  lookupMembership(key: MembershipKey): Promise<WorkspaceMembership | null | undefined>;
}
export interface AuthorizedWorkspace {
  workspaceId: string;
  role: WorkspaceRole;
  identity: AccessIdentity;
}
export interface WorkspaceAccess {
  authorize(assertion: string | string[] | undefined, action: WorkspaceAction): Promise<AuthorizedWorkspace>;
}

export class WorkspaceAccessError extends Error {
  readonly status: 403 | 503;
  readonly code: 'workspace_denied' | 'membership_unavailable';
  constructor(code: WorkspaceAccessError['code']) {
    super(code === 'workspace_denied' ? 'You do not have access to this workspace action.' : 'Workspace access verification is temporarily unavailable.');
    this.name = 'WorkspaceAccessError';
    this.code = code;
    this.status = code === 'workspace_denied' ? 403 : 503;
  }
}

/**
 * Resolve active membership on every request, after identity verification.
 * Resource queries must use the returned workspaceId before returning data or
 * starting work. Long-lived streams and queued jobs need their own rechecks.
 */
export function createWorkspaceAccess(options: WorkspaceAccessOptions): WorkspaceAccess {
  if (!options || typeof options.workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(options.workspaceId) ||
      typeof options.auth?.authenticate !== 'function' || typeof options.lookupMembership !== 'function') {
    throw new Error('Configure a workspace, identity verifier, and membership lookup.');
  }
  const workspaceId = options.workspaceId;
  const auth = options.auth;
  const lookup = options.lookupMembership;
  return {
    async authorize(assertion, action) {
      if (!['read', 'mutate', 'cancel', 'review'].includes(action)) throw new WorkspaceAccessError('workspace_denied');
      const identity = await auth.authenticate(assertion);
      let membership: WorkspaceMembership | null | undefined;
      try { membership = await lookup({workspaceId,issuer:identity.issuer,subject:identity.subject}); }
      catch { throw new WorkspaceAccessError('membership_unavailable'); }
      if (!membership || membership.active !== true || membership.workspaceId !== workspaceId ||
          membership.issuer !== identity.issuer || membership.subject !== identity.subject ||
          !['owner', 'operator', 'reviewer'].includes(membership.role) ||
          ((action === 'mutate' || action === 'cancel') && membership.role !== 'owner' && membership.role !== 'operator') ||
          (action === 'review' && membership.role !== 'owner' && membership.role !== 'reviewer')) {
        throw new WorkspaceAccessError('workspace_denied');
      }
      return {workspaceId,role:membership.role,identity};
    },
  };
}
