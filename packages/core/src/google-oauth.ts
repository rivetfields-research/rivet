import type { BoundedResponse } from './oauth.ts';

/** A client configuration error or provider outage is not evidence that a user revoked access. */
export function isGoogleInvalidRefreshGrant(response: BoundedResponse): boolean {
  if (response.status !== 400 || response.truncated) return false;
  try {
    const value: unknown = JSON.parse(response.body);
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
      'error' in value && value.error === 'invalid_grant');
  } catch { return false; }
}
