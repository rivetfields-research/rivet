import { workspaceBrowserStorage } from './workspace-scope';
import type { RecoveryStorage } from './draft-store';

type ProfileStorage = { local: RecoveryStorage; recovery: RecoveryStorage };
const profileStores = new Map<string, ProfileStorage>();

export function workspaceProfileStorage(profile: string): ProfileStorage {
  const existing = profileStores.get(profile);
  if (existing) return existing;
  // Keep the legacy healthcare keys and stable in-memory draft recovery.
  const scoped = (key: string) => profile === 'healthcare-operations' ? key : `${key}.${encodeURIComponent(profile)}`;
  const adapt = (area: 'localStorage' | 'sessionStorage'): RecoveryStorage => ({
    getItem: key => workspaceBrowserStorage(area).getItem(scoped(key)),
    setItem: (key, value) => workspaceBrowserStorage(area).setItem(scoped(key), value),
    removeItem: key => workspaceBrowserStorage(area).removeItem(scoped(key)),
  });
  const storage = { local: adapt('localStorage'), recovery: adapt('sessionStorage') };
  profileStores.set(profile, storage);
  return storage;
}
