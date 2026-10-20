import { randomBytes } from 'node:crypto';
import { HarnessError } from './errors.ts';
import type { RunAccessContext } from './types.ts';

export interface BrokerAccount { accountId: string; displayName: string }
export interface ConnectionBroker {
  begin(signal: AbortSignal): Promise<{ url: string; token: string }>;
  accounts(token: string, signal: AbortSignal): Promise<BrokerAccount[]>;
}
export interface BrokerChoice {
  id: string; provider: string; expiresAt: string;
  accounts: { id: string; provider: string; providerLabel: string; displayName: string; state: 'new' }[];
}
interface Pending {
  id: string; provider: string; owner: string; token: string; expires: number;
  accounts: Map<string, BrokerAccount>; busy: boolean; timer: ReturnType<typeof setTimeout>;
}
const identity = (actor?: RunAccessContext) => JSON.stringify(actor ? [actor.workspaceId, actor.actor.issuer, actor.actor.subject] : null);
const refused = () => new HarnessError('This connection request ended. Start again from Sources.', 410, 'connection_request_ended');

/** One runtime per private workspace; no provider grant or account ID is accepted from the browser. */
export function createBrokerConnections(options: {
  provider(id: string): { label: string; broker: ConnectionBroker };
  authorize(actor?: RunAccessContext): Promise<void>;
  save(provider: string, account: BrokerAccount, token: string, actor?: RunAccessContext): { id: string };
  signal(): AbortSignal; ttlMs?: number;
}) {
  const pending = new Map<string, Pending>();
  let closed = false, starting = 0;
  const drop = (item: Pending) => { clearTimeout(item.timer); pending.delete(item.id); };
  const current = (provider: string, id: string, actor?: RunAccessContext) => {
    const item = pending.get(id);
    if (closed || !item || item.provider !== provider || item.owner !== identity(actor) || item.expires <= Date.now()) throw refused();
    return item;
  };
  return {
    async begin(provider: string, actor?: RunAccessContext) {
      await options.authorize(actor);
      if (closed) throw refused();
      if (pending.size + starting >= 10) throw new HarnessError('Finish or cancel an existing connection first.', 429, 'connection_request_limit');
      const adapter = options.provider(provider);
      starting++;
      try {
        const result = await adapter.broker.begin(options.signal());
        await options.authorize(actor);
        if (closed) throw refused();
        const id = randomBytes(32).toString('base64url'), ttl = options.ttlMs ?? 10 * 60_000;
        const timer = setTimeout(() => pending.delete(id), ttl); timer.unref();
        const item: Pending = { id, provider, owner: identity(actor), token: result.token, expires: Date.now() + ttl,
          accounts: new Map(), busy: false, timer };
        pending.set(id, item);
        return { id, provider, url: result.url, expiresAt: new Date(item.expires).toISOString() };
      } finally { starting--; }
    },
    async read(provider: string, id: string, actor?: RunAccessContext): Promise<BrokerChoice> {
      await options.authorize(actor);
      const item = current(provider, id, actor), adapter = options.provider(provider);
      if (item.busy) throw new HarnessError('This connection is being checked.', 409, 'connection_busy');
      item.busy = true;
      try {
        const accounts = await adapter.broker.accounts(item.token, options.signal());
        await options.authorize(actor); current(provider, id, actor);
        if (accounts.length > 100 || new Set(accounts.map(account => account.accountId)).size !== accounts.length ||
            accounts.some(account => !/^[A-Za-z0-9._:-]{1,200}$/.test(account.accountId) || !account.displayName.trim() || account.displayName.length > 160)) {
          throw new HarnessError('The account list could not be verified.', 502, 'provider_invalid_result');
        }
        const previous = item.accounts;
        item.accounts = new Map(accounts.map(account => [
          [...previous].find(([, saved]) => saved.accountId === account.accountId)?.[0] ?? randomBytes(16).toString('base64url'), account,
        ]));
        return { id, provider, expiresAt: new Date(item.expires).toISOString(), accounts: [...item.accounts].map(([optionId, account]) => ({
          id: optionId, provider, providerLabel: adapter.label, displayName: account.displayName, state: 'new',
        })) };
      } finally { item.busy = false; }
    },
    async confirm(provider: string, id: string, input: unknown, actor?: RunAccessContext) {
      await options.authorize(actor);
      const item = current(provider, id, actor);
      // One account per handoff keeps confirmation and failure recovery unambiguous.
      const picks = (input as { accounts?: { id?: unknown; displayName?: unknown }[] })?.accounts;
      if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || !Array.isArray(picks) || picks.length !== 1 ||
          !picks[0] || typeof picks[0].id !== 'string' || Object.keys(picks[0]).some(key => !['id', 'displayName'].includes(key))) {
        throw new HarnessError('Choose one account to connect.', 400, 'invalid_connection');
      }
      const account = item.accounts.get(picks[0].id);
      if (!account) throw new HarnessError('That account was not offered by this sign-in.', 400, 'invalid_connection');
      if (item.busy) throw new HarnessError('This connection is being checked.', 409, 'connection_busy');
      item.busy = true;
      try {
        const fresh = await options.provider(provider).broker.accounts(item.token, options.signal());
        await options.authorize(actor); current(provider, id, actor);
        if (!fresh.some(found => found.accountId === account.accountId)) throw new HarnessError('Account access changed. Connect again.', 403, 'permission_missing');
        const saved = options.save(provider, account, item.token, actor);
        drop(item);
        return { connections: [saved] };
      } finally { item.busy = false; }
    },
    async cancel(provider: string, id: string, actor?: RunAccessContext) {
      await options.authorize(actor); drop(current(provider, id, actor));
      return { cancelled: true };
    },
    close() { closed = true; for (const item of pending.values()) drop(item); },
  };
}
