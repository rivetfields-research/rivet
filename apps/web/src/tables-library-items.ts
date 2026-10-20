import type { Source } from '../../../packages/core/src/types';
import { sourceTableKind } from '../../../packages/core/src/source-table';

export type LibraryCategory = 'all' | 'csv' | 'documents';
export type LibrarySort = 'name' | 'type' | 'newest';
type Item = { id: string; title: string; detail: string; category: Exclude<LibraryCategory, 'all'>; label: string; size: string; date?: string };
export type LibraryItem = Item & { kind: 'source'; source: Source };
export function libraryFileName(source: Source): string { return source.title.replace(/^Social CSV · /, ''); }

export function libraryItems(sources: readonly Source[]): LibraryItem[] {
  // Calculation receipts remain addressable as evidence, but are outputs, not input sources.
  const items: LibraryItem[] = sources.filter(source => source.provenance || !/^calculations\/[^/]+\/receipt\.md$/.test(source.path)).map(source => {
    const csv = sourceTableKind(source);
    return { kind: 'source', source, id: `source-${source.id}`, title: libraryFileName(source), detail: source.provenance ? 'Google Drive' : '',
      category: csv ? 'csv' : 'documents', label: csv ? 'CSV' : 'Document',
      size: csv && csv !== 'csv' ? 'Saved dataset' : `${(source.bytes / 1024).toFixed(1)} KB` };
  });
  return [...new Map(items.map(item => [item.id, item])).values()];
}

export function visibleLibraryItems(items: readonly LibraryItem[], query: string, category: LibraryCategory, sort: LibrarySort): LibraryItem[] {
  const search = query.trim().toLocaleLowerCase();
  return items.filter(item => (category === 'all' || item.category === category) && `${item.title} ${item.detail}`.toLocaleLowerCase().includes(search))
    .sort((a, b) => {
      const order = sort === 'type' ? a.label.localeCompare(b.label) : sort === 'newest' ? (Date.parse(b.date ?? '') || 0) - (Date.parse(a.date ?? '') || 0) : 0;
      return order || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
}
