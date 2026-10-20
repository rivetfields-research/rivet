import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Search, X } from 'lucide-react';
import type { SourceDocument } from '../../../packages/core/src/types';
import type { SourceTablePage } from '../../../packages/core/src/source-table';
import { sourceTableKind } from '../../../packages/core/src/source-table';
import { api, message } from './api';
import { Markdown } from './markdown';
import { SourceFields } from './source-fields';
import { SourceOverview, SOURCE_PREVIEW_ROWS } from './source-overview';
export type SourceSection = 'overview' | 'preview' | 'fields';

export function CsvRows({ page, allColumns = false }: { page: SourceTablePage; allColumns?: boolean }) {
  const columns = page.headers.map((header, index) => ({header,index})).filter(({header}) => allColumns || !page.primaryColumns?.length || page.primaryColumns.includes(header));
  return <div className="source-csv-scroll" tabIndex={0} role="region" aria-label="CSV rows">
    <table className="source-csv-table"><caption className="sr-only">{page.sourceName}, original CSV values</caption>
      <thead><tr><th scope="col">CSV row</th>{columns.map(({header,index}) => <th scope="col" key={index}>{header}</th>)}</tr></thead>
      <tbody>{page.rows.map(row => <tr key={row.record}><th scope="row">{row.record}</th>{columns.map(({index}) => <td key={index}><span className="source-csv-cell">{row.cells[index] === '' ? <span className="muted" aria-label="Empty cell">(empty)</span> : row.cells[index]}</span></td>)}</tr>)}</tbody>
    </table>
    {!page.rows.length && <p className="empty-note">No matching rows.</p>}
  </div>;
}

export function SourceCsvTable({ source, onSource, section = 'preview', onPreview }: { source: SourceDocument; onSource: (id: string) => void; section?: SourceSection; onPreview?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [allColumns, setAllColumns] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<SourceTablePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const overview = section === 'overview' && !expanded;
  // Overview always describes the first unfiltered rows, not a search or later preview page.
  const rowQuery = overview ? '' : query;
  const rowOffset = overview ? 0 : offset;
  useEffect(() => { if (expanded && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [expanded]);
  function closeExpanded() {
    setExpanded(false);
    requestAnimationFrame(() => opener.current?.focus());
  }
  function viewAllRows() {
    setQuery(''); setOffset(0);
    onPreview?.();
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setPage(null);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({offset:String(rowOffset),q:rowQuery});
      void api<SourceTablePage>(`/api/sources/${encodeURIComponent(source.id)}/table?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
        .then(value => { if (!controller.signal.aborted) setPage(value); })
        .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, rowQuery ? 200 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [source.id, rowQuery, rowOffset, revision]);
  const fields = section === 'fields' && !expanded;
  const content = <div className="source-csv">
    {!fields && !overview && <div className="source-csv-toolbar">
      <p>{page ? `${page.totalRows.toLocaleString()} ${page.totalRows === 1 ? 'row' : 'rows'} · ${page.headers.length} ${page.headers.length === 1 ? 'column' : 'columns'}` : 'Saved CSV'}</p>
      <label className="search-field"><Search size={14} /><input aria-label="Search CSV rows" placeholder="Search rows" maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }} /></label>
      {!expanded && <button type="button" className="icon-button" ref={opener} title="Expand CSV table" aria-label="Expand CSV table" onClick={() => setExpanded(true)}><Maximize2 size={16} /></button>}
    </div>}
    {!fields && !overview && page?.primaryColumns?.length && page.primaryColumns.length < page.headers.length ? <div className="source-csv-columns" role="group" aria-label="Visible columns">
      <label><input type="radio" name={`columns-${source.id}`} checked={!allColumns} onChange={() => setAllColumns(false)} />Key columns</label>
      <label><input type="radio" name={`columns-${source.id}`} checked={allColumns} onChange={() => setAllColumns(true)} />All columns</label>
    </div> : null}
    {loading ? <p role="status">Loading rows...</p> : error ? <div className="module-alert" role="alert"><p>We couldn't load the rows. Try again, or reopen the source.</p><button type="button" className="text-button" onClick={() => setRevision(value => value + 1)}>Try again</button><details><summary>Error details</summary><p>{error}</p></details></div> : page && (overview ? <SourceOverview source={source} page={page} onPreview={onPreview ? viewAllRows : undefined}><CsvRows page={{...page,rows:page.rows.slice(0,SOURCE_PREVIEW_ROWS)}}/></SourceOverview> : fields ? <SourceFields page={page}/> : <>
      <CsvRows page={page} allColumns={allColumns} />
      <div className="source-csv-pagination">
        <span>{page.matchedRows ? `${rowOffset + 1}-${Math.min(rowOffset + page.rows.length, page.matchedRows)} of ${page.matchedRows.toLocaleString()}${rowQuery ? ' matching rows' : ''}` : '0 rows'}</span>
        <button type="button" className="icon-button" title="Previous rows" aria-label="Previous rows" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}><ChevronLeft size={16} /></button>
        <button type="button" className="icon-button" title="Next rows" aria-label="Next rows" disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}><ChevronRight size={16} /></button>
      </div>
    </>)}
    <details className="source-csv-metadata"><summary>{sourceTableKind(source) === 'csv' ? 'Original text' : 'Import details'}</summary><p className="source-path">{source.path}</p>{sourceTableKind(source) === 'csv' ? <pre>{source.content}</pre> : <div className="markdown"><Markdown content={source.content} onSource={onSource} /></div>}</details>
  </div>;
  return expanded ? <dialog ref={dialog} className="csv-inspector-dialog" aria-label="Expanded CSV table" onClose={closeExpanded} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeExpanded(); }
  }} onClick={event => {
    if (event.target === event.currentTarget) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeExpanded();
    }
  }}><header><h2>{page?.sourceName ?? source.title.replace(/^Social CSV · /, '')}</h2><button type="button" className="icon-button" aria-label="Close expanded CSV table" title="Close expanded CSV table" onClick={closeExpanded}><X size={18} /></button></header>{content}</dialog> : content;
}
