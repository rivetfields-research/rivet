import { FINANCIAL_CALCULATOR_VERSION, calculateFinancialAnalysis, importFinancialCsv } from '../../../core/src/financial-reporting.ts';
import type { FinancialArithmetic } from '../ports.ts';

/**
 * The single boundary between this package and the harness's reviewed financial calculator.
 * If `packages/core` ever depends on `packages/data-layer`, this file moves to the core side
 * unchanged: it only implements a port this package defines.
 */
export const coreFinancialArithmetic: FinancialArithmetic = {
  version: FINANCIAL_CALCULATOR_VERSION,
  importCsv: (payload, sourceName) => importFinancialCsv(payload, sourceName),
  calculate: input => calculateFinancialAnalysis(input),
};
