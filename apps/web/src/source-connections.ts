import type { ConnectionListEntry } from '../../../packages/core/src/sync-jobs';
import { connectionState } from './connection-model';
import type { LibraryCategory, LibraryItem, LibrarySort } from './tables-library-items';

export type SourceLibraryEntry = LibraryItem | {
  kind: 'connection'; id: string; title: string; detail: string; label: string;
  category: 'connections'; date?: string; connection: ConnectionListEntry;
};

export function sourceConnectionStatus(connection: ConnectionListEntry): string {
  const state = connectionState(connection);
  if (state === 'disconnected') return 'Disconnected';
  if (state === 'syncing') return connection.latestVersion ? 'Updating' : 'Preparing data';
  if (state === 'needs_attention' || connection.lastFailure || connection.signedIn === false) return 'Needs attention';
  if (state === 'active') return 'Ready';
  return connection.lastAttempt?.status === 'succeeded' ? 'No data returned' : 'Not synced yet';
}

export function sourceLibraryEntries(items: LibraryItem[], connections: ConnectionListEntry[], providers: {id: string; label: string}[]): SourceLibraryEntry[] {
  const represented = new Set(connections.flatMap(item => item.latestVersion ? [item.latestVersion.sourceId] : []));
  return [
    ...items.filter(item => !represented.has(item.source.id)),
    ...connections.map(connection => ({ kind: 'connection' as const, category: 'connections' as const,
      id: `connection-${connection.id}`, title: connection.displayName,
      detail: providers.find(item => item.id === connection.provider)?.label ?? connection.provider,
      label: sourceConnectionStatus(connection), date: connection.lastAttempt?.at ?? connection.latestVersion?.observedAt, connection })),
  ];
}

export function visibleSourceEntries(items: SourceLibraryEntry[], query: string, category: LibraryCategory | 'connections', sort: LibrarySort) {
  const search = query.trim().toLocaleLowerCase();
  return items.filter(item => (category === 'all' || item.category === category) && `${item.title} ${item.detail}`.toLocaleLowerCase().includes(search))
    .sort((a, b) => {
      const order = sort === 'type' ? a.kind.localeCompare(b.kind) : sort === 'newest' ? (Date.parse(b.date ?? '') || 0) - (Date.parse(a.date ?? '') || 0) : 0;
      return order || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
}

export function selectedSourceConnection(search: string) {
  const params = new URLSearchParams(search);
  const id = params.get('sourceConnection');
  return params.get('view') === 'tables' && id && /^conn_[0-9a-f]{24}$/.test(id) ? id : null;
}

export function rememberSourceConnection(id: string | null) {
  const url = new URL(location.href);
  if (id) { url.searchParams.set('sourceConnection', id); url.searchParams.delete('file'); }
  else url.searchParams.delete('sourceConnection');
  history.replaceState(history.state, '', url);
}

export function sourceSignInReturn(search: string): string {
  const params = new URLSearchParams(search);
  params.set('view', 'tables');
  params.delete('settings');
  return `?${params}`;
}
