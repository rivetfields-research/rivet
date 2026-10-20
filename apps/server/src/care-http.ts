import type { createCareService } from '../../../packages/core/src/care.ts';
import type { CareActorId, CareMutation, CareVersionMutation } from '../../../packages/core/src/care-types.ts';

export type CareApi = Awaited<ReturnType<typeof createCareService>>;
class CareHttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const actors = new Set(['intake', 'reviewer', 'clinician', 'supervisor']);

function mutation(value: Record<string, unknown>, keys: string[], versioned: true): CareVersionMutation;
function mutation(value: Record<string, unknown>, keys: string[]): CareMutation;
function mutation(value: Record<string, unknown>, keys: string[], versioned = false): CareMutation | CareVersionMutation {
  const allowed = ['actorId', 'requestId', ...(versioned ? ['caseVersion'] : []), ...keys];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new CareHttpError(400, 'invalid_request', 'This action contains an unsupported field.');
  if (typeof value.actorId !== 'string' || !actors.has(value.actorId)) throw new CareHttpError(400, 'invalid_actor', 'Choose a demo staff role.');
  if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value.requestId)) throw new CareHttpError(400, 'invalid_request_id', 'A valid request ID is required.');
  if (versioned && (!Number.isSafeInteger(value.caseVersion) || (value.caseVersion as number) < 1)) throw new CareHttpError(400, 'invalid_version', 'Provide the document version you are reviewing.');
  const common = { actorId: value.actorId as CareActorId, requestId: value.requestId };
  return versioned ? { ...common, caseVersion:value.caseVersion as number } : common;
}
function text(value: unknown, label: string, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new CareHttpError(400, 'invalid_request', `Provide ${label} (1–${max} characters).`);
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new CareHttpError(400, 'invalid_request', 'Choose a supported action.');
  return value as T;
}
function positiveNumber(value: unknown, max: number) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new CareHttpError(400, 'invalid_request', `Provide a whole number between 1 and ${max}.`);
  return value as number;
}

/** No route can accept documents, expected answers, tool grants, or a destination URL. */
export async function careRoute(care: CareApi | undefined, method: string, pathname: string, readBody: () => Promise<Record<string, unknown>>): Promise<{ status: number; value: unknown }> {
  if (!care) throw new CareHttpError(404, 'care_unavailable', 'The referral workspace is not enabled in this profile.');
  const okay = (value: unknown, status = 200) => ({ status, value });
  if (method === 'GET' && pathname === '/api/care/overview') return okay(care.overview());
  if (method === 'GET' && pathname === '/api/care/cases') return okay(care.listCases());
  const caseRoute = /^\/api\/care\/cases\/([a-zA-Z0-9_-]{1,100})(?:\/(analyze|view|review|handoff|assign|timer))?$/.exec(pathname);
  if (caseRoute && method === 'GET' && !caseRoute[2]) {
    const value = care.getCase(caseRoute[1]);
    if (!value) throw new CareHttpError(404, 'case_not_found', 'That referral was not found.');
    return okay(value);
  }
  if (method === 'POST') {
    if (caseRoute?.[2]) {
      const value = await readBody();
      const id = caseRoute[1];
      switch (caseRoute[2]) {
        case 'analyze': return okay(await care.analyze(id, mutation(value, [], true)), 202);
        case 'view': return okay(care.viewCase(id, mutation(value, [], true)));
        case 'handoff': return okay(care.handoff(id, mutation(value, [], true)));
        case 'review': return okay(care.review(id, {
          ...mutation(value, ['decision', 'note'], true),
          decision: choice(value.decision, ['approve', 'request_changes', 'resolve_identity', 'resolve_clinical']),
          note: text(value.note, 'a review note', 1600),
        }));
        case 'assign': return okay(care.assignCase(id, { ...mutation(value, ['ownerId'], true), ownerId: choice(value.ownerId, ['intake', 'reviewer', 'clinician', 'supervisor']) }));
        case 'timer': return okay(care.timer(id, { ...mutation(value, ['kind', 'action']), kind: choice(value.kind, ['manual_baseline', 'review']), action: choice(value.action, ['start', 'stop']) }));
      }
    }
    const cancel = /^\/api\/care\/analyses\/([a-zA-Z0-9_-]{1,100})\/cancel$/.exec(pathname);
    if (cancel) return okay(care.cancelAnalysis(cancel[1], mutation(await readBody(), [])));
    const followup = /^\/api\/care\/followups\/([a-zA-Z0-9_-]{1,100})\/resolve$/.exec(pathname);
    if (followup) return okay(care.resolveFollowUp(followup[1], mutation(await readBody(), [])));
    if (pathname === '/api/care/arrivals/ingest') {
      const value = await readBody();
      return okay(care.ingest({ ...mutation(value, ['fixtureId']), fixtureId: text(value.fixtureId, 'an arrival ID') }));
    }
    if (pathname === '/api/care/schedules') {
      const value = await readBody();
      const common = mutation(value, ['id', 'name', 'enabled', 'everyMinutes']);
      if (typeof value.enabled !== 'boolean') throw new CareHttpError(400, 'invalid_request', 'Choose whether this schedule is enabled.');
      return okay(care.setSchedule({ ...common, id: value.id === undefined ? undefined : text(value.id, 'a schedule ID'), name: text(value.name, 'a schedule name', 120), enabled: value.enabled, everyMinutes: positiveNumber(value.everyMinutes, 10080) }));
    }
    if (pathname === '/api/care/sweep') return okay(care.sweep(mutation(await readBody(), [])));
    if (pathname === '/api/care/clock/advance') {
      const value = await readBody();
      return okay(care.advanceClock({ ...mutation(value, ['minutes']), minutes: positiveNumber(value.minutes, 10080) }));
    }
  }
  throw new CareHttpError(404, 'not_found', 'That referral action was not found.');
}
