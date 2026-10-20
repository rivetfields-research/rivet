import type { CareActorId } from '../../../packages/core/src/care-types';

export const CARE_REQUEST_KEY = 'rivetfields.care.pending.v1';
export type CareRequest = { version: 1; path: string; label: string; body: Record<string, string | number | boolean> & { actorId: CareActorId; requestId: string } };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const actorIds = new Set(['intake', 'reviewer', 'clinician', 'supervisor']);
const pathPattern = /^\/api\/care\/(arrivals\/ingest|cases\/[a-zA-Z0-9_-]{1,100}\/(analyze|view|review|handoff|assign|timer)|analyses\/[a-zA-Z0-9_-]{1,100}\/cancel|schedules|sweep|clock\/advance|followups\/[a-zA-Z0-9_-]{1,100}\/resolve)$/;
function valid(value: unknown): value is CareRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as CareRequest;
  return request.version === 1 && typeof request.path === 'string' && pathPattern.test(request.path)
    && typeof request.label === 'string' && request.label.length > 0 && request.label.length <= 160
    && !!request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    && actorIds.has(request.body.actorId) && typeof request.body.requestId === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(request.body.requestId)
    && Object.values(request.body).every(v => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 4000));
}
export function readCareRequest(storage: Store = window.sessionStorage): CareRequest | null {
  try { const raw = storage.getItem(CARE_REQUEST_KEY); if (raw === null) return null; const value: unknown = JSON.parse(raw); if (!valid(value)) throw Error(); return value; }
  catch { throw new Error('The pending action could not be restored. Its recovery record has been kept.'); }
}
export function keepCareRequest(request: CareRequest, storage: Store = window.sessionStorage): void {
  if (!valid(request)) throw new Error('This action is not a valid referral request.');
  const existing = readCareRequest(storage);
  if (existing && JSON.stringify(existing) !== JSON.stringify(request)) throw new Error('Resolve the pending action before starting another.');
  try { storage.setItem(CARE_REQUEST_KEY, JSON.stringify(request)); }
  catch { throw new Error('This action was not started because its retry record could not be saved.'); }
}
export function clearCareRequest(storage: Store = window.sessionStorage): void {
  try { storage.removeItem(CARE_REQUEST_KEY); }
  catch { throw new Error('The action was confirmed, but its retry record could not be cleared. Retry uses the same request.'); }
}
