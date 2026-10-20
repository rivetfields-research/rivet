/** One actionable reason an input was refused, mirroring the harness diagnostic shape. */
export interface DataDiagnostic {
  readonly code: string;
  readonly message: string;
  /** Field, column or header the diagnostic refers to. */
  readonly field?: string;
  /** 1-based record number in the boundary input, when known. */
  readonly record?: number;
}

/**
 * A refusal with an actionable reason. Unknown or malformed input fails here rather
 * than producing a quietly guessed interpretation: a wrong guess is worse than a stop.
 */
export class DataLayerError extends Error {
  constructor(message: string, public code: string, public diagnostics: readonly DataDiagnostic[] = []) {
    super(message);
    this.name = 'DataLayerError';
  }
}

export function refuse(code: string, message: string, extra: Omit<DataDiagnostic, 'code' | 'message'> = {}): never {
  throw new DataLayerError(message, code, [{ code, message, ...extra }]);
}
