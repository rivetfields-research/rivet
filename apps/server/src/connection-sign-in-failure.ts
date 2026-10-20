import { HarnessError } from '../../../packages/core/src/errors.ts';

const REASONS = new Set([
  'oauth_provider_declined', 'oauth_code_missing', 'oauth_handler_missing',
  'oauth_failed', 'oauth_grant_invalid', 'oauth_invalid_response', 'oauth_unavailable',
  'oauth_response_limit', 'oauth_host_denied', 'oauth_state', 'oauth_superseded',
  'oauth_no_accounts', 'oauth_no_instagram_accounts', 'oauth_account_missing', 'connection_manager_required',
  'credential_setup_required', 'rate_limited', 'permission_missing',
  'meta_token_exchange_failed', 'meta_token_inspection_failed', 'meta_accounts_failed',
]);

/** Only fixed categories reach logs: never the error message, request URL, actor or provider payload. */
export function reportSignInFailure(error: unknown): void {
  const reason = error instanceof HarnessError && REASONS.has(error.code) ? error.code : 'unexpected_failure';
  console.warn(JSON.stringify({ event: 'connection_sign_in_failed', reason }));
}
