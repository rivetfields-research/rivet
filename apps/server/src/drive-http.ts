import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HarnessError } from '../../../packages/core/src/errors.ts';
import type { createGoogleDrive } from '../../../packages/core/src/google-drive.ts';

export interface DriveHttpOptions {
  service: ReturnType<typeof createGoogleDrive>;
  appOrigin: string;
  redirectUri: string;
  pickerApiKey?: string;
  projectNumber?: string;
  cancelActiveRun: () => void;
}
const PREFIX = '/api/connections/google-drive';
const COOKIE = 'rivetfields_drive_oauth';
const invalid = () => new HarnessError('This Drive request is not valid.', 400, 'invalid_drive_request');

export function driveStatus(options?: DriveHttpOptions) {
  const status = options?.service.status() ?? { configured: false, status: 'disconnected' as const, account: null, files: [], message: 'Google Drive is not enabled for this workspace.' };
  return {
    ...status,
    pickerConfigured: Boolean(options?.pickerApiKey && options.projectNumber),
    setup: { appOrigin: options?.appOrigin ?? null, redirectUri: options?.redirectUri ?? null, missing: [
      ...(!status.configured ? ['Google OAuth client'] : []),
      ...(!options?.pickerApiKey ? ['Google Picker API key'] : []),
      ...(!options?.projectNumber ? ['Google Cloud project number'] : []),
    ] },
  };
}

export async function driveRoute(options: DriveHttpOptions | undefined, request: IncomingMessage, response: ServerResponse, url: URL, readBody: () => Promise<Record<string, unknown>>) {
  const pathname = url.pathname;
  if (!pathname.startsWith(PREFIX)) return undefined;
  if (request.method === 'GET' && pathname === PREFIX) return { status: 200, value: driveStatus(options) };
  if (!options) throw new HarnessError('Google Drive is not enabled for this workspace.', 503, 'drive_unavailable');
  if (request.method === 'GET' && pathname === `${PREFIX}/callback`) {
    // The only cross-site route. Both state and a browser-bound HttpOnly cookie are required.
    const binding = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
    response.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=${PREFIX}; Max-Age=0`);
    let result = 'connected';
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(binding) || !url.searchParams.get('state') || !url.searchParams.get('code') || url.searchParams.has('error')) throw invalid();
      await options.service.completeAuthorization({ state: url.searchParams.get('state')!, code: url.searchParams.get('code')!, binding }, AbortSignal.timeout(15_000));
      options.cancelActiveRun();
    } catch { result = 'failed'; }
    response.writeHead(303, { Location: `${options.appOrigin}/?view=connections&drive=${result}`, 'Cache-Control': 'no-store' });
    response.end();
    return { handled: true as const };
  }
  if (request.method !== 'POST') throw new HarnessError('That connection route was not found.', 404, 'not_found');
  const body = await readBody();
  if (pathname === `${PREFIX}/authorize`) {
    if (Object.keys(body).length) throw invalid();
    // The callback must receive the same host-scoped cookie set through the UI.
    if (request.headers.origin && new URL(request.headers.origin).hostname !== new URL(options.redirectUri).hostname) throw new HarnessError(`Open ${options.appOrigin} to connect Google Drive.`, 400, 'drive_origin');
    if (!options.pickerApiKey || !options.projectNumber) throw new HarnessError('Finish Google Picker setup before connecting an account.', 503, 'drive_setup_required');
    const binding = randomBytes(32).toString('base64url');
    const authorization = options.service.beginAuthorization(binding);
    response.setHeader('Set-Cookie', `${COOKIE}=${binding}; HttpOnly; SameSite=Lax; Path=${PREFIX}; Max-Age=600`);
    return { status: 200, value: { url: authorization.url } };
  }
  if (pathname === `${PREFIX}/picker-session`) {
    if (Object.keys(body).length) throw invalid();
    if (!options.pickerApiKey || !options.projectNumber) throw new HarnessError('Google Picker is not configured.', 503, 'drive_setup_required');
    const session = await options.service.pickerSession(AbortSignal.timeout(15_000));
    return { status: 200, value: { ...session, apiKey: options.pickerApiKey, appId: options.projectNumber } };
  }
  if (pathname === `${PREFIX}/selection`) {
    if (Object.keys(body).some(key => key !== 'fileIds') || !Array.isArray(body.fileIds) || body.fileIds.some(id => typeof id !== 'string')) throw invalid();
    await options.service.selectFiles(body.fileIds as string[], AbortSignal.timeout(15_000));
    options.cancelActiveRun();
    return { status: 200, value: driveStatus(options) };
  }
  if (pathname === `${PREFIX}/disconnect`) {
    if (Object.keys(body).length) throw invalid();
    options.cancelActiveRun();
    await options.service.disconnect();
    return { status: 200, value: driveStatus(options) };
  }
  throw new HarnessError('That connection route was not found.', 404, 'not_found');
}
