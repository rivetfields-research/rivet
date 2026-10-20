import { parseCsv } from '../../../packages/data-layer/src/csv.ts';
import { HarnessError } from '../../../packages/core/src/errors.ts';
import { sourceDatasetId, sourceTableKind, type SourceTablePage } from '../../../packages/core/src/source-table.ts';
import type { SourceDocument } from '../../../packages/core/src/types.ts';
import type { StoredTabularDataset } from '../../../packages/core/src/tabular-datasets.ts';
import type { StoredUsageDataset, StoredFinancialDataset } from '../../../packages/core/src/index.ts';

export function sourceTablePage(source: SourceDocument, dataset: StoredTabularDataset | StoredUsageDataset | StoredFinancialDataset | undefined, query: URLSearchParams): SourceTablePage {
  const rawCsv = sourceTableKind(source) === 'csv';
  if (!rawCsv && (!dataset || dataset.id !== sourceDatasetId(source) || dataset.source.id !== source.id)) throw new HarnessError('No saved CSV rows are available for this source.',404,'source_table_not_found');
  if ([...query.keys()].some(key => !['offset','q'].includes(key)) || query.getAll('offset').length > 1 || query.getAll('q').length > 1 ||
      (query.has('offset') && !/^\d{1,5}$/.test(query.get('offset')!)) || (query.get('q')?.length ?? 0) > 200) {
    throw new HarnessError('Use a row offset and a search of at most 200 characters.',400,'invalid_table_page');
  }
  const offset = Number(query.get('offset') ?? 0);
  const search = (query.get('q') ?? '').toLocaleLowerCase('en-US');
  let parsed: ReturnType<typeof parseCsv>;
  try { parsed = parseCsv(rawCsv ? source.content : dataset!.csv); }
  catch { throw new HarnessError('This source is not a supported comma-delimited CSV. Open its original text to inspect the formatting.',422,'source_table_invalid'); }
  const matches = parsed.rows.map((cells, index) => ({ record:index + 2,cells }))
    .filter(row => !search || row.cells.some(cell => cell.toLocaleLowerCase('en-US').includes(search)));
  const mapping = !rawCsv && dataset && 'mapping' in dataset ? dataset.mapping : undefined;
  const native = mapping?.kind === 'source-table';
  const primaryColumns = mapping && !native ? Object.values(mapping.columns).filter((value): value is string => typeof value === 'string') : [];
  // Native content is useful evidence even when it is not a calculable metric.
  const metricSource = dataset && 'metricSource' in dataset ? dataset.metricSource : undefined;
  if (metricSource) {
    const contentColumns = metricSource.provider === 'youtube' ? ['Title', 'Video URL', 'Views'] : ['Post text', 'Post URL'];
    primaryColumns.push(...contentColumns.filter(column => parsed.headers.includes(column) && !primaryColumns.includes(column)));
  }
  return {sourceName:rawCsv ? source.title : dataset!.sourceName,...(native ? {dataKind:'source-table' as const} : {}),headers:parsed.headers,primaryColumns,rows:matches.slice(offset,offset + 25),totalRows:parsed.rows.length,matchedRows:matches.length,offset,nextOffset:offset + 25 < matches.length ? offset + 25 : null};
}
