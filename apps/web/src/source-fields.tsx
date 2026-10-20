import type { SourceTablePage } from '../../../packages/core/src/source-table';

/** Examples remain original strings: no inferred types, invented definitions or blank-to-zero conversion. */
export function SourceFields({ page }: { page: SourceTablePage }) {
  return <div className="source-fields">
    <div className="source-section-heading"><h2>Fields</h2><span>{page.headers.length} columns</span></div>
    <div className="source-fields-scroll" role="region" aria-label="Source fields" tabIndex={0}>
      <table><caption className="sr-only">Original field names and example values from the loaded rows</caption>
        <thead><tr><th scope="col">Column</th><th scope="col">Example from preview</th><th scope="col">Shown in</th></tr></thead>
        <tbody>{page.headers.map((header, index) => {
          const value = page.rows.find(row => row.cells[index] !== undefined && row.cells[index] !== '')?.cells[index];
          return <tr key={index}><th scope="row">{header || '(unnamed column)'}</th>
            <td>{value === undefined ? <span className="muted">No value in this preview</span> : <span className="source-field-example">{value}</span>}</td>
            <td>{!page.primaryColumns?.length || page.primaryColumns.includes(header) ? 'Key column' : 'All columns'}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </div>;
}
