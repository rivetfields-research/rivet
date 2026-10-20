const organizationPattern = /^\/w\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/|$)/;
const currentPath = () => typeof location === 'undefined' ? '/' : location.pathname;
/** Manual imports remain available to local QA, not customer onboarding. */
export function allowsManualImports(pathname = currentPath()): boolean {
  return !pathname.startsWith('/w/');
}
export function customerOrganization(pathname = currentPath()): string | null {
  return organizationPattern.exec(pathname)?.[1] ?? null;
}
export function workspaceApiPath(route: string, pathname = currentPath()): string {
  const organization = customerOrganization(pathname);
  if (pathname.startsWith('/w/') && !organization) throw new Error('Invalid customer workspace address.');
  // Team membership is managed by the root registry, not a private runtime.
  if (route.startsWith('/api/team/')) return route;
  if (organization && route.startsWith('/team/api/')) return `/w/${organization}${route}`;
  if (organization && typeof location !== 'undefined' && new URLSearchParams(location.search).get('data') === 'team' && ['tables','sources'].includes(new URLSearchParams(location.search).get('view') ?? '') && /^\/api\/(connections|datasets\/tabular|files|sources)(?:\/|$)/.test(route) && !route.includes('/team_')) return `/w/${organization}/team${route}`;
  return organization && route.startsWith('/api/') ? `/w/${organization}${route}` : route;
}

let verifiedScope: string | undefined;
export function workspaceRequestHeaders(): Record<string, string> {
  return customerOrganization() && verifiedScope ? {'X-Rivet-Workspace-Scope': verifiedScope} : {};
}
export function initializeWorkspaceScope(scope: string) {
  if (!/^[a-f0-9]{64}$/.test(scope) || (verifiedScope !== undefined && verifiedScope !== scope)) throw new Error('Reload to switch workspace accounts.');
  verifiedScope = scope;
}
export function scopedStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, scope: string) {
  const key = (name: string) => `rivetfields.customer.${scope}.${name}`;
  return {getItem: (name: string) => storage.getItem(key(name)), setItem: (name: string, value: string) => storage.setItem(key(name), value), removeItem: (name: string) => storage.removeItem(key(name))};
}
export function workspaceBrowserStorage(area: 'localStorage' | 'sessionStorage' = 'localStorage') {
  const storage = window[area];
  if (currentPath().startsWith('/w/') && !customerOrganization()) throw new Error('Invalid customer workspace address.');
  if (!customerOrganization()) return storage;
  // Mount the customer application only after its authenticated session initializes this scope.
  if (!verifiedScope) throw new Error('Workspace identity has not been verified.');
  return scopedStorage(storage, verifiedScope);
}
