import { useId, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Search } from 'lucide-react';
import type { CountMetric, MetricEvidence, NormalizedDataset, RowReference } from '../../../packages/data-layer/src/tabular/types';
import { postPresentation } from '../../../packages/data-layer/src/tabular/post-presentation';

const PAGE_SIZE = 25;
const STATUSES = { included: 'Included', missing: 'Missing input', excluded: 'Excluded' } as const;
type RowStatus = keyof typeof STATUSES;
type StatusFilter = 'all' | RowStatus;

export function tabularEvidencePage(evidence: MetricEvidence, dataset: NormalizedDataset, query = '', status: StatusFilter = 'all', page = 0) {
  const originals = new Map(dataset.rows.map(row => [row.provenance.rowId, row]));
  const entries = (Object.keys(STATUSES) as RowStatus[]).flatMap(kind => {
    const references: readonly RowReference[] = kind === 'included' ? evidence.eligible : evidence[kind];
    return references.map(reference => {
      const original = originals.get(reference.rowId);
      const row = original && original.provenance.sourceHash === reference.sourceHash && original.provenance.record === reference.record && original.provenance.line === reference.line ? original : undefined;
      return { status: kind, reference, row };
    });
  });
  const needle = query.trim().toLocaleLowerCase();
  const matched = entries.filter(entry => (status === 'all' || status === entry.status) && (!needle ||
    [STATUSES[entry.status], String(entry.reference.record), String(entry.reference.line), ...(entry.row?.rawCells ?? ['Source row unavailable'])].some(value => value.toLocaleLowerCase().includes(needle))));
  const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, Number.isSafeInteger(page) ? page : 0), pages - 1);
  return { rows: matched.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE), matched: matched.length, total: entries.length, page: safePage, pages, offset: safePage * PAGE_SIZE };
}

export function TabularEvidenceRows({ evidence, dataset, requiredFields }: { evidence: MetricEvidence; dataset: NormalizedDataset; requiredFields: readonly CountMetric[] }) {
  const uid = useId();
  const [query, setQuery] = useState(''), [status, setStatus] = useState<StatusFilter>('all'), [page, setPage] = useState(0), [allColumns, setAllColumns] = useState(false);
  const shown = useMemo(() => tabularEvidencePage(evidence, dataset, query, status, page), [evidence, dataset, query, status, page]);
  const keyHeaders = new Set(['postId', 'publishedAt', 'account', 'contentType', ...requiredFields].map(field => dataset.mapping.columns[field as keyof typeof dataset.mapping.columns]).filter(Boolean));
  const columns = dataset.headers.map((header, index) => ({ header, index })).filter(({ header }) => allColumns || !keyHeaders.size || keyHeaders.has(header));
  const filtered = Boolean(query.trim()) || status !== 'all';
  return <section className="tabular-evidence-rows" aria-label="Source rows">
    <div className="source-csv-toolbar">
      <h3>Source rows</h3>
      <label className="search-field"><Search size={15} /><input aria-label="Search evidence rows" placeholder="Search rows" maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
      <select className="evidence-row-filter" aria-label="Filter evidence rows" value={status} onChange={event => { setStatus(event.target.value as StatusFilter); setPage(0); }}>
        <option value="all">All rows ({shown.total.toLocaleString()})</option>
        <option value="included">Included ({evidence.eligible.length.toLocaleString()})</option>
        <option value="missing">Missing input ({evidence.missing.length.toLocaleString()})</option>
        <option value="excluded">Excluded ({evidence.excluded.length.toLocaleString()})</option>
      </select>
    </div>
    {keyHeaders.size > 0 && keyHeaders.size < dataset.headers.length && <div className="source-csv-columns" role="group" aria-label="Evidence columns">
      <label><input type="radio" name={`${uid}-columns`} checked={!allColumns} onChange={() => setAllColumns(false)} />Key columns</label>
      <label><input type="radio" name={`${uid}-columns`} checked={allColumns} onChange={() => setAllColumns(true)} />All columns</label>
    </div>}
    <div className="source-csv-scroll" role="region" aria-label="Original source rows for this calculation" tabIndex={0}>
      <table className="source-csv-table evidence-source-table"><caption className="sr-only">Original CSV values for this calculation</caption>
        <thead><tr><th scope="col">CSV row</th><th scope="col">Use</th>{columns.map(({ header, index }) => <th key={index} scope="col">{!allColumns && header === dataset.mapping.columns.postId ? 'Post' : header}</th>)}</tr></thead>
        <tbody>{shown.rows.map(({ status: use, reference, row }, index) => <tr key={`${use}-${reference.rowId}-${index}`}>
          <th scope="row">{reference.record}<small>Line {reference.line}</small></th>
          <td><span className={`evidence-row-status is-${use}`}>{STATUSES[use]}</span></td>
          {columns.map(({ index: column, header }) => {
            const post = row && !allColumns && header === dataset.mapping.columns.postId ? postPresentation(dataset, row) : undefined;
            return <td key={column}>{post ? <div className="tabular-evidence-post"><strong>{post.label}</strong><small>{post.context}</small>{post.url && <a className="tabular-post-link" href={post.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} />Open post</a>}</div> : <span className="source-csv-cell">{!row ? 'Source row unavailable' : row.rawCells[column] === '' ? <span className="tabular-empty-cell">Blank</span> : row.rawCells[column]}</span>}</td>;
          })}
        </tr>)}</tbody>
      </table>
      {!shown.rows.length && <p className="empty-note">{shown.total ? 'No rows match these filters.' : 'No source rows were recorded for this value.'}</p>}
    </div>
    <nav className="source-csv-pagination" aria-label="Evidence row pages">
      <span role="status">{shown.matched ? `${shown.offset + 1}-${Math.min(shown.offset + PAGE_SIZE, shown.matched)} of ${shown.matched.toLocaleString()}` : '0 rows'}{filtered ? ` · ${shown.total.toLocaleString()} total` : ''}</span>
      <button type="button" className="icon-button" aria-label="Previous evidence rows" title="Previous rows" disabled={shown.page === 0} onClick={() => setPage(shown.page - 1)}><ChevronLeft size={16} /></button>
      <span>{shown.page + 1} / {shown.pages}</span>
      <button type="button" className="icon-button" aria-label="Next evidence rows" title="Next rows" disabled={shown.page + 1 === shown.pages} onClick={() => setPage(shown.page + 1)}><ChevronRight size={16} /></button>
    </nav>
  </section>;
}
