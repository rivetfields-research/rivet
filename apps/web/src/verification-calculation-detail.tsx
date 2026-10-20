import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { AnalysisResult, MetricEvidence, NormalizedDataset } from '../../../packages/data-layer/src/tabular/types';
import { expandMetricEvidence } from '../../../packages/data-layer/src/tabular/evidence';
import { numericColumns, labelFor, tabularValue, tabularGroupLabel, tabularDateBasis, tabularFilterBasis, type Selection } from '../../../packages/presentation/src/tabular-chart';
import { columns } from '../../../packages/presentation/src/source-chart';
import type { CalculationInspection } from './calculation-verification';
import { TabularEvidenceRows } from './tabular-evidence-rows';
import { api, message } from './api';

export function tabularMetricEvidence(result: AnalysisResult, selection: Selection) {
  return expandMetricEvidence(result, selection.group === null ? result.evidence.totals[selection.metric] : result.evidence.groups.find(group => group.group === selection.group)?.metrics[selection.metric]);
}

export async function loadTabularEvidenceDataset(result: AnalysisResult, signal: AbortSignal) {
  const saved = await api<{ dataset: NormalizedDataset }>(`/api/datasets/tabular/${encodeURIComponent(result.datasetId)}`, { signal });
  signal.throwIfAborted();
  if (saved.dataset?.id !== result.datasetId || saved.dataset.hash !== result.datasetHash || saved.dataset.sourceHash !== result.sourceHash || !Array.isArray(saved.dataset.rows) || !Array.isArray(saved.dataset.headers)) throw new Error('The saved source does not match this calculation.');
  return saved.dataset;
}

function SupportingRows({ result, selection }: { result: AnalysisResult; selection: Selection }) {
  const evidence = tabularMetricEvidence(result, selection);
  return evidence ? <LoadSupportingRows key={JSON.stringify([result.id, result.datasetId, result.datasetHash, result.sourceHash, selection])} result={result} selection={selection} evidence={evidence}/> : <p>No source rows were recorded for this value.</p>;
}

function LoadSupportingRows({ result, selection, evidence }: { result: AnalysisResult; selection: Selection; evidence: MetricEvidence }) {
  const [dataset, setDataset] = useState<NormalizedDataset>(), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDataset(undefined); setError('');
    void loadTabularEvidenceDataset(result, controller.signal).then(saved => {
      if (!controller.signal.aborted) setDataset(saved);
    }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [result.datasetId, result.datasetHash, result.sourceHash, retry]);
  if (error) return <div role="alert"><p>{error}</p><button className="text-button" onClick={() => setRetry(value => value + 1)}>Retry source rows</button></div>;
  if (!dataset) return <p role="status">Loading original source rows...</p>;
  return <TabularEvidenceRows dataset={dataset} evidence={evidence} requiredFields={result.definitions.find(item => item.id === selection.metric)?.requiredFields ?? []}/>;
}

export function CalculationSourceRows({ inspection }: { inspection: Extract<CalculationInspection, { kind: 'tabular' }> }) {
  const { result } = inspection.analysis, { selection } = inspection;
  const definition = result.definitions.find(item => item.id === selection.metric);
  const group = selection.group === null ? (result.selection ? 'Full cohort total · All included rows' : 'All included rows') : tabularGroupLabel(result, selection.group).label;
  const value = selection.group === null ? result.totals[selection.metric] : result.rows.find(row => row.group === selection.group)?.[selection.metric];
  return <div className="verification-calculation">
    <h3>{labelFor(result, selection.metric)}</h3><p>{group}</p>
    <p className="verification-saved-value">{tabularValue(value, definition?.unit)}<small>Saved value</small></p>
    {!result.counts.includedRows ? <p>No source rows matched these dates and filters. This is not a measured zero.</p> : value == null && <p>Missing or undefined, not zero.</p>}
    <p>{tabularDateBasis(result)}</p>{tabularFilterBasis(result) && <p>{tabularFilterBasis(result)}</p>}
    {inspection.sharedSnapshot ? <p>Original source rows require separate access.</p> : <SupportingRows result={result} selection={selection}/>}
  </div>;
}

function TabularDetails({ inspection, onSource }: { inspection: Extract<CalculationInspection, { kind: 'tabular' }>; onSource: (id: string) => void }) {
  const result = inspection.analysis.result;
  const [selection, setSelection] = useState(inspection.selection), [rowsOpen, setRowsOpen] = useState(false);
  useEffect(() => { setSelection(inspection.selection); setRowsOpen(false); }, [inspection]);
  const evidence = tabularMetricEvidence(result, selection), definition = result.definitions.find(item => item.id === selection.metric);
  const group = selection.group === null ? 'All included groups' : tabularGroupLabel(result, selection.group).label;
  const value = selection.group === null ? result.totals[selection.metric] : result.rows.find(row => row.group === selection.group)?.[selection.metric];
  return <div className="verification-calculation">
    <h3>{labelFor(result, selection.metric)}</h3><p>{group}</p>
    <p className="verification-saved-value">{tabularValue(value, definition?.unit)}<small>Saved value</small></p>
    {numericColumns(result).length > 1 && <label className="verification-metric">Metric<select value={selection.metric} onChange={event => { setSelection({ ...selection, metric: event.target.value as Selection['metric'] }); setRowsOpen(false); }}>{numericColumns(result).map(column => <option key={column.id} value={column.id}>{column.label}</option>)}</select></label>}
    <details className="verification-disclosure"><summary>Calculation details</summary>
      <h4>How it was calculated</h4><p>{evidence?.formula ?? definition?.formula ?? 'No formula recorded.'}</p>
      <h4>Dates and filters</h4><p>{tabularDateBasis(result)}</p>{tabularFilterBasis(result) && <p>{tabularFilterBasis(result)}</p>}<p>{result.timeBasis.description}</p>
      <h4>Included and excluded</h4><p>{evidence ? `${evidence.eligible.length} usable rows; ${evidence.missing.length} missing inputs; ${evidence.excluded.length} excluded.` : 'Input coverage was not recorded.'}</p>
      <p>{result.counts.excludedByDate} outside the requested dates; {result.counts.excludedUndated} without a publication date; {result.counts.excludedByContentType ?? 0} excluded by content type.</p>
      {result.warnings.some(warning => warning.message !== result.timeBasis.description) && <><h4>Limitations</h4><ul>{[...new Set(result.warnings.map(warning => warning.message))].filter(text => text !== result.timeBasis.description).map(text => <li key={text}>{text}</li>)}</ul></>}
      <details className="verification-technical"><summary>Technical details</summary><p>CSV row numbers include the header as row 1. Line numbers identify where a quoted record begins. Blank cells are original blanks.</p><dl><dt>Dataset</dt><dd>{result.datasetId}</dd><dt>Dataset hash</dt><dd>{result.datasetHash}</dd><dt>Source hash</dt><dd>{result.sourceHash}</dd><dt>Calculation</dt><dd>{result.id}</dd></dl></details>
    </details>
    <details className="verification-disclosure" open={rowsOpen} onToggle={event => setRowsOpen(event.currentTarget.open)}><summary>Supporting records</summary>
      {rowsOpen && (inspection.sharedSnapshot ? <p>Original source rows require separate access.</p> : <SupportingRows key={`${selection.metric}:${selection.group}`} result={result} selection={selection}/>)}
    </details>
    {!inspection.sharedSnapshot && <button className="text-button" data-source-id={inspection.analysis.sourceId} onClick={() => onSource(inspection.analysis.sourceId)}>Open saved calculation source <ArrowUpRight size={13}/></button>}
  </div>;
}

function SourceDetails({ inspection, onSource }: { inspection: Extract<CalculationInspection, { kind: 'source' }>; onSource: (id: string) => void }) {
  const result = inspection.analysis.result, row = inspection.row;
  const metrics = result.metric ? [result.metric] : result.metrics;
  return <div className="verification-calculation">
    <h3>{row?.label ?? (result.operation === 'review' ? result.metric.label : 'Saved source calculation')}</h3>
    {!row && result.operation === 'review' && <p className="verification-saved-value">{tabularValue(result.totals.value, result.metric.unit)}<small>Saved value</small></p>}
    {row && <p>{columns(result).map((name, index) => `${name}: ${tabularValue(row.values[index])}`).join(' · ')}</p>}
    <details className="verification-disclosure"><summary>Calculation details</summary>
      {metrics.map(metric => <p key={metric.id}><strong>{metric.label}</strong> · {metric.unit}<br/>{metric.basis === 'lifetime' ? 'Lifetime counter at collection, not activity earned within the selected dates.' : 'Provider reporting period.'}</p>)}
      {result.operation === 'review' && <><p>{result.counts.includedRecords} included records. {result.counts.excludedByDate} outside dates; {result.counts.excludedUndated} without a usable date.</p><p>{result.request.dateRange ? `${result.request.dateRange.from} (inclusive) to ${result.request.dateRange.to} (exclusive)` : 'All dates in the saved source'} · {result.timezone ?? 'Timezone unknown'}</p></>}
      {result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      {result.observations.map(item => <p key={item.id}>{item.provider} · Collected {item.observedAt} · {item.coverage} coverage</p>)}
      <details className="verification-technical"><summary>Technical details</summary><p>Calculation: {result.id}</p><pre>{JSON.stringify(result.request, null, 2)}</pre></details>
    </details>
    <details className="verification-disclosure"><summary>Supporting records</summary>
      {row ? row.evidence.map(item => <p key={`${item.observationId}:${item.recordId}`}><strong>{item.recordId}</strong><br/>Observation: {item.observationId}<br/>Batch: {item.rawBatchId}<br/>SHA-256: {item.sourceHash}</p>) : <p>Select a value or record in the report to inspect its supporting records.</p>}
    </details>
    <button className="text-button" data-source-id={inspection.analysis.sourceId} onClick={() => onSource(inspection.analysis.sourceId)}>Open saved calculation source <ArrowUpRight size={13}/></button>
  </div>;
}

export function VerificationCalculationDetail({ inspection, onSource }: { inspection: CalculationInspection; onSource: (id: string) => void }) {
  return inspection.kind === 'tabular' ? <TabularDetails inspection={inspection} onSource={onSource}/> : <SourceDetails inspection={inspection} onSource={onSource}/>;
}
