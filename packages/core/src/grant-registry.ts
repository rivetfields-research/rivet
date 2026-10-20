/*
 * Provider-side grants shared across runtimes (M8 security review). Meta keeps one grant per person and app for the
 * whole installation, so the same person signed in from two private workspaces (two organizations, or a private and
 * the shared pilot runtime) holds one grant. Revoking it from one runtime would cut off the other. Every runtime in the
 * process registers a holder that counts what it still keeps for a grant (connections with a sealed sign-in, and pending
 * account choices); a grant is revoked only when the count across all of them is zero.
 *
 * One registry per process, created in each entry point like the sync limiter and passed to every runtime. Hosted
 * also registers a read-only holder over saved workspace databases, so unopened runtimes remain protected after
 * restart. Counts may overlap; only zero versus nonzero determines whether a grant can be revoked.
 */
export interface GrantHolderQuery {
  /** The sign-in provider (for example `meta`). */
  signIn: string;
  /** The grant's hash, or undefined when it is not known (then any grant of that sign-in provider counts). */
  grantKey: string | undefined;
  /** Not counted: the connection being disconnected, or the choice being dropped. */
  exceptConnection?: string;
  exceptChoice?: string;
}
export type GrantHolder = (query: GrantHolderQuery) => number;
export interface GrantRegistry {
  /** Adds a runtime's holder; returns the function that removes it (on close). */
  register(holder: GrantHolder): () => void;
  /** Nonzero if an open runtime or a registered persistent holder still uses the grant. */
  inUse(query: GrantHolderQuery): number;
}

export function createGrantRegistry(): GrantRegistry {
  const holders = new Set<GrantHolder>();
  return {
    register(holder) {
      if (typeof holder !== 'function') throw new TypeError('A grant holder is a function.');
      holders.add(holder);
      return () => { holders.delete(holder); };
    },
    inUse(query) {
      let count = 0;
      // A holder that cannot answer (its runtime is closing) counts as in use: never revoke on a guess.
      for (const holder of holders) { try { count += holder(query); } catch { count += 1; } }
      return count;
    },
  };
}
