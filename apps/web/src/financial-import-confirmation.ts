import type { FinancialDatasetSummary, StoredFinancialDataset } from '../../../packages/core/src/index';

type Period = Readonly<{ from: string; through: string }>;
export type FinancialImportPayload = Readonly<{ csv: string; sourceName: string; period: Period; coverage?: Period & { complete: boolean } }>;

export function hasFinancialSummary(value: unknown): value is FinancialDatasetSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<FinancialDatasetSummary>;
  return typeof item.id === 'string' && /^financial_version_[a-f0-9]{64}$/.test(item.id)
    && typeof item.contentHash === 'string' && /^[a-f0-9]{64}$/.test(item.contentHash)
    && typeof item.sourceName === 'string' && Number.isSafeInteger(item.rowCount) && Number(item.rowCount) > 0
    && ['USD', 'EUR', 'GBP'].includes(item.currency ?? '')
    && Array.isArray(item.warnings) && item.warnings.every(warning => warning && typeof warning.message === 'string')
    && typeof item.period?.from === 'string' && typeof item.period.through === 'string'
    && typeof item.source?.id === 'string' && typeof item.source.title === 'string' && typeof item.source.content === 'string';
}

function sameCoverage(actual: FinancialDatasetSummary['coverage'], expected: FinancialDatasetSummary['coverage']): boolean {
  if (actual === undefined || expected === undefined) return actual === expected;
  return Boolean(actual && expected && typeof actual.complete === 'boolean'
    && actual.from === expected.from && actual.through === expected.through && actual.complete === expected.complete);
}

/** The server reuses a version by its exact CSV, period and coverage, preserving its original file label. */
export function confirmsFinancialImport(payload: FinancialImportPayload, summary: FinancialDatasetSummary, value: unknown): boolean {
  if (!hasFinancialSummary(value)) return false;
  const readback = value as Partial<StoredFinancialDataset>;
  return value.id === summary.id && value.contentHash === summary.contentHash
    && value.sourceName === summary.sourceName
    && value.schemaVersion === summary.schemaVersion && value.calculatorVersion === summary.calculatorVersion
    && value.bytes === summary.bytes && value.rowCount === summary.rowCount && value.currency === summary.currency
    && value.source.id === summary.source.id && value.source.title === summary.source.title && value.source.content === summary.source.content
    && value.period.from === summary.period.from && value.period.through === summary.period.through
    && value.period.from === payload.period.from && value.period.through === payload.period.through
    && readback.csv === payload.csv
    && sameCoverage(value.coverage, summary.coverage) && sameCoverage(value.coverage, payload.coverage);
}
