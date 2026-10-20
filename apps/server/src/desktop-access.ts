import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface DesktopAccess {
  readonly token: string;
  readonly port: number;
  readonly origin: string;
}

/** Only the desktop parent supplies these settings; never recover them from a local .env file. */
export function desktopAccessFromEnv(env: NodeJS.ProcessEnv): DesktopAccess | undefined {
  if (env.HARNESS_DESKTOP !== '1') return undefined;
  const token = env.HARNESS_DESKTOP_TOKEN;
  if (!token || !/^[a-fA-F0-9]{64}$/.test(token)) throw new Error('HARNESS_DESKTOP_TOKEN must be a 64-character hexadecimal token.');
  const port = Number(env.HARNESS_PORT);
  if (!/^\d+$/.test(env.HARNESS_PORT ?? '') || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Desktop HARNESS_PORT must be between 1024 and 65535.');
  }
  const origin = `http://127.0.0.1:${port}`;
  if (env.HARNESS_APP_ORIGIN !== origin) throw new Error('Desktop HARNESS_APP_ORIGIN must be http://127.0.0.1:<HARNESS_PORT>.');
  return Object.freeze({ token, port, origin });
}

export function createDesktopAccessGuard(access: DesktopAccess) {
  // Validate and capture the boundary once, even when supplied directly by an HTTP caller.
  const { token, port, origin } = desktopAccessFromEnv({ HARNESS_DESKTOP: '1', HARNESS_DESKTOP_TOKEN: access.token,
    HARNESS_PORT: String(access.port), HARNESS_APP_ORIGIN: access.origin })!;
  const expectedToken = Buffer.from(token, 'ascii');
  return (request: IncomingMessage): 'desktop_token_denied' | 'host_denied' | 'origin_denied' | undefined => {
    const supplied = request.headers['x-rivet-desktop-token'];
    if (typeof supplied !== 'string' || !/^[a-fA-F0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied, 'ascii'), expectedToken)) return 'desktop_token_denied';
    if (request.headersDistinct.host?.length !== 1 || request.headers.host !== `127.0.0.1:${port}`) return 'host_denied';
    const site = request.headers['sec-fetch-site'];
    if ((request.headers.origin !== undefined && request.headers.origin !== origin) ||
        (site !== undefined && site !== 'none' && site !== 'same-origin')) return 'origin_denied';
    return undefined;
  };
}
