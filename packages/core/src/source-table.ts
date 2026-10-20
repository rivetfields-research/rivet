import type { Source } from './types.ts';
import type { TabularAnalysis } from './tabular-datasets.ts';

export function sourceCalculationId(source: Pick<Source, 'path'>): string | null {
  return /^calculations\/(analysis_[a-f0-9]{64})\/receipt\.md$/.exec(source.path)?.[1] ?? null;
}

export interface SavedSourceCalculation {
  runId: string;
  workspaceId?: string;
  analysis: TabularAnalysis;
}

export function sourceDatasetId(source: Pick<Source, 'path'>): string | null {
  return /^datasets\/((?:team_(?:person_[a-f0-9]{32}_)?)?dataset_[a-f0-9]{64})\/schema\.md$/.exec(source.path)?.[1]
    ?? /^datasets\/(usage_version_[a-f0-9]{64})\/checked-metrics\.md$/.exec(source.path)?.[1]
    ?? /^datasets\/(financial_version_[a-f0-9]{64})\/checked-financials\.md$/.exec(source.path)?.[1] ?? null;
}

export function sourceTableKind(source: Pick<Source, 'path'>): 'tabular' | 'usage' | 'financial' | 'csv' | null {
  const id = sourceDatasetId(source);
  if ((id?.startsWith('dataset_') || id?.startsWith('team_'))) return 'tabular';
  if (id?.startsWith('usage_version_')) return 'usage';
  if (id?.startsWith('financial_version_')) return 'financial';
  return /\.csv$/i.test(source.path) ? 'csv' : null;
}

export interface SourceTablePage {
  sourceName: string;
  dataKind?: 'source-table';
  headers: readonly string[];
  primaryColumns?: readonly string[];
  rows: { record: number; cells: readonly string[] }[];
  totalRows: number;
  matchedRows: number;
  offset: number;
  nextOffset: number | null;
}
