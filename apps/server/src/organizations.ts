import type { ShareAudience, TeamRecord } from '../../../packages/core/src/sharing-types.ts';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { AllowanceCredit, UsageResetReceipt } from '../../../packages/core/src/usage-admin-types.ts';
import type { AdminControlChange, AdminStaffPerson } from '../../../packages/core/src/admin-control-types.ts';
import type { OrganizationWorkspace, OrganizationWorkspaceLimits, PersonalWorkspace } from '../../../packages/core/src/organization-types.ts';
import type { OrganizationDetail, OrganizationIdentity, OrganizationInvitation, OrganizationMember, OrganizationRelationship, OrganizationRole, OrganizationSummary, OrganizationTeam } from '../../../packages/core/src/organization-types.ts';
import type { OrganizationEmailRecipient, OrganizationRecipientSettings } from '../../../packages/core/src/organization-types.ts';

export class OrganizationError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new OrganizationError(status, code, message); };
function clean(value: unknown, max: number, label: string, optional = false): string {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim()) || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) return fail(400, 'invalid_input', `Enter a valid ${label}.`);
  return value.trim();
}
function email(value: unknown, optional = false) {
  const result = clean(value, 254, 'email address', optional);
  if (!(optional && !result) && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result)) return fail(400, 'invalid_input', 'Enter a valid email address.');
  return result;
}
function recipientFirstName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || /\p{C}/u.test(value) || value.trim().length > 80 || !/^[\p{L}\p{M} .'\u2018\u2019-]*$/u.test(value)) {
    return fail(400, 'invalid_first_name', 'Use up to 80 characters: letters, spaces, apostrophes, periods or hyphens.');
  }
  return value.trim() || null;
}
function emailRecipient(member: OrganizationMember): OrganizationEmailRecipient {
  return {memberId: member.id, firstName: member.firstName ?? null, displayName: member.identity.displayName ?? null, email: member.identity.email ?? null};
}
function role(value: unknown): OrganizationRole {
  if (!['owner', 'operator', 'reviewer'].includes(value as string)) return fail(400, 'invalid_role', 'Choose a valid member role.');
  return value as OrganizationRole;
}
function relationship(value: unknown): OrganizationRelationship {
  if (!['prospect', 'pilot', 'customer'].includes(value as string)) return fail(400, 'invalid_relationship', 'Choose a valid relationship.');
  return value as OrganizationRelationship;
}
export function organizationIdentityKey(value: OrganizationIdentity): string {
  return JSON.stringify([clean(value.issuer, 512, 'identity issuer'), clean(value.subject, 256, 'identity subject')]);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sameEmail = (left: unknown, right: unknown) => typeof left === 'string' && typeof right === 'string' && left.trim().toLowerCase() === right.trim().toLowerCase();
type Row = Record<string, any>;

/** Administration records only. No method allocates a runtime or grants access to pilot data.
 * Identity comes from the existing verifier; HTTP callers must pass the separate staff gate.
 * Emailed invitations bind to the tenant's verified object identity.
 */
export class OrganizationStore {
  private db: DatabaseSync;
  constructor(filename: string, private now: () => number = Date.now) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        name TEXT NOT NULL, contact TEXT NOT NULL, relationship TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS organization_members (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), identity TEXT NOT NULL,
        profile TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(org_id,identity), UNIQUE(org_id,id));
      CREATE TABLE IF NOT EXISTS organization_invitations (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL,
        role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL, claimant TEXT, created_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS organization_teams (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL,
        UNIQUE(org_id,name), UNIQUE(org_id,id));
      CREATE TABLE IF NOT EXISTS organization_team_members (
        org_id TEXT NOT NULL, team_id TEXT NOT NULL, member_id TEXT NOT NULL,
        PRIMARY KEY(org_id,team_id,member_id),
        FOREIGN KEY(org_id,team_id) REFERENCES organization_teams(org_id,id) ON DELETE CASCADE,
        FOREIGN KEY(org_id,member_id) REFERENCES organization_members(org_id,id));
      CREATE TABLE IF NOT EXISTS organization_activity (
        id INTEGER PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
        actor TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS organization_workspaces (
        org_id TEXT PRIMARY KEY REFERENCES organizations(id), workspace_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL, limits TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS organization_invitation_delivery (
        invitation_id TEXT PRIMARY KEY REFERENCES organization_invitations(id),
        state TEXT NOT NULL, identity TEXT);
      CREATE TABLE IF NOT EXISTS organization_personal_workspaces (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
        identity TEXT NOT NULL, state TEXT NOT NULL, limits TEXT NOT NULL,
        UNIQUE(org_id,identity));
      CREATE TABLE IF NOT EXISTS organization_allowance_resets (
        id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, actor TEXT NOT NULL,
        created_at INTEGER NOT NULL, period TEXT NOT NULL, scope TEXT NOT NULL,
        reason TEXT NOT NULL, adjustments TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS organization_daily_limits (
        workspace_id TEXT PRIMARY KEY REFERENCES organization_personal_workspaces(id),
        daily_runs INTEGER NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS organization_staff (
        identity TEXT PRIMARY KEY, active INTEGER NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS organization_admin_changes (
        id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, actor TEXT NOT NULL,
        created_at INTEGER NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
        before_value INTEGER NOT NULL, after_value INTEGER NOT NULL, reason TEXT NOT NULL);
      -- Retired creator-signup tables remain for historical backup compatibility.
      CREATE TABLE IF NOT EXISTS signup_invitations (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL, state TEXT NOT NULL, delivery TEXT NOT NULL,
        bound_identity TEXT, claimant TEXT, org_id TEXT REFERENCES organizations(id),
        request_hash TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS signup_activity (
        id INTEGER PRIMARY KEY, invitation_id TEXT NOT NULL REFERENCES signup_invitations(id),
        actor TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS organization_shared_storage (
        org_id TEXT PRIMARY KEY REFERENCES organizations(id), state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS organization_shared_records (
        org_id TEXT NOT NULL REFERENCES organizations(id), id TEXT NOT NULL, kind TEXT NOT NULL,
        publisher TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(org_id,id));
      CREATE TABLE IF NOT EXISTS organization_shared_requests (
        org_id TEXT NOT NULL REFERENCES organizations(id), id TEXT NOT NULL, actor TEXT NOT NULL,
        hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(org_id,id));
      CREATE TABLE IF NOT EXISTS organization_preferences (
        org_id TEXT PRIMARY KEY REFERENCES organizations(id), timezone TEXT NOT NULL);
    `);
    if (!this.db.prepare('PRAGMA table_info(organization_members)').all().some(column => column.name === 'first_name')) {
      this.db.exec('ALTER TABLE organization_members ADD COLUMN first_name TEXT');
    }
  }
  close() { this.db.close(); }
  sharedStorage(id: string) { return this.db.prepare('SELECT state FROM organization_shared_storage WHERE org_id=?').get(id)?.state as string | undefined; }
  reserveSharedStorage(id: string) { this.detail(id); this.db.prepare("INSERT INTO organization_shared_storage VALUES(?,'provisioning')").run(id); }
  finishSharedStorage(id: string, state: 'ready' | 'failed') { this.db.prepare('UPDATE organization_shared_storage SET state=? WHERE org_id=?').run(state,id); }
  sharedMember(id: string, identity: OrganizationIdentity) {
    if (!this.lookupMembership(id,identity)) return fail(403,'workspace_denied','This organization is unavailable.');
    return this.detail(id).members.find(member => member.active && organizationIdentityKey(member.identity) === organizationIdentityKey(identity))!;
  }
  recipientSettings(id: string, identity: OrganizationIdentity): OrganizationRecipientSettings {
    return this.transaction(() => {
      const self = this.sharedMember(id, identity), org = this.detail(id);
      return {display_name: org.name, selfMemberId: self.id, canEditOthers: self.role === 'owner',
        recipients: org.members.filter(member => member.active && (self.role === 'owner' || member.id === self.id)).map(emailRecipient)};
    });
  }
  updateRecipientFirstName(id: string, memberId: string, input: Record<string, unknown>, identity: OrganizationIdentity): OrganizationEmailRecipient {
    return this.transaction(() => {
      // Re-read membership inside the write transaction, including after HTTP body reads.
      const self = this.sharedMember(id, identity);
      const member = this.detail(id).members.find(member => member.active && member.id === memberId);
      if (!member || (self.role !== 'owner' && self.id !== member.id)) return fail(404, 'recipient_not_found', 'Recipient not found.');
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'firstName')) {
        return fail(400, 'invalid_input', 'Only firstName can be changed.');
      }
      const firstName = recipientFirstName(input.firstName);
      if (firstName !== (member.firstName ?? null)) {
        this.db.prepare('UPDATE organization_members SET first_name=? WHERE org_id=? AND id=? AND active=1').run(firstName, id, member.id);
        this.db.prepare('UPDATE organizations SET version=version+1,updated_at=? WHERE id=?').run(this.now(), id);
        this.audit(id, identity, 'Recipient first name updated');
      }
      return emailRecipient({...member, firstName});
    });
  }
  /** Verified sign-in claims only. A mailbox change never changes membership or storage ownership. */
  observeVerifiedMemberEmail(id: string, identity: OrganizationIdentity): boolean {
    const member = this.sharedMember(id, identity);
    if (identity.emailIsDisplayOnly || typeof identity.email !== 'string' || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(identity.email) || identity.email.length > 254) return false;
    if (member.identity.email === identity.email && member.identity.emailFromVerifiedClaim === true && !member.identity.emailIsDisplayOnly) return false;
    const profile: OrganizationIdentity = { ...member.identity, email: identity.email, emailFromVerifiedClaim: true };
    delete profile.emailIsDisplayOnly;
    this.db.prepare('UPDATE organization_members SET profile=? WHERE org_id=? AND identity=? AND active=1')
      .run(JSON.stringify(profile), id, organizationIdentityKey(identity));
    return true;
  }
  shareAudience(id: string, input: unknown): ShareAudience {
    const value = input as ShareAudience;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400,'invalid_audience','Choose who can access this.');
    if (value.kind === 'team' && Object.keys(value).length === 1) return {kind:'team'};
    if (value.kind !== 'members' || Object.keys(value).some(key => !['kind','memberIds'].includes(key)) || !Array.isArray(value.memberIds) || value.memberIds.length > 200 || new Set(value.memberIds).size !== value.memberIds.length || value.memberIds.some(memberId => !this.detail(id).members.some(member => member.active && member.id === memberId))) return fail(400,'invalid_audience','Choose active organization members.');
    return {kind:'members',memberIds:[...value.memberIds].sort()};
  }
  sharedRecord(id: string, recordId: string): TeamRecord | undefined {
    const row = this.db.prepare('SELECT data FROM organization_shared_records WHERE org_id=? AND id=?').get(id,recordId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  sourceAudience(id: string, connectionIds: string[]) {
    return this.db.prepare("SELECT data FROM organization_shared_records WHERE org_id=? AND kind='source' ORDER BY rowid DESC").all(id).map(row => JSON.parse(String(row.data)) as TeamRecord).filter(record => record.data.connectionIds?.some(connectionId => connectionIds.includes(connectionId)));
  }
  sharedRecords(id: string, identity: OrganizationIdentity): TeamRecord[] {
    return this.db.prepare('SELECT data FROM organization_shared_records WHERE org_id=? ORDER BY rowid DESC').all(id).map(row => JSON.parse(String(row.data)) as TeamRecord).filter(record => this.canReadShared(id,identity,record));
  }
  canReadShared(id: string, identity: OrganizationIdentity, record?: TeamRecord) {
    const member = this.sharedMember(id,identity);
    return !record || record.publisher === organizationIdentityKey(identity) || (record.kind === 'source' && member.role === 'owner') || record.audience.kind === 'team' || record.audience.memberIds.includes(member.id);
  }
  saveShared(id: string, identity: OrganizationIdentity, input: {id: string; kind: TeamRecord['kind']; name: unknown; version: unknown; requestId: unknown; audience: unknown; data: TeamRecord['data']; remove?: boolean}, privateSource = false) {
    const member = this.sharedMember(id,identity), actor = organizationIdentityKey(identity);
    const ownSnapshot = input.kind === 'source' && (this.sharedRecord(id,input.id)?.data.privateSnapshot || this.sharedRecord(id,input.id)?.data.privateConnection) && this.sharedRecord(id,input.id)?.publisher === actor;
    if ((input.kind === 'source' && member.role !== 'owner' && !ownSnapshot && !privateSource) || (input.kind === 'metric' && !['owner','operator'].includes(member.role)) || member.role === 'reviewer') return fail(403,'sharing_denied','You cannot change this shared item.');
    const name = clean(input.name,160,'name'), requestId = clean(input.requestId,64,'request ID');
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(requestId) || !Number.isSafeInteger(input.version) || Number(input.version) < 0) return fail(400,'invalid_input','A stable request ID and version are required.');
    const audience = this.shareAudience(id,input.audience);
    const digest = hash(JSON.stringify({...input,name,audience}));
    return this.transaction(() => {
      const replay = this.db.prepare('SELECT * FROM organization_shared_requests WHERE org_id=? AND id=?').get(id,requestId);
      if (replay) { if (replay.actor !== actor || replay.hash !== digest) return fail(409,'request_conflict','This request ID was already used.'); return JSON.parse(String(replay.result)) as TeamRecord; }
      const previous = this.sharedRecord(id,input.id);
      if (privateSource && previous && ((!previous.data.privateSnapshot && !previous.data.privateConnection) || previous.publisher !== actor)) return fail(409,'source_exists','This source is already shared. Ask its owner to change access.');
      if (previous && (previous.kind !== input.kind || (input.kind === 'report' && previous.publisher !== actor))) return fail(403,'sharing_denied','Only the author can republish this report.');
      if ((previous?.version ?? 0) !== input.version) return fail(409,'version_conflict','This item changed. Refresh before saving.');
      const record: TeamRecord = {id:input.id,kind:input.kind,name,version:Number(input.version)+1,audience,publisher:previous?.publisher ?? actor,updatedAt:new Date(this.now()).toISOString(),data:input.data};
      if (input.remove) record.audience = {kind:'members',memberIds:[]};
      if (input.kind === 'source' && input.data.connectionIds?.length) {
        for (const related of this.sourceAudience(id,input.data.connectionIds)) {
          related.audience = record.audience; related.version++; related.updatedAt = record.updatedAt;
          this.db.prepare('UPDATE organization_shared_records SET version=?,data=? WHERE org_id=? AND id=?').run(related.version,JSON.stringify(related),id,related.id);
        }
      }
      this.db.prepare('INSERT INTO organization_shared_records VALUES(?,?,?,?,?,?) ON CONFLICT(org_id,id) DO UPDATE SET version=excluded.version,data=excluded.data').run(id,record.id,record.kind,record.publisher,record.version,JSON.stringify(record));
      this.db.prepare('INSERT INTO organization_shared_requests VALUES(?,?,?,?,?)').run(id,requestId,actor,digest,JSON.stringify(record));
      return record;
    });
  }
  dailyLimit(workspaceId: string, fallback: number) {
    const row = this.db.prepare('SELECT daily_runs,version FROM organization_daily_limits WHERE workspace_id=?').get(workspaceId);
    const value = row ? Number(row.daily_runs) : fallback, version = row ? Number(row.version) : 0;
    if (!Number.isInteger(value) || value < 1 || value > 1000 || !Number.isSafeInteger(version) || version < 0) fail(503, 'usage_unavailable', 'The daily limit could not be verified.');
    return {value, version};
  }
  hasStaffGrant(identity: OrganizationIdentity) {
    const key = organizationIdentityKey(identity);
    const row = this.db.prepare('SELECT active FROM organization_staff WHERE identity=?').get(key);
    return row?.active === 1 && this.activeIdentity(key);
  }
  private activeIdentity(key: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM organization_members m JOIN organizations o ON o.id=m.org_id WHERE m.identity=? AND m.active=1 AND o.status='active'").get(key));
  }
  staffPeople(owners: OrganizationIdentity[]): AdminStaffPerson[] {
    const keys = new Set(owners.map(organizationIdentityKey));
    const people = new Map<string, AdminStaffPerson>();
    for (const row of this.db.prepare('SELECT m.*,o.name FROM organization_members m JOIN organizations o ON o.id=m.org_id ORDER BY m.id').all()) {
      const identity = JSON.parse(String(row.profile)), key = String(row.identity);
      if (organizationIdentityKey(identity) !== key) fail(503, 'admin_unavailable', 'A member identity could not be verified.');
      const grant = this.db.prepare('SELECT active,version FROM organization_staff WHERE identity=?').get(key);
      const person: AdminStaffPerson = people.get(key) ?? {id: String(row.id), name: identity.displayName || identity.email || 'Member', email: identity.email || '', organizations: [],
        access: keys.has(key) ? 'owner' : grant?.active === 1 ? 'admin' : 'none', eligible: this.activeIdentity(key), version: Number(grant?.version ?? 0)};
      if (!person.organizations.includes(String(row.name))) person.organizations.push(String(row.name));
      people.set(key, person);
    }
    for (const owner of owners) if (!people.has(organizationIdentityKey(owner))) people.set(organizationIdentityKey(owner), {
      id: hash(organizationIdentityKey(owner)), name: owner.displayName || owner.email || 'Account owner', email: owner.email || '',
      organizations: [], access: 'owner', eligible: true, version: 0,
    });
    return [...people.values()].sort((a,b) => a.name.localeCompare(b.name));
  }
  controlHistory(kind: AdminControlChange['kind']): AdminControlChange[] {
    return this.db.prepare('SELECT * FROM organization_admin_changes WHERE kind=? ORDER BY created_at DESC,rowid DESC LIMIT 50').all(kind).map(row => this.controlReceipt(row));
  }
  private controlReceipt(row: Row): AdminControlChange {
    return {id: row.id, kind: row.kind, target: row.target, before: row.before_value, after: row.after_value,
      reason: row.reason, actor: row.actor, at: new Date(row.created_at).toISOString()};
  }
  private controlChange(kind: AdminControlChange['kind'], target: string, input: Record<string, unknown>, value: number, actor: OrganizationIdentity, apply: () => number) {
    const id = clean(input.requestId, 64, 'request ID'), reason = clean(input.reason, 240, 'reason');
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(id) || !Number.isSafeInteger(input.version) || Number(input.version) < 0) fail(400, 'invalid_input', 'A stable request ID and version are required.');
    const actorKey = organizationIdentityKey(actor), requestHash = hash(JSON.stringify([kind,target,input.version,value,reason,actorKey]));
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM organization_admin_changes WHERE id=?').get(id);
      if (previous) {
        if (previous.request_hash !== requestHash) fail(409, 'request_conflict', 'This request ID was used for another admin change.');
        return this.controlReceipt(previous);
      }
      const before = apply();
      this.db.prepare('INSERT INTO organization_admin_changes VALUES(?,?,?,?,?,?,?,?,?)').run(id,requestHash,actorKey,this.now(),kind,target,before,value,reason);
      return this.controlReceipt(this.db.prepare('SELECT * FROM organization_admin_changes WHERE id=?').get(id)!);
    });
  }
  setDailyLimit(workspaceId: string, input: Record<string, unknown>, actor: OrganizationIdentity) {
    const value = input.dailyRuns;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) fail(400, 'invalid_input', 'Daily tasks must be a whole number from 1 to 1,000.');
    return this.controlChange('daily_limit', workspaceId, input, value as number, actor, () => {
      const workspace = this.personalWorkspaces().find(row => row.id === workspaceId);
      if (!workspace || workspace.state !== 'ready' || !this.lookupMembership(workspace.organizationId, workspace.identity)) fail(409, 'workspace_unavailable', 'Choose an active member with a ready private workspace.');
      const current = this.dailyLimit(workspaceId, workspace!.limits.dailyRuns);
      if (current.version !== input.version) fail(409, 'admin_changed', 'This daily limit changed. Refresh before saving.');
      this.db.prepare('INSERT INTO organization_daily_limits VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET daily_runs=excluded.daily_runs,version=excluded.version').run(workspaceId, value as number, current.version + 1);
      return current.value;
    });
  }
  setStaffAccess(memberId: string, input: Record<string, unknown>, actor: OrganizationIdentity, owners: OrganizationIdentity[]) {
    if (typeof input.active !== 'boolean') fail(400, 'invalid_input', 'Choose whether admin access is enabled.');
    const member = this.db.prepare('SELECT identity,profile FROM organization_members WHERE id=?').get(memberId);
    if (!member) fail(404, 'member_not_found', 'Choose a member who has accepted an invitation.');
    const key = String(member!.identity), profile = JSON.parse(String(member!.profile));
    if (organizationIdentityKey(profile) !== key || profile.issuer !== actor.issuer) fail(403, 'invalid_identity', 'This account cannot receive admin access.');
    if (owners.some(owner => organizationIdentityKey(owner) === key)) fail(409, 'protected_owner', 'Account-owner access is protected and cannot be changed here.');
    return this.controlChange('staff', key, input, input.active ? 1 : 0, actor, () => {
      if (input.active && !this.activeIdentity(key)) fail(409, 'inactive_member', 'An active organization membership is required.');
      const row = this.db.prepare('SELECT active,version FROM organization_staff WHERE identity=?').get(key);
      if (Number(row?.version ?? 0) !== input.version) fail(409, 'admin_changed', 'This admin access changed. Refresh before saving.');
      this.db.prepare('INSERT INTO organization_staff VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET active=excluded.active,version=excluded.version').run(key, input.active ? 1 : 0, Number(row?.version ?? 0) + 1);
      return Number(row?.active ?? 0);
    });
  }
  dailyRunCredits(workspaceId: string, day: string) {
    let total = 0;
    for (const row of this.db.prepare('SELECT adjustments FROM organization_allowance_resets WHERE period=?').all(day)) {
      for (const item of this.readAllowanceAdjustments(String(row.adjustments))) if (item.workspaceId === workspaceId) total += item.dailyRuns ?? 0;
    }
    if (!Number.isSafeInteger(total) || total < 0) fail(503, 'usage_unavailable', 'Daily adjustments could not be verified.');
    return total;
  }
  allowanceCredits(workspaceId: string, period: string) {
    const rows = this.db.prepare('SELECT adjustments FROM organization_allowance_resets WHERE period=?').all(period);
    const total = {inputByteUnits: 0, outputTokens: 0};
    for (const row of rows) for (const item of this.readAllowanceAdjustments(String(row.adjustments))) {
      if (item.workspaceId === workspaceId) {
        total.inputByteUnits += item.inputByteUnits;
        total.outputTokens += item.outputTokens;
      }
    }
    if (Object.values(total).some(value => !Number.isSafeInteger(value) || value < 0)) fail(503, 'usage_unavailable', 'Usage adjustments could not be verified.');
    return total;
  }
  private readAllowanceAdjustments(encoded: string): AllowanceCredit[] {
    try {
      const items = JSON.parse(encoded);
      if (!Array.isArray(items) || !items.length || items.length > 50 ||
          items.some(item => !item || !['inputByteUnits,outputTokens,workspaceId','dailyRuns,inputByteUnits,outputTokens,workspaceId'].includes(Object.keys(item).sort().join(',')) ||
            typeof item.workspaceId !== 'string' || !/^(installation|[a-f0-9-]{36})$/.test(item.workspaceId) ||
            (item.dailyRuns !== undefined && (!Number.isSafeInteger(item.dailyRuns) || item.dailyRuns < 1 || item.workspaceId === 'installation' || item.inputByteUnits !== 0 || item.outputTokens !== 0)) ||
            [item.inputByteUnits, item.outputTokens].some(value => !Number.isSafeInteger(value) || value < 0)) ||
          new Set(items.map(item => item.workspaceId)).size !== items.length) throw new Error();
      return items;
    } catch { return fail(503, 'usage_unavailable', 'Usage adjustments could not be verified.'); }
  }
  usageResetHistory(): UsageResetReceipt[] {
    return this.db.prepare('SELECT * FROM organization_allowance_resets ORDER BY created_at DESC,rowid DESC LIMIT 50').all().map(row => this.resetReceipt(row));
  }
  private resetReceipt(row: Row): UsageResetReceipt {
    return {id: row.id, scope: row.scope, period: row.period, reason: row.reason, actor: row.actor,
      at: new Date(row.created_at).toISOString(), adjustments: this.readAllowanceAdjustments(row.adjustments)};
  }
  recordUsageReset(input: Record<string, unknown>, actor: OrganizationIdentity, prepare: () => {period: string; adjustments: AllowanceCredit[]}) {
    const id = clean(input.requestId, 64, 'request ID'), scope = clean(input.scope, 64, 'reset scope');
    const reason = clean(input.reason, 240, 'reset reason'), expected = clean(input.expected, 64, 'usage version');
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(id) || !/^[a-f0-9]{64}$/.test(expected)) fail(400, 'invalid_input', 'A stable request ID and usage version are required.');
    const actorKey = organizationIdentityKey(actor), requestHash = hash(JSON.stringify([scope, expected, reason, actorKey]));
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM organization_allowance_resets WHERE id=?').get(id);
      if (previous) {
        if (previous.request_hash !== requestHash) fail(409, 'request_conflict', 'This request ID was used for another allowance change.');
        return this.resetReceipt(previous);
      }
      const {period, adjustments} = prepare();
      const daily = scope.startsWith('daily:');
      const validPeriod = daily ? /^\d{4}-\d{2}-\d{2}$/.test(period) && Number.isFinite(Date.parse(period)) && new Date(period).toISOString().slice(0,10) === period : /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
      this.readAllowanceAdjustments(JSON.stringify(adjustments));
      if (!validPeriod || adjustments.some(item => daily !== (item.dailyRuns !== undefined)) || !adjustments.length || adjustments.length > 50 ||
          new Set(adjustments.map(item => item.workspaceId)).size !== adjustments.length ||
          adjustments.some(item => !/^(installation|[a-f0-9-]{36})$/.test(item.workspaceId) ||
            [item.inputByteUnits, item.outputTokens].some(value => !Number.isSafeInteger(value) || value < 0))) {
        fail(400, 'invalid_input', 'Invalid allowance adjustment.');
      }
      this.db.prepare('INSERT INTO organization_allowance_resets VALUES(?,?,?,?,?,?,?,?)')
        .run(id, requestHash, actorKey, this.now(), period, scope, reason, JSON.stringify(adjustments));
      return this.resetReceipt(this.db.prepare('SELECT * FROM organization_allowance_resets WHERE id=?').get(id)!);
    });
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private organization(id: string): Row {
    const row = this.db.prepare('SELECT * FROM organizations WHERE id=?').get(id);
    if (!row) return fail(404, 'organization_not_found', 'Organization not found.');
    return row;
  }
  private change(id: string, expected: unknown, actor: OrganizationIdentity, action: string, fn: () => void, allowSuspended = false) {
    return this.transaction(() => {
      const org = this.organization(id);
      if (expected !== org.version) fail(409, 'organization_changed', 'This organization changed. Refresh before saving again.');
      if (!allowSuspended && org.status === 'suspended') fail(409, 'organization_suspended', 'Resume this organization before changing its members or teams.');
      fn();
      this.db.prepare('UPDATE organizations SET version=version+1,updated_at=? WHERE id=?').run(this.now(), id);
      this.audit(id, actor, action);
      return this.detail(id);
    });
  }
  private audit(id: string, actor: OrganizationIdentity, action: string) {
    this.db.prepare('INSERT INTO organization_activity(org_id,actor,action,at) VALUES(?,?,?,?)').run(id, organizationIdentityKey(actor), action, this.now());
  }
  private summary(row: Row): OrganizationSummary {
    const count = (sql: string) => Number(this.db.prepare(sql).get(row.id)!.n);
    return { id: row.id, name: row.name, contact: row.contact, relationship: row.relationship,
      status: row.status, version: row.version, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
      memberCount: count('SELECT COUNT(*) n FROM organization_members WHERE org_id=? AND active=1'),
      teamCount: count('SELECT COUNT(*) n FROM organization_teams WHERE org_id=?'),
      pendingInvitations: Number(this.db.prepare("SELECT COUNT(*) n FROM organization_invitations WHERE org_id=? AND state IN ('pending','claimed') AND expires_at>?").get(row.id, this.now())!.n),
      workspace: this.workspace(row.id), billing: { state: 'not_configured' },
      privateWorkspaces: {
        ready: count("SELECT COUNT(*) n FROM organization_personal_workspaces WHERE org_id=? AND state='ready'"),
        attention: count("SELECT COUNT(*) n FROM organization_personal_workspaces WHERE org_id=? AND state<>'ready'"),
      } };
  }
  list(): OrganizationSummary[] { return this.db.prepare('SELECT * FROM organizations ORDER BY name COLLATE NOCASE,id').all().map(row => this.summary(row)); }
  detail(id: string): OrganizationDetail {
    const org = this.summary(this.organization(id));
    const members: OrganizationMember[] = this.db.prepare('SELECT * FROM organization_members WHERE org_id=? ORDER BY active DESC,id').all(id).map((row: Row) => ({id: row.id, identity: JSON.parse(row.profile), role: row.role, active: Boolean(row.active), firstName: row.first_name ?? null}));
    const invitations: OrganizationInvitation[] = this.db.prepare('SELECT * FROM organization_invitations WHERE org_id=? ORDER BY expires_at DESC,id').all(id).map((row: Row) => ({id: row.id, email: row.email, role: row.role, expiresAt: new Date(row.expires_at).toISOString(), state: ['pending','claimed'].includes(row.state) && row.expires_at <= this.now() ? 'expired' : row.state, claimant: row.claimant ? JSON.parse(row.claimant) : null}));
    const teams: OrganizationTeam[] = this.db.prepare('SELECT * FROM organization_teams WHERE org_id=? ORDER BY name COLLATE NOCASE').all(id).map((row: Row) => ({id: row.id, name: row.name, memberIds: this.db.prepare('SELECT member_id FROM organization_team_members WHERE org_id=? AND team_id=? ORDER BY member_id').all(id, row.id).map(member => String(member.member_id))}));
    const activity = this.db.prepare('SELECT id,actor,action,at FROM organization_activity WHERE org_id=? ORDER BY id DESC LIMIT 50').all(id).map((row: Row) => ({id: row.id, actor: row.actor, action: row.action, at: new Date(row.at).toISOString()}));
    for (const invite of invitations) {
      const delivery = this.db.prepare('SELECT state FROM organization_invitation_delivery WHERE invitation_id=?').get(invite.id);
      if (delivery) invite.delivery = delivery.state as OrganizationInvitation['delivery'];
    }
    for (const member of members) member.workspaceState = this.personalWorkspace(id, member.identity)?.state ?? 'not_provisioned';
    const preferences = this.db.prepare('SELECT timezone FROM organization_preferences WHERE org_id=?').get(id);
    return {...org, members, invitations, teams, activity, ...(preferences ? {timezone: String(preferences.timezone)} : {})};
  }
  create(input: Record<string, unknown>, actor: OrganizationIdentity) {
    const name = clean(input.name, 120, 'organization name'), contact = email(input.contact ?? '', true), relation = relationship(input.relationship ?? 'prospect');
    const requestId = clean(input.requestId, 64, 'request ID');
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(requestId)) fail(400, 'invalid_request', 'A stable request ID is required.');
    const requestHash = hash(JSON.stringify([name, contact, relation]));
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM organizations WHERE request_id=?').get(requestId);
      if (previous) {
        if (previous.request_hash !== requestHash) fail(409, 'request_conflict', 'This request ID was already used for a different organization.');
        return this.detail(String(previous.id));
      }
      const id = randomUUID(), time = this.now();
      this.db.prepare('INSERT INTO organizations(id,request_id,request_hash,name,contact,relationship,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, requestId, requestHash, name, contact, relation, time, time);
      this.audit(id, actor, 'Organization created');
      return this.detail(id);
    });
  }
  update(id: string, input: Record<string, unknown>, actor: OrganizationIdentity) {
    const name = clean(input.name, 120, 'organization name'), contact = email(input.contact ?? '', true), relation = relationship(input.relationship);
    if (!['active','suspended'].includes(input.status as string)) fail(400, 'invalid_status', 'Choose an organization status.');
    return this.change(id, input.version, actor, input.status === 'suspended' ? 'Organization suspended' : 'Organization updated', () => {
      this.db.prepare('UPDATE organizations SET name=?,contact=?,relationship=?,status=? WHERE id=?').run(name, contact, relation, String(input.status), id);
      if (input.status === 'suspended') this.db.prepare("UPDATE organization_invitations SET state='cancelled' WHERE org_id=? AND state IN ('pending','claimed')").run(id);
    }, true);
  }
  invite(id: string, input: Record<string, unknown>, actor: OrganizationIdentity, emailed = false) {
    const recipient = email(input.email), nextRole = role(input.role), token = randomBytes(32).toString('base64url');
    const invitationId = randomUUID();
    const detail = this.change(id, input.version, actor, 'Member invited', () => {
      this.db.prepare("UPDATE organization_invitations SET state='cancelled' WHERE org_id=? AND lower(email)=lower(?) AND state IN ('pending','claimed')").run(id, recipient);
      this.db.prepare('INSERT INTO organization_invitations VALUES(?,?,?,?,?,?,?,NULL,?)').run(invitationId, id, recipient, nextRole, hash(token), this.now() + 7 * 86400000, 'pending', organizationIdentityKey(actor));
      if (emailed) this.db.prepare('INSERT INTO organization_invitation_delivery VALUES(?,?,NULL)').run(invitationId, 'sending');
    });
    return {detail, token, invitationId};
  }
  checkInvitation(id: string, invitationId: string) {
    const invite = this.db.prepare('SELECT state,expires_at FROM organization_invitations WHERE org_id=? AND id=?').get(id, invitationId);
    if (this.organization(id).status !== 'active' || !invite || invite.state !== 'pending' || Number(invite.expires_at) <= this.now()) fail(409, 'invitation_unavailable', 'This invitation is no longer active.');
  }
  bindInvitation(id: string, invitationId: string, identity: OrganizationIdentity) {
    this.checkInvitation(id, invitationId);
    this.db.prepare('UPDATE organization_invitation_delivery SET identity=? WHERE invitation_id=?').run(organizationIdentityKey(identity), invitationId);
  }
  invitationDelivery(id: string, invitationId: string, state: 'submitted' | 'failed', actor: OrganizationIdentity, stage?: 'credentials' | 'guest' | 'access' | 'email') {
    this.transaction(() => {
      this.db.prepare('UPDATE organization_invitation_delivery SET state=? WHERE invitation_id=?').run(state, invitationId);
      this.audit(id, actor, state === 'submitted' ? 'Invitation email submitted to Microsoft' : `Invitation delivery needs attention${stage ? `: ${stage}` : ''}`);
    });
    return this.detail(id);
  }
  /** Recipient-only preview. Opening a link must not claim it or create membership. */
  invitationPreview(token: unknown, identity: OrganizationIdentity) {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return fail(404, 'invitation_unavailable', 'This invitation is invalid or no longer available.');
    const invite = this.db.prepare("SELECT i.*,o.name FROM organization_invitations i JOIN organizations o ON i.org_id=o.id WHERE token_hash=? AND o.status='active'").get(hash(token)) as Row | undefined;
    if (!invite || invite.expires_at <= this.now() || !['pending','accepted'].includes(invite.state)) return fail(404, 'invitation_unavailable', 'This invitation is invalid or no longer available.');
    const key = organizationIdentityKey(identity);
    if (invite.claimant && organizationIdentityKey(JSON.parse(invite.claimant)) !== key) return fail(409, 'invitation_claimed', 'This invitation was already used by another account. Ask for a new link.');
    const delivery = this.db.prepare('SELECT * FROM organization_invitation_delivery WHERE invitation_id=?').get(invite.id);
    if (delivery && !delivery.identity) return fail(409, 'invitation_not_ready', 'Account access is still being prepared. Contact the sender.');
    if (invite.state !== 'accepted' && (delivery ? delivery.identity !== key : !sameEmail(invite.email, identity.email))) return fail(403, 'invitation_account_mismatch', 'Sign in with the account this invitation was sent to. The invitation has not been changed.');
    const membership = this.lookupMembership(invite.org_id, identity);
    if (invite.state === 'accepted' && (!invite.claimant || !membership)) return fail(404, 'invitation_unavailable', 'This invitation is no longer available. Ask for a new link.');
    return {organizationId: String(invite.org_id), organization: String(invite.name), email: String(invite.email),
      role: membership?.role ?? invite.role as OrganizationRole, expiresAt: new Date(invite.expires_at).toISOString(), state: invite.state as 'pending' | 'accepted'};
  }
  claim(token: unknown, identity: OrganizationIdentity) {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return fail(404, 'invitation_unavailable', 'This invitation is invalid or no longer available.');
    return this.transaction(() => {
      const invite = this.db.prepare("SELECT i.*,o.name FROM organization_invitations i JOIN organizations o ON i.org_id=o.id WHERE token_hash=? AND o.status='active'").get(hash(token)) as Row | undefined;
      if (!invite || invite.expires_at <= this.now() || !['pending','claimed','accepted'].includes(invite.state)) return fail(404, 'invitation_unavailable', 'This invitation is invalid or no longer available.');
      const key = organizationIdentityKey(identity);
      const delivery = this.db.prepare('SELECT * FROM organization_invitation_delivery WHERE invitation_id=?').get(invite.id);
      if (delivery && !delivery.identity) return fail(409, 'invitation_not_ready', 'Microsoft access is still being prepared. Contact the sender.');
      if (delivery && delivery.identity !== key) return fail(403, 'invitation_account_mismatch', 'Sign in with the account that accepted the Microsoft invitation. This invitation has not been used.');
      if (invite.claimant && organizationIdentityKey(JSON.parse(invite.claimant)) !== key) return fail(409, 'invitation_claimed', 'This invitation already has a join request. Contact the sender for a new link.');
      if (invite.state === 'pending') {
        if (delivery ? delivery.identity === key : sameEmail(invite.email, identity.email)) {
          const existing = this.db.prepare('SELECT * FROM organization_members WHERE org_id=? AND identity=?').get(invite.org_id, key);
          if (existing?.active) {
            this.db.prepare("UPDATE organization_invitations SET state='accepted',claimant=? WHERE id=?").run(JSON.stringify(identity), invite.id);
            this.db.prepare('UPDATE organizations SET version=version+1,updated_at=? WHERE id=?').run(this.now(), invite.org_id);
            this.audit(invite.org_id, identity, 'Existing member accepted invitation');
            return {organization: invite.name as string, organizationId: invite.org_id as string, state: 'accepted' as const};
          }
          this.db.prepare(`INSERT INTO organization_members(id,org_id,identity,profile,role,active) VALUES(?,?,?,?,?,1)
            ON CONFLICT(org_id,identity) DO UPDATE SET profile=excluded.profile,role=excluded.role,active=1`).run(randomUUID(), invite.org_id, key, JSON.stringify(identity), invite.role);
          for (const other of this.db.prepare("SELECT id,claimant FROM organization_invitations WHERE org_id=? AND state='claimed' AND id<>?").all(invite.org_id, invite.id)) {
            if (other.claimant && organizationIdentityKey(JSON.parse(String(other.claimant))) === key) this.db.prepare("UPDATE organization_invitations SET state='cancelled' WHERE id=?").run(other.id);
          }
          this.db.prepare("UPDATE organization_invitations SET state='accepted',claimant=? WHERE id=?").run(JSON.stringify(identity), invite.id);
          this.db.prepare('UPDATE organizations SET version=version+1,updated_at=? WHERE id=?').run(this.now(), invite.org_id);
          this.audit(invite.org_id, identity, 'Invited member joined');
          return {organization: invite.name as string, organizationId: invite.org_id as string, state: 'accepted' as const};
        }
        this.db.prepare("UPDATE organization_invitations SET state='claimed',claimant=? WHERE id=?").run(JSON.stringify(identity), invite.id);
        this.db.prepare('UPDATE organizations SET version=version+1,updated_at=? WHERE id=?').run(this.now(), invite.org_id);
        this.audit(invite.org_id, identity, 'Join request received');
      }
      return {organization: invite.name as string, organizationId: invite.org_id as string, state: invite.state === 'accepted' ? 'accepted' as const : 'claimed' as const};
    });
  }
  invitationAction(id: string, invitationId: string, action: 'approve' | 'cancel', version: unknown, actor: OrganizationIdentity) {
    return this.change(id, version, actor, action === 'approve' ? 'Join request approved' : 'Invitation cancelled', () => {
      const invite = this.db.prepare('SELECT * FROM organization_invitations WHERE org_id=? AND id=?').get(id, invitationId) as Row | undefined;
      if (!invite || !['pending','claimed'].includes(invite.state)) fail(404, 'invitation_unavailable', 'Invitation not found or already resolved.');
      if (action === 'approve') {
        if (invite!.state !== 'claimed' || !invite!.claimant || invite!.expires_at <= this.now()) fail(409, 'invitation_unavailable', 'A current signed-in join request is required.');
        const identity = JSON.parse(invite!.claimant) as OrganizationIdentity, key = organizationIdentityKey(identity);
        const existing = this.db.prepare('SELECT * FROM organization_members WHERE org_id=? AND identity=?').get(id, key);
        if (existing?.active) fail(409, 'already_member', 'This person is already a member. Change their role from Members.');
        this.db.prepare(`INSERT INTO organization_members(id,org_id,identity,profile,role,active) VALUES(?,?,?,?,?,1)
          ON CONFLICT(org_id,identity) DO UPDATE SET profile=excluded.profile,role=excluded.role,active=1`).run(randomUUID(), id, key, JSON.stringify(identity), invite!.role);
        for (const other of this.db.prepare("SELECT id,claimant FROM organization_invitations WHERE org_id=? AND state='claimed' AND id<>?").all(id, invitationId)) {
          if (other.claimant && organizationIdentityKey(JSON.parse(String(other.claimant))) === key) this.db.prepare("UPDATE organization_invitations SET state='cancelled' WHERE id=?").run(other.id);
        }
      }
      this.db.prepare('UPDATE organization_invitations SET state=? WHERE id=?').run(action === 'approve' ? 'accepted' : 'cancelled', invitationId);
    });
  }
  member(id: string, memberId: string, input: Record<string, unknown>, actor: OrganizationIdentity) {
    const nextRole = role(input.role);
    if (typeof input.active !== 'boolean') fail(400, 'invalid_input', 'Choose an active membership state.');
    return this.change(id, input.version, actor, input.active ? 'Member role updated' : 'Member removed', () => {
      const previous = this.db.prepare('SELECT * FROM organization_members WHERE org_id=? AND id=?').get(id, memberId);
      if (!previous || !previous.active) fail(404, 'member_not_found', 'Active member not found. Send a new invitation to restore access.');
      if (previous!.role === 'owner' && (!input.active || nextRole !== 'owner') && Number(this.db.prepare("SELECT COUNT(*) n FROM organization_members WHERE org_id=? AND active=1 AND role='owner'").get(id)!.n) <= 1) fail(409, 'last_owner', 'Assign another owner before removing or changing the last owner.');
      this.db.prepare('UPDATE organization_members SET role=?,active=? WHERE org_id=? AND id=?').run(nextRole, input.active ? 1 : 0, id, memberId);
      if (!input.active) this.db.prepare('DELETE FROM organization_team_members WHERE org_id=? AND member_id=?').run(id, memberId);
      const profile = JSON.parse(String(previous!.profile)) as OrganizationIdentity;
      for (const invite of this.db.prepare(`SELECT i.id,i.email,i.claimant,d.identity recipient_identity FROM organization_invitations i
        LEFT JOIN organization_invitation_delivery d ON d.invitation_id=i.id WHERE i.org_id=? AND i.state IN ('pending','claimed'${input.active ? '' : ",'accepted'"})`).all(id)) {
        const claimed = invite.claimant && organizationIdentityKey(JSON.parse(String(invite.claimant))) === previous!.identity;
        const addressed = !input.active && !invite.claimant && (invite.recipient_identity
          ? invite.recipient_identity === previous!.identity : sameEmail(invite.email, profile.email));
        if (claimed || addressed) this.db.prepare("UPDATE organization_invitations SET state='cancelled' WHERE id=?").run(invite.id);
      }
    });
  }
  team(id: string, teamId: string | undefined, input: Record<string, unknown>, actor: OrganizationIdentity) {
    const name = clean(input.name, 80, 'team name');
    if (!Array.isArray(input.memberIds) || input.memberIds.length > 100 || input.memberIds.some(value => typeof value !== 'string') || new Set(input.memberIds).size !== input.memberIds.length) fail(400, 'invalid_members', 'Choose a valid set of organization members.');
    return this.change(id, input.version, actor, teamId ? 'Team updated' : 'Team created', () => {
      if (teamId && !this.db.prepare('SELECT 1 FROM organization_teams WHERE org_id=? AND id=?').get(id, teamId)) fail(404, 'team_not_found', 'Team not found.');
      if (this.db.prepare('SELECT 1 FROM organization_teams WHERE org_id=? AND lower(name)=lower(?) AND id<>?').get(id, name, teamId ?? '')) fail(409, 'team_exists', 'A team with this name already exists.');
      for (const member of input.memberIds as string[]) if (!this.db.prepare('SELECT 1 FROM organization_members WHERE org_id=? AND id=? AND active=1').get(id, member)) fail(400, 'invalid_members', 'Teams can contain only active members of this organization.');
      const target = teamId ?? randomUUID();
      if (teamId) this.db.prepare('UPDATE organization_teams SET name=? WHERE org_id=? AND id=?').run(name, id, target);
      else this.db.prepare('INSERT INTO organization_teams VALUES(?,?,?)').run(target, id, name);
      this.db.prepare('DELETE FROM organization_team_members WHERE org_id=? AND team_id=?').run(id, target);
      for (const member of input.memberIds as string[]) this.db.prepare('INSERT INTO organization_team_members VALUES(?,?,?)').run(id, target, member);
    });
  }
  lookupMembership(id: string, identity: OrganizationIdentity) {
    const row = this.db.prepare("SELECT m.role FROM organization_members m JOIN organizations o ON o.id=m.org_id WHERE o.id=? AND o.status='active' AND m.identity=? AND m.active=1").get(id, organizationIdentityKey(identity));
    return row ? {role: row.role as OrganizationRole} : null;
  }
  workspacesFor(identity: OrganizationIdentity) {
    return this.db.prepare("SELECT o.* FROM organizations o JOIN organization_members m ON o.id=m.org_id WHERE o.status='active' AND m.active=1 AND m.identity=? ORDER BY o.name COLLATE NOCASE")
      .all(organizationIdentityKey(identity)).map(row => {
        const saved = this.personalWorkspace(String(row.id), identity);
        return {id: String(row.id), name: String(row.name), workspace: saved ? {id: saved.id, state: saved.state, limits: saved.limits} : {state: 'not_provisioned' as const}};
      });
  }
  private personalRow(row: Row): PersonalWorkspace {
    const identity = JSON.parse(row.identity), limits = JSON.parse(row.limits) as OrganizationWorkspaceLimits;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.id) ||
        !Array.isArray(identity) || identity.length !== 2 ||
        !['provisioning','ready','failed'].includes(row.state) ||
        !Number.isInteger(limits.dailyRuns) || limits.dailyRuns < 1 || limits.dailyRuns > 50 ||
        !Number.isSafeInteger(limits.inputByteUnits) || limits.inputByteUnits < 1 || limits.inputByteUnits > 100_000_000 ||
        !Number.isSafeInteger(limits.outputTokens) || limits.outputTokens < 1 || limits.outputTokens > 2_000_000) {
      return fail(503, 'workspace_unavailable', 'Private workspace configuration could not be verified.');
    }
    const owner = {issuer: identity[0], subject: identity[1]};
    organizationIdentityKey(owner);
    return {id: row.id, organizationId: row.org_id, identity: owner, state: row.state, limits};
  }
  personalWorkspace(id: string, identity: OrganizationIdentity): PersonalWorkspace | null {
    const row = this.db.prepare('SELECT * FROM organization_personal_workspaces WHERE org_id=? AND identity=?').get(id, organizationIdentityKey(identity));
    return row ? this.personalRow(row) : null;
  }
  personalWorkspaces(): PersonalWorkspace[] {
    return this.db.prepare('SELECT * FROM organization_personal_workspaces').all().map(row => this.personalRow(row));
  }
  reservePersonalWorkspace(id: string, identity: OrganizationIdentity, limits: OrganizationWorkspaceLimits) {
    return this.transaction(() => {
      if (!this.lookupMembership(id, identity)) return fail(403, 'workspace_denied', 'You do not have access to this workspace.');
      const existing = this.personalWorkspace(id, identity);
      if (existing) return {workspace: existing, created: false};
      if (Number(this.db.prepare('SELECT COUNT(*) n FROM organization_personal_workspaces').get()!.n) >= 50) return fail(409, 'workspace_limit', 'This installation has reached its private workspace limit. Contact Rivet support.');
      this.db.prepare('INSERT INTO organization_personal_workspaces VALUES(?,?,?,?,?)').run(randomUUID(), id, organizationIdentityKey(identity), 'provisioning', JSON.stringify(limits));
      this.audit(id, identity, 'Private workspace preparation started');
      return {workspace: this.personalWorkspace(id, identity)!, created: true};
    });
  }
  finishPersonalWorkspace(id: string, identity: OrganizationIdentity, state: 'ready' | 'failed') {
    return this.transaction(() => {
      const saved = this.personalWorkspace(id, identity);
      if (saved?.state !== 'provisioning') return fail(409, 'workspace_changed', 'Private workspace setup state changed.');
      this.db.prepare('UPDATE organization_personal_workspaces SET state=? WHERE id=?').run(state, saved.id);
      this.audit(id, identity, state === 'ready' ? 'Private workspace ready' : 'Private workspace needs attention; storage retained');
      return this.personalWorkspace(id, identity)!;
    });
  }
  workspace(id: string): OrganizationWorkspace {
    const row = this.db.prepare('SELECT * FROM organization_workspaces WHERE org_id=?').get(id);
    if (!row) return {state: 'not_provisioned'};
    const limits = JSON.parse(String(row.limits)) as OrganizationWorkspaceLimits;
    if (!['provisioning','ready','failed'].includes(String(row.state)) || row.workspace_id !== `org_${id}` ||
        !Number.isInteger(limits.dailyRuns) || limits.dailyRuns < 1 || limits.dailyRuns > 50 ||
        !Number.isSafeInteger(limits.inputByteUnits) || limits.inputByteUnits < 1 || limits.inputByteUnits > 100_000_000 ||
        !Number.isSafeInteger(limits.outputTokens) || limits.outputTokens < 1 || limits.outputTokens > 2_000_000) {
      return fail(503, 'workspace_unavailable', 'Workspace configuration could not be verified.');
    }
    return {id: String(row.workspace_id), state: row.state as 'provisioning' | 'ready' | 'failed', limits};
  }
  reserveWorkspace(id: string, version: unknown, limits: OrganizationWorkspaceLimits, actor: OrganizationIdentity) {
    const workspace = this.workspace(id);
    if (workspace.state === 'ready') return this.detail(id);
    if (workspace.state !== 'not_provisioned') return fail(409, 'workspace_recovery_required', 'Workspace setup needs operator review. Its existing storage has been kept.');
    return this.change(id, version, actor, 'Customer workspace provisioning started', () => {
      if (!this.db.prepare("SELECT 1 FROM organization_members WHERE org_id=? AND active=1 AND role='owner'").get(id)) fail(409, 'owner_required', 'Approve an organization owner before provisioning a workspace.');
      if (Number(this.db.prepare('SELECT COUNT(*) n FROM organization_workspaces').get()!.n) >= 10) fail(409, 'workspace_limit', 'This installation supports at most ten customer workspaces.');
      this.db.prepare('INSERT INTO organization_workspaces VALUES(?,?,?,?)').run(id, `org_${id}`, 'provisioning', JSON.stringify(limits));
      this.workspace(id); // Validate server-supplied bounds inside the transaction.
    });
  }
  finishWorkspace(id: string, state: 'ready' | 'failed', actor: OrganizationIdentity) {
    return this.change(id, this.detail(id).version, actor, state === 'ready' ? 'Customer workspace ready' : 'Customer workspace setup failed; storage retained', () => {
      if (this.workspace(id).state !== 'provisioning') fail(409, 'workspace_changed', 'Workspace setup state changed.');
      this.db.prepare('UPDATE organization_workspaces SET state=? WHERE org_id=?').run(state, id);
    }, true);
  }
  deleteTeam(id: string, teamId: string, version: unknown, actor: OrganizationIdentity) {
    return this.change(id, version, actor, 'Team deleted', () => {
      if (!this.db.prepare('SELECT 1 FROM organization_teams WHERE org_id=? AND id=?').get(id, teamId)) fail(404, 'team_not_found', 'Team not found.');
      this.db.prepare('DELETE FROM organization_teams WHERE org_id=? AND id=?').run(id, teamId);
    });
  }
}
