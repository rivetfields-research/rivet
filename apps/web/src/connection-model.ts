import type { ConnectionListEntry, SyncAttemptStatus, SyncScheduleInput, SyncTrigger } from '../../../packages/core/src/sync-jobs';
import type { WorkflowSchedule } from '../../../packages/core/src/workflow-schedules';
import type { WorkspaceSession } from './session-access';

/** `GET /api/connections`. Managers get their connections; everyone else gets an empty list. */
export interface ConnectionsResponse {
  runtimeEnabled: boolean;
  unavailableReason?: 'desktop';
  providers: ConnectionProviderOption[];
  connections: ConnectionListEntry[];
}
/**
 * `signIn: 'oauth'`: the source is connected by signing in to its account (M7), not added directly. `signInProvider`
 * names a sign-in shared by several sources (M8: one Meta sign-in for Instagram and Facebook Pages).
 */
export interface ConnectionProviderOption { id: string; label: string; enabled: boolean; signIn?: 'oauth' | 'broker'; signInProvider?: string; sourceProvider?: string; credential?: 'api_token'; automaticDailySync?: boolean }
export function collectionScope(provider: ConnectionProviderOption): string | null {
  if (provider.signIn === 'broker') return null;
  if (provider.signInProvider === 'meta') return 'Posts from the last 90 days';
  return ({ youtube: 'Up to 500 recent videos', mailchimp: 'Campaigns sent in the last 90 days', 'google-analytics': 'The last 90 completed days' } as Record<string, string>)[provider.id] ?? null;
}
/**
 * What an owner enters to add an Apify connection (M9). The token goes to the server once, in the add request; it is
 * kept only in this form's memory until then, never in a draft, and the server never sends it back.
 */
export interface ApifySetup { source: 'dataset' | 'task'; id: string; platform: '' | 'instagram' | 'facebook'; account: string; token: string }
export const EMPTY_APIFY_SETUP: ApifySetup = { source: 'dataset', id: '', platform: '', account: '', token: '' };
export const apifySetupReady = (setup: ApifySetup) => Boolean(setup.id.trim() && setup.platform && setup.account.trim() && setup.token.trim());
/** "Reads" for an API-token connection: the dataset or task saved with it, and whose posts they are. Never the token. */
export function apifyReads(connection: Pick<ConnectionListEntry, 'providerAccountId' | 'mapping'>): string | null {
  const [kind, ...rest] = connection.providerAccountId.split(':');
  const mapping = connection.mapping as { platform?: unknown; account?: unknown } | undefined;
  if ((kind !== 'dataset' && kind !== 'task') || !rest.length) return null;
  const platform = mapping?.platform === 'instagram' ? 'Instagram' : mapping?.platform === 'facebook' ? 'Facebook' : null;
  return `${kind === 'task' ? 'Task' : 'Dataset'} ${rest.join(':')}${platform && typeof mapping?.account === 'string' ? ` · ${platform} · ${mapping.account}` : ''}`;
}
/** `GET /api/connections/:provider/choices/:id`: the accounts a sign-in found (M8). Never a credential. */
export interface ConnectionChoice { provider: string; product?: string; expiresAt: string; accounts: ConnectionChoiceAccount[] }
export interface ConnectionChoiceAccount { id: string; provider: string; providerLabel: string; displayName: string; state: 'new' | 'reconnect' | 'connected' | 'unavailable' }
/** A saved sign-in that ends within this window asks to be renewed (Meta user tokens last about 60 days). */
const RECONNECT_WARNING_MS = 7 * 24 * 3600_000;
export const reconnectSoon = (connection: Pick<ConnectionListEntry, 'reconnectBy'>, now = Date.now()) =>
  Boolean(connection.reconnectBy && Date.parse(connection.reconnectBy) - now <= RECONNECT_WARNING_MS);
/** `GET /api/connections/:id/attempts`: keys and column mappings stay on the server. */
export interface ConnectionAttempt {
  id: string; trigger: SyncTrigger; status: SyncAttemptStatus; createdAt: string; startedAt?: string; finishedAt?: string;
  versionIds: string[]; files: { name: string; contentHash: string; bytes: number; observedAt: string }[];
  errorCode?: string; message?: string; bytes?: number; records?: number;
}

export type ConnectionState = 'active' | 'needs_attention' | 'disconnected' | 'no_data' | 'syncing';
export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  active: 'Active', needs_attention: 'Needs attention', disconnected: 'Disconnected', no_data: 'No data yet', syncing: 'Syncing…',
};
export const STATE_CLASS: Record<ConnectionState, string> = { active: 'completed', needs_attention: 'failed', disconnected: '', no_data: '', syncing: 'running' };
export const ATTEMPT_LABELS: Record<SyncAttemptStatus, string> = { pending: 'Waiting', started: 'Running', completed: 'New data', unchanged: 'No change', failed: 'Failed', interrupted: 'Interrupted' };
export const TRIGGER_LABELS: Record<SyncTrigger, string> = { manual: 'Sync now', schedule: 'Scheduled', presync: 'Before a report', connect: 'Account connected' };
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The state shown is the saved state: a disconnect wins, then an attempt in flight, then health, then data. */
export function connectionState(connection: Pick<ConnectionListEntry, 'status' | 'activeAttempt' | 'latestVersion'>): ConnectionState {
  if (connection.status === 'disconnected') return 'disconnected';
  if (connection.activeAttempt) return 'syncing';
  if (connection.status === 'needs_attention') return 'needs_attention';
  return connection.latestVersion ? 'active' : 'no_data';
}

/** Mode-aware visibility (D-1). Local workspaces have one user, so no notice. */
export function connectionVisibilityNotice(session: WorkspaceSession | null | undefined): string | null {
  if (session?.mode !== 'authenticated') return null;
  return session.privateWorkspace ? 'Only you can see data synced here.' : 'Synced data is visible to everyone in this workspace.';
}
export function accessDescription(session: WorkspaceSession | null | undefined): string {
  if (session?.mode !== 'authenticated') return 'Only this local workspace.';
  return session.privateWorkspace ? 'Only you.' : 'Everyone in this workspace.';
}

export function localTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unknown time';
}
/**
 * The account sign-in (M7) and what the browser came back with. Only the saved result is read; never a code. A sign-in
 * that lists accounts (M8) returns `choose` with its one-use choice, read back from the server.
 */
export function signInReturn(search: string): { connectionId: string | null; result: 'connected' | 'failed'; reason?: 'instagram_account_missing' } | { connectionId: null; result: 'choose'; provider: string; choice: string } | null {
  const params = new URLSearchParams(search);
  const result = params.get('result');
  if (result === 'choose') {
    const provider = params.get('provider') ?? '', choice = params.get('choice') ?? '';
    return /^[a-z][a-z0-9-]{0,39}$/.test(provider) && /^[A-Za-z0-9_-]{43}$/.test(choice) ? { connectionId: null, result, provider, choice } : { connectionId: null, result: 'failed' };
  }
  if (result !== 'connected' && result !== 'failed') return null;
  const connectionId = params.get('connection');
  return { connectionId: connectionId && /^conn_[0-9a-f]{24}$/.test(connectionId) ? connectionId : null, result,
    ...(result === 'failed' && params.get('reason') === 'instagram_account_missing' ? { reason: 'instagram_account_missing' as const } : {}) };
}


export type DataConnectionsViewProps = {
  session: WorkspaceSession | null | undefined; workspaceName: string; data: ConnectionsResponse | null; loadError: string; actionError: string; notice: string; busy: string | null;
  /** A pending account choice after a sign-in (M8), with what connecting or cancelling it does. */
  choice?: ConnectionChoice | null; onChoose?: (accounts: { id: string; displayName: string }[]) => Promise<boolean> | void; onCancelChoice?: () => void;
  onAdd: (provider: string, displayName: string, apify?: ApifySetup) => Promise<string | null>; onSync: (connection: ConnectionListEntry) => void;
  /** Starts the provider's account sign-in again for this connection. */
  onReconnect?: (connection: ConnectionListEntry) => void;
  /** A connection to focus once listed, e.g. after returning from its sign-in. */
  focusConnection?: string | null;
  onOpenSource?: (id: string) => void;
  onSchedule: (connection: ConnectionListEntry, input: SyncScheduleInput) => Promise<boolean>; onDisconnect: (connection: ConnectionListEntry) => Promise<boolean>;
  loadAttempts: (id: string) => Promise<ConnectionAttempt[]>; loadSchedules: () => Promise<WorkflowSchedule[]>;
};
