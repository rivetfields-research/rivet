import { useEffect, useRef, useState } from 'react';
import { api, message } from './api';

export interface SavedTableSummary {
  runId: string; title: string; createdAt: string; rowCount: number; groupCount: number;
  datasetId?: string; sourceName: string; calculationSourceId?: string;
}
export interface SavedTablesPage { tables: SavedTableSummary[]; nextCursor: string | null; }
export function appendSavedTablePage(current: SavedTablesPage, received: SavedTablesPage, requestedCursor: string): SavedTablesPage {
  if (current.nextCursor !== requestedCursor) return current;
  const ids = new Set(current.tables.map(table => table.runId));
  return { tables: [...current.tables, ...received.tables.filter(table => { if (ids.has(table.runId)) return false; ids.add(table.runId); return true; })], nextCursor: received.nextCursor };
}

export function useSavedTables(enabled = true) {
  const [page, setPage] = useState<SavedTablesPage>({ tables: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [pageError, setPageError] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const fetchingMore = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const request = ++generation.current;
    const controller = new AbortController();
    fetchingMore.current = false;
    setLoading(true); setLoadingMore(false); setError(''); setPageError('');
    void api<SavedTablesPage>('/api/tables', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(result => { if (generation.current === request) setPage(result); })
      .catch(cause => { if (generation.current === request) setError(message(cause)); })
      .finally(() => { if (generation.current === request) setLoading(false); });
    return () => { generation.current++; controller.abort(); };
  }, [enabled, revision]);
  async function loadEarlier() {
    if (!enabled || !page.nextCursor || loading || fetchingMore.current) return;
    const request = generation.current, cursor = page.nextCursor;
    fetchingMore.current = true; setLoadingMore(true); setPageError('');
    try {
      const result = await api<SavedTablesPage>(`/api/tables?before=${encodeURIComponent(cursor)}`, { signal: AbortSignal.timeout(15000) });
      if (generation.current === request) setPage(current => appendSavedTablePage(current, result, cursor));
    } catch (cause) { if (generation.current === request) setPageError(message(cause)); }
    finally { if (generation.current === request) { fetchingMore.current = false; setLoadingMore(false); } }
  }
  return { page, loading, loadingMore, error, pageError, loadEarlier, refresh: () => setRevision(value => value + 1) };
}
