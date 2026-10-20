import { createHash } from 'node:crypto';

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/**
 * Deterministic JSON for hashing: object keys sorted, no incidental whitespace.
 * Two records with the same fields in a different insertion order hash identically,
 * so a re-export of unchanged data is recognised as the same batch.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return 'null';
}
