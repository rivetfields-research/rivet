import type { AnalysisResult } from './types.ts';
import { analysisColumnLabel } from './labels.ts';
import { exportGroupLabel, type PostPresentation } from './post-presentation.ts';

/** Quote every cell and neutralize spreadsheet formulas, including leading control whitespace. */
function cell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportAnalysisCsv(result: AnalysisResult, labels?: ReadonlyMap<string, PostPresentation>): string {
  return [result.columns.map(column => cell(analysisColumnLabel(column, result.request.groupBy))).join(','), ...result.rows.map(row => result.columns.map(column => cell(column.id === 'group' ? exportGroupLabel(result, row.group, labels) : row[column.id])).join(','))].join('\r\n') + '\r\n';
}
