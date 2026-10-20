import { workspaceApiPath } from './workspace-scope';
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { SourceDocument } from '../../../packages/core/src/types';
import { sourceCalculationId, type SavedSourceCalculation } from '../../../packages/core/src/source-table';
import { api, message } from './api';
import { TabularResultTable, tabularDateBasis, tabularFilterBasis, tabularSelectionBasis } from './tabular-analysis';
import { useCalculationVerification } from './calculation-verification';

export function CalculatedSourceTable({ source, onSource, inSidebar = false }: { source: SourceDocument; onSource: (id: string) => void; inSidebar?: boolean }) {
  const [saved, setSaved] = useState<SavedSourceCalculation | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const openVerification = useCalculationVerification(source.id, saved?.runId, inSidebar);
  useEffect(() => {
    let live = true;
    setSaved(null); setError('');
    void api<SavedSourceCalculation>(`/api/sources/${encodeURIComponent(source.id)}/calculation`).then(value => {
      if (value.analysis?.sourceId !== source.id || value.analysis.result?.id !== sourceCalculationId(source) || value.analysis.datasetId !== value.analysis.result.datasetId || !value.runId) throw new Error('This saved calculation does not match the selected source.');
      if (live) setSaved(value);
    }).catch(cause => { if (live) setError(message(cause)); });
    return () => { live = false; };
  }, [source.id, source.path, revision]);
  if (error) return <div className="calculated-source" role="alert"><p>{error}</p><button type="button" className="text-button" onClick={() => setRevision(value => value + 1)}>Retry calculation</button></div>;
  if (!saved) return <p role="status">Loading calculated rows...</p>;
  const result = saved.analysis.result;
  return <section className="calculated-source" aria-label="Saved calculation">
    <header className="calculated-source-header"><div><p>{result.counts.includedRows.toLocaleString()} source rows included</p><p>{tabularDateBasis(result)}</p>{tabularFilterBasis(result) && <p>{tabularFilterBasis(result)}</p>}{result.selection && <p>{tabularSelectionBasis(result)}</p>}</div><a className="icon-button" href={workspaceApiPath(`/api/runs/${encodeURIComponent(saved.runId)}/tabular.csv`)} download aria-label="Download calculated rows as CSV" title="Download CSV"><Download size={16} /></a></header>
    <TabularResultTable key={result.id} result={result} onInspect={(selection, opener) => openVerification({ kind: 'tabular', analysis: saved.analysis, runId: saved.runId, selection }, opener)} />
  </section>;
}
