import type { Run } from './types.ts';

export function savedReportAnalysis(run: Run) {
  const answer = run.result ?? run.reply;
  // A completed answer owns its calculation; an earlier checkpoint is not a substitute.
  return answer ? answer.tabularAnalysis ?? answer.sourceAnalysis
    : run.savedCalculation?.analysis ?? run.savedSourceAnalysis;
}
