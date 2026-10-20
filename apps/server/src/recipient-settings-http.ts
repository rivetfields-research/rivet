import type { OrganizationEmailRecipient, OrganizationIdentity, OrganizationRecipientSettings } from '../../../packages/core/src/organization-types.ts';
import { OrganizationError, type OrganizationStore } from './organizations.ts';

const recipientPath = /^\/api\/email-recipients\/([\w-]{1,64})$/;

/** Outer customer-workspace gates may use read membership for this PATCH; the helper enforces the write boundary. */
export function isRecipientSettingsPatch(pathname: string, method: string | undefined): boolean {
  return method === 'PATCH' && recipientPath.test(pathname);
}

/** Call only from the authenticated customer workspace extension, with its bound organization and verified identity. */
export async function recipientSettingsRoute({store, organizationId, identity, pathname, method, readBody}: {
  store: OrganizationStore;
  organizationId: string;
  identity: OrganizationIdentity | undefined;
  pathname: string;
  method: string | undefined;
  readBody: () => Promise<Record<string, unknown>>;
}): Promise<OrganizationRecipientSettings | OrganizationEmailRecipient | undefined> {
  if (pathname !== '/api/email-recipients' && !pathname.startsWith('/api/email-recipients/')) return undefined;
  if (!identity) throw new OrganizationError(401, 'authentication_required', 'Sign in to manage recipient settings.');
  store.sharedMember(organizationId, identity);
  if (pathname === '/api/email-recipients' && method === 'GET') return store.recipientSettings(organizationId, identity);
  const match = recipientPath.exec(pathname);
  if (match && method === 'PATCH') {
    const input = await readBody();
    return store.updateRecipientFirstName(organizationId, match[1], input, identity);
  }
  if (pathname !== '/api/email-recipients' && !match) throw new OrganizationError(404, 'recipient_not_found', 'Recipient not found.');
  throw new OrganizationError(405, 'method_not_allowed', 'Unsupported recipient settings action.');
}
