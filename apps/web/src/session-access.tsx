export type WorkspaceSession = ({mode:'local'} | {mode:'authenticated';workspaceId:string;role:'owner'|'operator'|'reviewer';signInUrl:string;signOutUrl:string;displayName?:string;email?:string;organizationId?:string;workspaceName?:string;browserScope?:string;privateWorkspace?:boolean}) & {organizationAdmin?: boolean;workspacesEnabled?:boolean;testBilling?:boolean};

export function sessionDisplayName(session: WorkspaceSession | null | undefined): string | null {
  return session?.mode === 'authenticated' ? session.displayName?.trim() || null : null;
}
export function canManageSources(session: WorkspaceSession | null | undefined): boolean {
  return session?.mode === 'local' || (session?.mode === 'authenticated' && (session.role === 'owner' || (session.privateWorkspace === true && session.role === 'operator')));
}
export function workspaceGreeting(session: WorkspaceSession | null | undefined): string {
  const full = sessionDisplayName(session);
  const name = full && !full.includes('@') ? full.split(/\s+/)[0] : null;
  return name ? `Hello, ${name}.` : 'Hello.';
}

type LocationLike = Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>;

export function currentSignInUrl(session: WorkspaceSession | null | undefined, current: LocationLike = location) {
  const returnTo = `${current.pathname || '/'}${current.search}${current.hash}`;
  if (session?.mode !== 'authenticated' || !session.signInUrl || session.signInUrl === '/') return returnTo;
  const target = new URL(session.signInUrl, current.origin);
  if (target.pathname.startsWith('/oauth2/') && !target.searchParams.has('rd')) target.searchParams.set('rd', returnTo);
  return target.origin === current.origin ? `${target.pathname}${target.search}${target.hash}` : target.toString();
}

/** Authentication needs user navigation; permission denial never starts a login loop. */
export function SessionNotice({status,onSignIn}:{status:401|403;onSignIn:()=>void}) {
  return <div className="error-banner" role="alert"><span>{status===401?'Your session has ended. Sign in to continue.':'You don’t have permission for this action. Ask the workspace owner for access.'}</span>{status===401&&<button className="text-button" onClick={onSignIn}>Sign in again</button>}</div>;
}
