import { DataLayerError, type DataDiagnostic } from '../../data-layer/src/errors.ts';
import { normalizeCsv } from '../../data-layer/src/tabular/normalize.ts';
import type { CsvMapping, TabularWarning } from '../../data-layer/src/tabular/types.ts';
import { HarnessError } from './errors.ts';

export class TabularInputError extends HarnessError {
  readonly dataCode: string;
  readonly diagnostics: readonly DataDiagnostic[];
  constructor(error: DataLayerError) {
    super(error.message, 422, 'invalid_tool_arguments');
    this.dataCode = error.code;
    this.diagnostics = error.diagnostics;
  }
}

export type TabularValidation =
  | { readonly valid: true; readonly rowCount: number; readonly warnings: readonly TabularWarning[] }
  | { readonly valid: false; readonly diagnostics: readonly DataDiagnostic[] };

/** Runs the exact import rules without writing a dataset, receipt or source. */
export function validateTabularInput(csv: string, mapping: CsvMapping): TabularValidation {
  try {
    const dataset = normalizeCsv(csv, mapping);
    return { valid: true, rowCount: dataset.rows.length, warnings: dataset.warnings };
  } catch (error) {
    if (!(error instanceof DataLayerError)) throw error;
    return { valid: false, diagnostics: error.diagnostics.length ? error.diagnostics : [{ code: error.code, message: error.message }] };
  }
}
