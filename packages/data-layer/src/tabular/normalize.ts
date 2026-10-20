import { refuse } from '../errors.ts';
import { sha256 } from '../hash.ts';
import { allowedKeys, contentHash, freeze, object, parseBoundedCsv, parseDate, TABULAR_LIMITS } from './input.ts';
import { CANONICAL_FIELDS, COUNT_METRICS, PLATFORMS, TABULAR_VERSION, type CanonicalField, type CsvMapping, type CsvPreview, type MetricSource, type NormalizedDataset, type NormalizedRow, type RowFlag, type TimeBasis } from './types.ts';
import { providerTimeBasis, validateMetricSource } from './provider-metrics.ts';

export const TIME_BASIS: TimeBasis = freeze({
  grouping: 'publication_time', timezone: 'UTC', weekStartsOn: 'monday', metricObservation: 'source_export_counts', observedAt: null,
  description: 'Groups and filters use post publication time in UTC. Counts are values from the source export, potentially lifetime counts; their observation time is unknown. Import time is not observation time. Weeks start Monday. Missing values are never zero.',
});

export function previewCsv(content: string): CsvPreview {
  const parsed = parseBoundedCsv(content);
  return freeze({ sourceHash: sha256(content), headers: parsed.headers, rowCount: parsed.rows.length, sampleRows: parsed.rows.slice(0, 5).map(row => row.cells), limits: TABULAR_LIMITS });
}

function validateMapping(value: unknown, headers: readonly string[]): CsvMapping {
  const mapping = object(value, 'Mapping');
  allowedKeys(mapping, ['confirmed', 'platform', 'account', 'columns', 'timezone', 'kind'], 'Mapping');
  if (mapping.kind !== undefined && mapping.kind !== 'source-table') refuse('invalid_mapping', 'Unknown table kind.');
  if (mapping.confirmed !== true) refuse('mapping_unconfirmed', 'Confirm the column mapping before importing the CSV.');
  if (!PLATFORMS.includes(mapping.platform as never)) refuse('unknown_platform', 'Select instagram, facebook, linkedin, or unspecified.');
  if (mapping.timezone !== undefined && mapping.timezone !== 'UTC') refuse('unsupported_timezone', 'Only an explicitly confirmed UTC timezone is supported.');
  if (mapping.account !== undefined && (typeof mapping.account !== 'string' || !mapping.account.trim() || mapping.account.length > 256)) refuse('invalid_account', 'The account fallback must be nonempty text of at most 256 characters.');
  const columns = object(mapping.columns, 'Mapping columns');
  allowedKeys(columns, CANONICAL_FIELDS, 'Mapping columns');
  const used = new Set<string>();
  for (const [field, header] of Object.entries(columns)) {
    if (typeof header !== 'string' || !headers.includes(header)) refuse('unknown_header', `Map ${field} to an exact header present in this CSV.`, { field });
    if (used.has(header)) refuse('ambiguous_mapping', 'A source column cannot be mapped to more than one canonical field.', { field });
    used.add(header);
  }
  if (!columns.postId) refuse('missing_mapping', 'Map a post ID column to identify duplicate posts.', { field: 'postId' });
  if (mapping.kind === 'source-table' && Object.keys(columns).some(key => !['postId', 'account'].includes(key))) refuse('invalid_mapping', 'Source tables keep native fields without social metric mappings.');
  if (mapping.kind !== 'source-table' && !COUNT_METRICS.some(metric => columns[metric])) refuse('missing_mapping', 'Map at least one supported count metric.');
  return { confirmed: true, ...(mapping.kind ? { kind: 'source-table' as const } : {}), platform: mapping.platform as CsvMapping['platform'], columns: { ...columns } as CsvMapping['columns'], ...(mapping.account ? { account: (mapping.account as string).trim() } : {}), ...(mapping.timezone ? { timezone: 'UTC' as const } : {}) };
}

export function normalizeCsv(content: string, mappingInput: CsvMapping, sourceInput?: MetricSource): NormalizedDataset {
  const parsed = parseBoundedCsv(content);
  const mapping = validateMapping(mappingInput, parsed.headers);
  const metricSource = sourceInput === undefined ? undefined : validateMetricSource(sourceInput, mapping);
  if (!parsed.rows.length) refuse('empty_dataset', 'The CSV must contain at least one data row.');
  const sourceHash = sha256(content), seen = new Set<string>();
  const rows: NormalizedRow[] = parsed.rows.map(({ cells, record, line }) => {
    const flags: RowFlag[] = [];
    const read = (field: CanonicalField): string | null => {
      const header = mapping.columns[field];
      const value = header === undefined ? null : cells[parsed.headers.indexOf(header)].trim();
      if (!value) { flags.push({ code: 'missing_value', field }); return null; }
      return value;
    };
    const postId = read('postId');
    if (!postId) refuse('missing_post_id', 'Each data row needs a post ID.', { record, field: 'postId' });
    let account = read('account');
    if (!account && mapping.account) { account = mapping.account; flags.push({ code: 'account_fallback', field: 'account' }); }
    const identity = JSON.stringify([mapping.platform, account, postId]);
    if (seen.has(identity)) refuse('duplicate_post', account === null ? 'A post ID repeats without an account. Map the account column if these are different accounts, or keep one observation per post.' : 'The same platform, account and post ID appears more than once. Import one observation per post.', { record, field: 'postId' });
    seen.add(identity);
    const publication = read('publishedAt');
    const date = publication === null ? null : parseDate(publication, mapping.timezone === 'UTC', 'publishedAt', record);
    if (date?.assumedUtc) flags.push({ code: 'assumed_utc', field: 'publishedAt' });
    const contentType = read('contentType');
    const metrics = Object.fromEntries(COUNT_METRICS.filter(metric => metric !== 'saves' || mapping.columns.saves !== undefined).map(metric => {
      const value = read(metric);
      if (value === null) return [metric, null];
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        refuse('invalid_metric', `${metric} must be a whole non-negative count, written as digits without separators. Leave missing counts empty.`, { record, field: metric });
      }
      return [metric, Number(value)];
    })) as NormalizedRow['metrics'];
    const id = `row_${contentHash({ sourceHash, record, line })}`;
    return { id, platform: mapping.platform, account, postId, publishedAt: date?.iso ?? null, contentType, metrics, rawCells: cells, provenance: { rowId: id, sourceHash, record, line }, flags };
  });
  const missingPublication = rows.filter(row => row.publishedAt === null).length;
  const countTimeBasis = metricSource ? providerTimeBasis(metricSource) : TIME_BASIS;
  const warnings = [{ code: metricSource ? 'lifetime_snapshot_counts' : 'unknown_observation_time', message: countTimeBasis.description }, ...(missingPublication ? [{ code: 'missing_publication_time', message: `${missingPublication} rows have no publication time and are excluded from date groups or filtered periods.`, count: missingPublication }] : [])];
  if (mapping.platform === 'unspecified' && !metricSource) warnings.push({ code: 'unspecified_platform', message: 'Platform is not specified. Do not infer it from the filename or treat this upload as a verified platform export.' });
  const missingAccounts = rows.filter(row => row.account === null).length;
  if (missingAccounts) warnings.push({ code: 'unspecified_account', message: `${missingAccounts} rows have no account attribution. Post IDs must be unique within the unattributed rows.`, count: missingAccounts });
  const sourceTable = mapping.kind === 'source-table';
  const timeBasis: TimeBasis = sourceTable ? { ...TIME_BASIS, grouping: 'source_period', timezone: 'source_defined', weekStartsOn: null, description: 'Dates and metrics retain their source definitions and timezones. Source dates are not post publication times. Missing values are not zero. Social calculations are unavailable for this table.' } : countTimeBasis;
  const body = { version: TABULAR_VERSION, sourceHash, headers: parsed.headers, mapping, rows, ...(metricSource ? { metricSource } : {}),
    warnings: sourceTable ? [{ code: 'native_source_fields', message: timeBasis.description }] : warnings, timeBasis };
  const hash = contentHash(body);
  return freeze({ ...body, id: `dataset_${hash}`, hash });
}
