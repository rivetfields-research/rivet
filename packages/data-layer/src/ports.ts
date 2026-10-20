import type {
  FinancialAnalysis, FinancialCoverage, FinancialDataset, FinancialImportResult, FinancialPeriod,
} from '../../core/src/financial-reporting.ts';

/**
 * The data layer performs **no** financial arithmetic of its own. The harness already owns a
 * reviewed, exact-integer calculator with its own schema, coverage and evidence rules, so the
 * runtime passes it in through this port. Nothing here duplicates that math.
 */
export interface FinancialArithmetic {
  /** The calculator version being reused, recorded on the receipt. */
  readonly version: string;
  /** Strict CSV import under the recognized financial input contract. */
  importCsv(payload: string, sourceName: string): FinancialImportResult;
  calculate(input: {
    readonly dataset: FinancialDataset;
    readonly period: FinancialPeriod;
    readonly previousPeriod?: FinancialPeriod;
    readonly coverage?: FinancialCoverage;
    readonly createdAt: string;
  }): FinancialAnalysis;
}
