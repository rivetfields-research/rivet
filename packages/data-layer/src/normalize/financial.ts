import { DataLayerError, type DataDiagnostic } from '../errors.ts';
import type { FinancialArithmetic } from '../ports.ts';
import type { RawBatch } from '../types.ts';
import type { FinancialDataset, FinancialDiagnostic } from '../../../core/src/financial-reporting.ts';

export interface NormalizedFinancialSnapshot {
  readonly dataset: FinancialDataset;
  /** The input contract the snapshot satisfies, recorded on every evidence receipt. */
  readonly version: string;
  readonly sourceName: string;
  readonly bytes: number;
  /** Source CSV record numbers, so a receipt can name exactly what was read. */
  readonly records: readonly number[];
  readonly warnings: readonly FinancialDiagnostic[];
}

const toDiagnostic = (diagnostic: FinancialDiagnostic): DataDiagnostic => ({
  code: diagnostic.code,
  message: diagnostic.message,
  ...(diagnostic.column ? { field: diagnostic.column } : {}),
  ...(diagnostic.record ? { record: diagnostic.record } : {}),
});

/**
 * Normalize a raw batch into the recognized financial input contract.
 *
 * The arithmetic — decimal parsing, integer minor units, currency rules, period maths — belongs
 * to the harness calculator supplied through `FinancialArithmetic`. This function only proves the
 * batch really is that contract, binds the result to the immutable snapshot, and refuses an
 * unrecognized shape with actionable diagnostics instead of guessing at columns.
 */
export function normalizeFinancialBatch(batch: RawBatch, arithmetic: FinancialArithmetic): NormalizedFinancialSnapshot {
  if (batch.manifest.format !== 'csv') {
    throw new DataLayerError('A financial batch must be the recognized comma-delimited contract; this batch is not CSV.', 'unsupported_format',
      [{ code: 'unsupported_format', message: 'Supply the financial CSV through the CSV source adapter.' }]);
  }
  if (batch.payloadEncoding !== 'original') {
    throw new DataLayerError('A financial batch must carry the provider bytes; a re-serialized payload cannot be verified against the contract.', 'unsupported_encoding',
      [{ code: 'unsupported_encoding', message: 'Import the financial CSV as text so its exact bytes are stored.' }]);
  }
  const sourceName = batch.provenance.locator ?? 'financial.csv';
  const outcome = arithmetic.importCsv(batch.payload, sourceName);
  if (!outcome.ok) {
    const diagnostics = outcome.errors.map(toDiagnostic);
    throw new DataLayerError(
      diagnostics[0]?.message ?? 'The upload does not satisfy the financial input contract.',
      'invalid_financial_schema',
      diagnostics.slice(0, 20),
    );
  }
  // The calculator hashes the bytes it was given. If that differs from the stored snapshot, the
  // normalized numbers would not describe this batch, so the result is refused rather than bound.
  if (outcome.dataset.contentHash !== batch.contentHash) {
    throw new DataLayerError('The normalized snapshot does not match the stored batch bytes.', 'source_version_mismatch',
      [{ code: 'source_version_mismatch', message: 'Re-import the source; the stored payload and the parsed dataset disagree.' }]);
  }
  return {
    dataset: outcome.dataset,
    version: outcome.dataset.schemaVersion,
    sourceName: outcome.dataset.sourceName,
    bytes: outcome.dataset.bytes,
    records: outcome.dataset.rows.map(row => row.record),
    warnings: outcome.warnings,
  };
}
