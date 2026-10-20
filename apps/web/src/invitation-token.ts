export const invitationStorageKey = 'rivet:invitation';

export function readInvitationToken(hash: string, storage: Pick<Storage, 'getItem' | 'removeItem'>, now = Date.now()): string {
  const direct = hash.slice(1);
  if (/^[\w-]{43}$/.test(direct)) return direct;
  try {
    const saved = JSON.parse(storage.getItem(invitationStorageKey) ?? 'null');
    if (saved && /^[\w-]{43}$/.test(saved.token) && Number.isFinite(saved.createdAt) && now >= saved.createdAt && now - saved.createdAt < 60 * 60 * 1000) return saved.token;
    storage.removeItem(invitationStorageKey);
  } catch { /* A blocked browser store must not prevent opening a fresh link. */ }
  return '';
}
