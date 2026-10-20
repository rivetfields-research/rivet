import { createContext, useContext, useEffect, useId } from 'react';
import type { Run } from '../../../packages/core/src/types';
import type { TabularAnalysis } from '../../../packages/core/src/tabular-datasets';
import type { SourceAnalysis } from '../../../packages/core/src/source-analysis';
import type { Selection } from '../../../packages/presentation/src/tabular-chart';
import type { DisplayRow } from '../../../packages/presentation/src/source-chart';
import { savedReportAnalysis } from '../../../packages/core/src/saved-report';

export type CalculationInspection = { runId?: string; ownerId?: string } & (
  | { kind: 'tabular'; analysis: TabularAnalysis; selection: Selection; sharedSnapshot?: boolean; view?: 'rows' | 'calculation' }
  | { kind: 'source'; analysis: SourceAnalysis; row?: DisplayRow }
);

export const CalculationVerificationContext = createContext<(inspection: CalculationInspection, opener?: HTMLElement) => void>(() => {});
export const DismissCalculationVerificationContext = createContext<(ownerId: string) => void>(() => {});

export function useCalculationVerification(analysisId: string, runId?: string, retainOnUnmount = false) {
  const open = useContext(CalculationVerificationContext), dismiss = useContext(DismissCalculationVerificationContext);
  const ownerId = useId();
  useEffect(() => retainOnUnmount ? undefined : () => dismiss(ownerId), [analysisId, runId, ownerId, dismiss, retainOnUnmount]);
  return (inspection: CalculationInspection, opener?: HTMLElement) => open({ ...inspection, ownerId: retainOnUnmount ? undefined : ownerId }, opener);
}

export function runCalculationInspection(run: Run): CalculationInspection | undefined {
  const analysis = savedReportAnalysis(run);
  if (analysis?.kind === 'source') return { kind: 'source', analysis, runId: run.id };
  const metric = analysis?.result.definitions[0]?.id;
  if (analysis?.kind === 'tabular' && metric) return { kind: 'tabular', analysis, runId: run.id, selection: { group: null, metric }, view: 'calculation' };
}
