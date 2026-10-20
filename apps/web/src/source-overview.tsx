import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import type { SourceDocument } from '../../../packages/core/src/types';
import { sourceTableKind, type SourceTablePage } from '../../../packages/core/src/source-table';

export const SOURCE_PREVIEW_ROWS = 5;

const TABLE_LABELS = { tabular: 'Social media CSV', usage: 'Usage CSV', financial: 'Financial CSV', csv: 'CSV file' };

export function SourceOverview({ source, page, onPreview, children }: {
  source: SourceDocument; page: SourceTablePage; onPreview?: () => void; children: ReactNode;
}) {
  const kind = sourceTableKind(source);
  return <section className="source-overview" aria-label="Source overview">
    <dl className="source-overview-facts">
      <div><dt>Contents</dt><dd>{page.totalRows.toLocaleString()} {page.totalRows === 1 ? 'row' : 'rows'} · {page.headers.length} {page.headers.length === 1 ? 'column' : 'columns'}</dd></div>
      <div><dt>File type</dt><dd>{page.dataKind === 'source-table' ? 'Synced table' : kind ? TABLE_LABELS[kind] : 'Saved file'}</dd></div>
    </dl>
    <div className="source-section-heading">
      <h2>Data preview</h2>
      <span>{page.totalRows ? `First ${Math.min(page.rows.length, SOURCE_PREVIEW_ROWS)} of ${page.totalRows.toLocaleString()} ${page.totalRows === 1 ? 'row' : 'rows'}` : 'No rows'}</span>
    </div>
    {children}
    {onPreview && <button type="button" className="text-button source-preview-link" onClick={onPreview}>View all rows <ArrowRight size={14}/></button>}
  </section>;
}
