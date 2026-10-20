/** Test billing only. It grants no ordinary customer entitlements. */
export type BillingState = 'unpaid' | 'pending' | 'active' | 'past_due' | 'canceled';
export type BillingOrganization = { id: string; name: string; role: 'owner' | 'operator' | 'reviewer' };
export type BillingSource = { name: string; state: 'ready' | 'not_connected'; fictional: boolean };
export type BillingSession = {
  mode: 'test';
  provider: 'fixture' | 'stripe';
  hosted?: true;
  actor: { key: string; name: string; email: string };
  organizations: BillingOrganization[];
  selectedOrganizationId?: string;
  offer: { name: string; amount: number; currency: string; interval: 'month'; testOnly: true };
};
export type BillingSummary = {
  organization: BillingOrganization;
  state: BillingState;
  covered: boolean;
  canManage: boolean;
  cancelAtPeriodEnd: boolean;
  periodEnd?: string;
  checkedAt?: string;
  source: BillingSource;
  offer: BillingSession['offer'];
  provider: BillingSession['provider'];
};
export type BillingInvitation = {
  organizationId: string;
  organization: string;
  email: string;
  role: BillingOrganization['role'];
  expiresAt: string;
  state: 'pending' | 'accepted';
};

// Local HTTP endpoints (all POSTs same-origin, JSON, no caller identity fields):
// GET /api/billing/session -> BillingSession
// POST /api/billing/organizations {name, requestId} -> BillingSummary
// POST /api/billing/invitation {token} -> BillingInvitation (read-only recipient preview)
// POST /api/billing/join {token} -> BillingSummary
// GET /api/team/:id -> OrganizationDetail (owner only; local launcher)
// POST /api/team/:id/invitations {version, email, role} -> {detail, delivery:'link', invitationUrl}
// POST /api/team/:id/invitations/:invitationId/cancel {version} -> OrganizationDetail
// PATCH /api/team/:id/members/:memberId {version, role, active} -> OrganizationDetail
// GET /api/billing/organizations/:id -> BillingSummary (fresh membership)
// POST .../:id/checkout {requestId} -> {url} (owner only)
// POST .../:id/confirm {sessionId} -> BillingSummary (owner only; server reconciliation)
// POST .../:id/portal {} -> {url} (owner only)
// POST .../:id/refresh {} -> BillingSummary (owner only; server reconciliation)
// POST /api/billing/webhook -> raw signed Stripe payload; no browser auth.
