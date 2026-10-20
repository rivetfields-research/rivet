import type { MouseEventHandler, ReactNode } from 'react';
import { numericColumns, tabularGroupLabel, tabularValue, valueOf, type PresentedResult, type Selection } from '../../../packages/presentation/src/tabular-chart';
import { sourceChartRows, type Result, type DisplayRow } from '../../../packages/presentation/src/source-chart';

function EvidenceNumber({ children, label, onClick, sourceId }: { children: ReactNode; label: string; onClick: MouseEventHandler<HTMLButtonElement>; sourceId?: string }) {
  return <button type="button" className="report-evidence-number" aria-label={label} data-source-id={sourceId} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onClick(event); }}>{children}</button>;
}

/** Every linked number belongs to the immutable result, never to generated prose. */
export function TabularTakeaways({ result, onInspect }: { result: PresentedResult; onInspect: (selection: Selection, opener: HTMLButtonElement) => void }) {
  const columns = numericColumns(result), primary = columns.find(column => column.id === result.request.sort?.metric) ?? columns[0];
  if (!result.counts.includedRows) return <ul><li><strong>No records matched.</strong> No source rows matched these dates and filters. This is not a measured zero.</li></ul>;
  if (!primary) return <ul><li><strong>No numeric result is available.</strong> Review the saved source and calculation details.</li></ul>;
  const known = result.rows.filter(row => valueOf(row, primary.id) !== null);
  const max = known.length ? Math.max(...known.map(row => valueOf(row, primary.id)!)) : null;
  const leaders = known.filter(row => valueOf(row, primary.id) === max);
  const coverage = result.metricCoverage[primary.id];
  const missing = (coverage?.missingRows ?? 0) + (coverage?.zeroDenominatorRows ?? 0);
  const definition = result.definitions.find(item => item.id === primary.id);
  const secondary = columns.find(column => column.id !== primary.id && Number.isFinite(result.totals[column.id]));
  const number = (value: number, group: string | null, column = primary) => <EvidenceNumber label={`Show source rows for takeaway ${column.label} ${group === null ? 'total' : `for ${tabularGroupLabel(result, group).label}`}`} onClick={event => onInspect({ group, metric: column.id }, event.currentTarget)}>{tabularValue(value, column.unit)}</EvidenceNumber>;
  const total = result.totals[primary.id];
  return <ul>
    <li><strong>{primary.label}{primary.unit === 'percent' ? ' overall' : ' in this review'}.</strong>{' '}
      {typeof total === 'number' && Number.isFinite(total) ? <>{number(total, null)}{primary.unit === 'percent' ? '' : ` recorded ${primary.label.toLowerCase()}`} across {coverage?.eligibleRows ?? result.counts.includedRows} source rows with the required inputs.</> : <>The available inputs do not support a {primary.label.toLowerCase()} total. Missing values are unknown, not zero.</>}
      {definition?.aggregation === 'ratio_of_sums' && <> This is a ratio of totals, not an average of post rates.</>}
      {secondary && <> The same review records {number(result.totals[secondary.id]!, null, secondary)} {secondary.label.toLowerCase()}{secondary.unit === 'percent' ? ' overall' : ''}, using that metric's available inputs.</>}
    </li>
    {known.length > 1 && max !== null && <li>
      {leaders.length === 1 ? <><strong>{tabularGroupLabel(result, leaders[0].group).label} leads on recorded {primary.label.toLowerCase()}.</strong>{' '}{number(max, leaders[0].group)}, the highest among {known.length} shown groups with a value.</>
        : <><strong>{leaders.length === known.length ? 'The shown values are equal.' : `${leaders.length} shown groups tie for the highest value.`}</strong>{' '}Each has {number(max, leaders[0].group)} {primary.label.toLowerCase()}; there is no single leader.</>}
    </li>}
    <li><strong>Keep the scope in mind.</strong>{' '}
      {missing > 0 && <>{missing} included source {missing === 1 ? 'row could' : 'rows could'} not contribute to {primary.label.toLowerCase()}; missing inputs are not zero. </>}
      {result.selection?.omittedGroups ? <>Totals include groups outside this selection. </> : null}
      {definition?.unit === 'count' && definition.aggregation === 'sum' ? <>These counts {result.timeBasis.metricObservation === 'api_lifetime_counts' ? 'are' : 'may be'} lifetime values, not activity earned within the selected dates.</> : <>The result covers the saved dates and filters, not a comparison with an earlier period.</>}
    </li>
  </ul>;
}

export function SourceTakeaways({ result, sourceId, onTotal, onRecord }: { result: Extract<Result, { operation: 'review' }>; sourceId: string; onTotal: () => void; onRecord: (row: DisplayRow) => void }) {
  if (!result.counts.includedRecords) return <ul><li><strong>No records matched.</strong> This is not a measured zero.</li></ul>;
  const { totals, metric } = result, rows = sourceChartRows(result).filter(row => row.values[0] !== null);
  const label = metric.label.charAt(0).toUpperCase() + metric.label.slice(1);
  const max = rows.length ? Math.max(...rows.map(row => row.values[0]!)) : null;
  const leaders = rows.filter(row => row.values[0] === max);
  return <ul>
    <li><strong>{label} in this review.</strong>{' '}
      {totals.nonAdditive ? <>These values cannot be added without double-counting. Inspect individual groups instead.</>
        : totals.knownSum === null ? <>No known value is available; missing values are not zero.</>
        : <><EvidenceNumber label={`Inspect takeaway ${metric.label} total`} sourceId={sourceId} onClick={onTotal}>{tabularValue(totals.value ?? totals.knownSum)}</EvidenceNumber>{' '}{metric.label.toLowerCase()}{totals.value === null ? ' as a known subtotal, not a complete total' : ' recorded'} across {totals.records} included {totals.records === 1 ? 'record' : 'records'}.</>}
    </li>
    {rows.length > 1 && max !== null && <li><strong>{leaders.length === 1 ? `${leaders[0].label} has the highest complete value among the shown groups.` : 'The highest complete value is shared.'}</strong>{' '}
      <EvidenceNumber label={`Inspect takeaway ${metric.label} for ${leaders[0].label}`} onClick={() => onRecord(leaders[0])}>{tabularValue(max)}</EvidenceNumber>{' '}{metric.label.toLowerCase()}{leaders.length > 1 ? ` in each of ${leaders.length} tied groups` : ''}. Groups with incomplete values are not ranked here.
    </li>}
    <li><strong>{totals.missingRecords ? 'Some data is missing.' : 'Keep the scope in mind.'}</strong>{' '}
      {totals.missingRecords > 0 && <>{totals.missingRecords} {totals.missingRecords === 1 ? 'record lacks' : 'records lack'} this metric. </>}
      {metric.basis === 'lifetime' ? 'These are lifetime counts, not activity earned within the selected publication dates.' : 'These values cover provider reporting periods, not lifetime activity.'}
      {result.observations.some(item => item.coverage !== 'complete' || item.capped) && <> Source coverage is incomplete.</>}
      {result.counts.returnedGroups < result.counts.totalGroups && <> Totals also include groups not shown.</>}
    </li>
  </ul>;
}
