export type OrganizationRole = 'owner' | 'operator' | 'reviewer';
export type OrganizationRelationship = 'prospect' | 'pilot' | 'customer';
export interface OrganizationIdentity {
  issuer: string; subject: string; displayName?: string; email?: string;
  /** A signed username fallback is display information, not an email claim. */
  emailIsDisplayOnly?: true;
  /** Persisted member-profile proof, set only after observing an explicit signed email claim. */
  emailFromVerifiedClaim?: true;
}
export interface OrganizationWorkspaceLimits { dailyRuns: number; inputByteUnits: number; outputTokens: number; }
export type OrganizationWorkspace = { state: 'not_provisioned' } | {
  state: 'provisioning' | 'ready' | 'failed'; id: string; limits: OrganizationWorkspaceLimits;
};
export interface PersonalWorkspace {
  id: string; organizationId: string; identity: OrganizationIdentity;
  state: 'provisioning' | 'ready' | 'failed'; limits: OrganizationWorkspaceLimits;
}
export interface OrganizationSummary {
  id: string; name: string; contact: string; relationship: OrganizationRelationship;
  status: 'active' | 'suspended'; version: number; createdAt: string; updatedAt: string;
  memberCount: number; teamCount: number; pendingInvitations: number;
  workspace: OrganizationWorkspace; billing: { state: 'not_configured' };
  privateWorkspaces?: {ready: number; attention: number};
}
export interface OrganizationMember {
  id: string; identity: OrganizationIdentity; role: OrganizationRole; active: boolean;
  /** Explicitly supplied for email greetings; never inferred from the sign-in profile. */
  firstName?: string | null;
  workspaceState?: 'not_provisioned' | 'provisioning' | 'ready' | 'failed';
}
export interface OrganizationEmailRecipient {
  memberId: string; firstName: string | null; displayName: string | null; email: string | null;
}
export interface OrganizationRecipientSettings {
  display_name: string; selfMemberId: string; canEditOthers: boolean; recipients: OrganizationEmailRecipient[];
}
export interface OrganizationInvitation {
  id: string; email: string; role: OrganizationRole; expiresAt: string;
  state: 'pending' | 'claimed' | 'accepted' | 'cancelled' | 'expired';
  claimant: OrganizationIdentity | null;
  delivery?: 'sending' | 'submitted' | 'failed';
}
export interface OrganizationTeam { id: string; name: string; memberIds: string[]; }
export interface OrganizationDetail extends OrganizationSummary {
  timezone?: string;
  members: OrganizationMember[]; invitations: OrganizationInvitation[]; teams: OrganizationTeam[];
  activity: { id: number; action: string; actor: string; at: string }[];
}
export interface OrganizationSession { mode: 'local' | 'authenticated'; staff: boolean; displayName: string; provisioningEnabled?: boolean; usageEnabled?: boolean; adminAccessEnabled?: boolean; }
