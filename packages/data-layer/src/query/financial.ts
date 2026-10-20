import { DataLayerError } from '../errors.ts';
import { TOOL_IDS, labelFor } from '../labels.ts';
import { buildReceipt, type EvidenceReceipt } from '../receipts.ts';
import { normalizeFinancialBatch } from '../normalize/financial.ts';
import type { FinancialArithmetic } from '../ports.ts';
import type { RawBatch, RawCoverage } from '../types.ts';
import type { FinancialAnalysis, FinancialPeriod } from '../../../core/src/financial-reporting.ts';

export interface FinancialQueryResult {
  /** Internal, namespaced. `label` is what a person sees. */
  readonly toolId: string;
  readonly label: string;
  /** The harness calculator's own analysis, passed through untouched. */
  readonly analysis: FinancialAnalysis;
  readonly snapshot: {
    readonly datasetId: string;
    readonly contentHash: string;
    readonly sourceName: string;
    readonly currency: string;
    readonly minorUnitScale: 2;
    readonly records: readonly number[];
    readonly schemaVersion: string;
    readonly warnings: readonly string[];
  };
  readonly receipt: EvidenceReceipt;
}

interface Shared {
  readonly batch: RawBatch;
  readonly arithmetic: FinancialArithmetic;
  readonly period: FinancialPeriod;
  readonly coverage?: { readonly from: string; readonly through: string; readonly complete: boolean };
  readonly now?: () => string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function checkPeriod(period: FinancialPeriod, field: string): FinancialPeriod {
  const valid = (value: unknown): value is string => typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!period || !valid(period.from) || !valid(period.through) || period.from > period.through) {
    throw new DataLayerError(`Supply ${field} as real UTC from/through dates in order.`, 'invalid_period',
      [{ code: 'invalid_period', message: `${field} needs two ISO calendar dates, from not after through.`, field }]);
  }
  return { from: period.from, through: period.through };
}

/**
 * Run the harness calculator over one batch and bind the result to that snapshot.
 * The data layer contributes the period check, the snapshot binding and the receipt; every
 * number still comes from the reviewed calculator behind `arithmetic`.
 */
function run(input: Shared, previousPeriod: FinancialPeriod | null, toolId: typeof TOOL_IDS[keyof typeof TOOL_IDS]): FinancialQueryResult {
  const now = input.now ?? (() => new Date().toISOString());
  const period = checkPeriod(input.period, 'period');
  const previous = previousPeriod === null ? null : checkPeriod(previousPeriod, 'previousPeriod');
  if (previous && previous.through >= period.from) {
    throw new DataLayerError('The previous period must finish before the current period starts.', 'invalid_period',
      [{ code: 'invalid_period', message: 'Choose a previous period that ends before the current one begins.', field: 'previousPeriod' }]);
  }
  const snapshot = normalizeFinancialBatch(input.batch, input.arithmetic);
  const computedAt = now();
  let analysis: FinancialAnalysis;
  try {
    analysis = input.arithmetic.calculate({
      dataset: snapshot.dataset,
      period,
      ...(previous ? { previousPeriod: previous } : {}),
      ...(input.coverage ? { coverage: input.coverage } : {}),
      createdAt: computedAt,
    });
  } catch (error) {
    throw new DataLayerError(error instanceof Error ? error.message : 'The financial calculation was refused.', 'calculation_refused',
      [{ code: 'calculation_refused', message: 'The supplied period or snapshot did not satisfy the calculator contract.' }]);
  }
  return {
    toolId,
    label: labelFor(toolId),
    analysis,
    snapshot: {
      datasetId: snapshot.dataset.id,
      contentHash: snapshot.dataset.contentHash,
      sourceName: snapshot.sourceName,
      currency: snapshot.dataset.currency,
      minorUnitScale: snapshot.dataset.minorUnitScale,
      records: snapshot.records,
      schemaVersion: snapshot.version,
      warnings: snapshot.warnings.map(warning => warning.message),
    },
    receipt: buildReceipt({
      batch: input.batch, toolId, label: labelFor(toolId), sourceVersion: snapshot.version,
      records: snapshot.records, computedAt,
    }),
  };
}

/** Recognized revenue, cost, gross profit and margin for one period. */
export function financialPeriodSummary(input: Shared): FinancialQueryResult {
  return run(input, null, TOOL_IDS.financialSummary);
}

/**
 * The same deterministic calculation across two periods, so margin and revenue changes are
 * reported from fixed code. The comparison is only as complete as the coverage the uploader
 * declared; the calculator carries that status forward on the analysis.
 */
export function financialMarginChanges(input: Shared & { readonly previousPeriod: FinancialPeriod }): FinancialQueryResult {
  return run(input, input.previousPeriod, TOOL_IDS.financialMargins);
}

/** Coverage declarations are caller-supplied; rows never prove completeness. */
export type FinancialCoverageDeclaration = { readonly from: string; readonly through: string; readonly complete: boolean };

export function coverageStatus(analysis: FinancialAnalysis): RawCoverage {
  return analysis.coverageDeclaration === null ? 'unknown' : analysis.coverageDeclaration.complete ? 'complete' : 'partial';
}
