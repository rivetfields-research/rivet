export const TABULAR_VERSION = 'social-csv/v1' as const;
export const PLATFORMS = ['instagram', 'facebook', 'linkedin', 'unspecified'] as const;
export type CsvPlatform = typeof PLATFORMS[number];
export const COUNT_METRICS = ['likes', 'reactions', 'comments', 'shares', 'impressions', 'clicks', 'saves'] as const;
export type CountMetric = typeof COUNT_METRICS[number];
export const METRIC_IDS = [...COUNT_METRICS, 'interactions', 'engagementRate', 'postCount', 'reactionInteractions', 'reactionEngagementRate'] as const;
export type MetricId = typeof METRIC_IDS[number];
export const CANONICAL_FIELDS = ['postId', 'publishedAt', 'account', 'contentType', ...COUNT_METRICS] as const;
export type CanonicalField = typeof CANONICAL_FIELDS[number];
export const GROUPINGS = ['post', 'platform', 'account', 'contentType', 'day', 'week', 'month'] as const;
export type Grouping = typeof GROUPINGS[number];
export const CHART_TEMPLATES = ['bar', 'horizontalBar', 'line', 'area', 'combo', 'scatter', 'table'] as const;
export type ChartTemplate = typeof CHART_TEMPLATES[number];

/** Attaching confirms the displayed mapping; preview alone never saves it. */
export interface CsvMapping {
  /** Synced non-social records retain their native fields, without social metric aliases. */
  readonly kind?: 'source-table';
  readonly confirmed: true;
  readonly platform: CsvPlatform;
  readonly account?: string;
  readonly columns: Readonly<Partial<Record<CanonicalField, string>>>;
  /** Explicitly interprets ISO dates/times without an offset as UTC. */
  readonly timezone?: 'UTC';
}

export interface CsvPreview {
  readonly sourceHash: string;
  readonly headers: readonly string[];
  readonly rowCount: number;
  readonly sampleRows: readonly (readonly string[])[];
  readonly limits: { readonly bytes: number; readonly rows: number; readonly columns: number; readonly fieldBytes: number };
}

export interface RowReference {
  readonly rowId: string;
  /** Large results may store this once in evidence.sharedSourceHash. */
  readonly sourceHash?: string;
  /** 1-based logical nonblank CSV record, including the header as record 1. */
  readonly record: number;
  /** 1-based physical line where this record begins; quoted newlines remain one record. */
  readonly line: number;
}

export interface RowFlag {
  readonly code: 'missing_value' | 'account_fallback' | 'assumed_utc';
  readonly field: CanonicalField;
}

export interface NormalizedRow {
  readonly id: string;
  readonly platform: CsvPlatform;
  readonly account: string | null;
  readonly postId: string;
  readonly publishedAt: string | null;
  readonly contentType: string | null;
  readonly metrics: Readonly<Record<Exclude<CountMetric, 'saves'>, number | null> & { saves?: number | null }>;
  /** Untrusted source cells, in dataset.headers order, retained verbatim as data. */
  readonly rawCells: readonly string[];
  readonly provenance: RowReference & { readonly sourceHash: string };
  readonly flags: readonly RowFlag[];
}

export interface TabularWarning {
  readonly code: string;
  readonly message: string;
  readonly count?: number;
}

export interface TimeBasis {
  readonly grouping: 'publication_time' | 'source_period';
  readonly timezone: 'UTC' | 'source_defined';
  readonly weekStartsOn: 'monday' | null;
  readonly metricObservation: 'source_export_counts' | 'api_lifetime_counts';
  readonly observedAt: null;
  readonly description: string;
}

/** Supplied by fixed connector code, never by an uploaded file's mapping. */
export interface MetricSource {
  readonly provider: 'facebook' | 'instagram' | 'youtube';
  readonly accountId: string;
}

export interface NormalizedDataset {
  readonly metricSource?: MetricSource;
  readonly version: typeof TABULAR_VERSION;
  readonly id: string;
  readonly hash: string;
  readonly sourceHash: string;
  readonly headers: readonly string[];
  readonly mapping: CsvMapping;
  readonly rows: readonly NormalizedRow[];
  readonly warnings: readonly TabularWarning[];
  readonly timeBasis: TimeBasis;
}

export interface AnalysisRequest {
  readonly metrics: readonly MetricId[];
  readonly groupBy: Grouping;
  readonly chart: ChartTemplate;
  /** Publication-time interval: from inclusive, to exclusive. Date-only means UTC midnight. */
  readonly dateRange?: { readonly from?: string; readonly to?: string };
  /** Exact normalized content-type values; no aliases, case folding, or missing-value sentinel. */
  readonly contentTypes?: readonly string[];
  readonly timezone?: 'UTC';
  /** Rank complete groups by a requested metric; missing values are always last. */
  readonly sort?: { readonly metric: MetricId; readonly direction: 'asc' | 'desc' };
  /** Return 1–100 ranked groups. Requires sort; totals and evidence keep the full cohort. */
  readonly limit?: number;
}

export interface MetricDefinition {
  readonly sourceField?: string;
  readonly countingPeriod?: 'lifetime';
  readonly id: MetricId;
  readonly label: string;
  readonly unit: 'count' | 'percent';
  readonly formula: string;
  readonly aggregation: 'sum' | 'ratio_of_sums' | 'count';
  readonly requiredFields: readonly CountMetric[];
}

export interface MetricCoverage {
  readonly totalRows: number;
  readonly eligibleRows: number;
  readonly missingRows: number;
  readonly zeroDenominatorRows: number;
}

export interface MetricEvidence {
  readonly formula: string;
  readonly eligible: readonly RowReference[];
  readonly missing: readonly RowReference[];
  readonly excluded: readonly RowReference[];
}

export type AnalysisValues = Readonly<Partial<Record<MetricId, number | null>>>;
export type AnalysisTableRow = Readonly<{ group: string } & Partial<Record<MetricId, number | null>>>;

export interface AnalysisResult {
  readonly metricSource?: MetricSource;
  readonly version: typeof TABULAR_VERSION;
  readonly id: string;
  readonly hash: string;
  readonly datasetId: string;
  readonly datasetHash: string;
  readonly sourceHash: string;
  readonly request: AnalysisRequest;
  readonly columns: readonly { readonly id: 'group' | MetricId; readonly label: string; readonly type: 'string' | 'number'; readonly unit?: 'count' | 'percent' }[];
  readonly rows: readonly AnalysisTableRow[];
  /** Present only for ranked requests, so existing unranked result identities stay stable. */
  readonly selection?: {
    readonly totalGroups: number;
    readonly returnedGroups: number;
    readonly omittedGroups: number;
    readonly totalsScope: 'full_cohort';
    readonly evidenceScope: 'full_cohort';
    readonly tieBreak: 'group_ascending';
    readonly missingValues: 'last';
  };
  readonly totals: AnalysisValues;
  readonly metricCoverage: Readonly<Partial<Record<MetricId, MetricCoverage>>>;
  readonly definitions: readonly MetricDefinition[];
  readonly evidence: {
    readonly sharedSourceHash?: string;
    readonly totals: Readonly<Partial<Record<MetricId, MetricEvidence>>>;
    readonly groups: readonly { readonly group: string; readonly metrics: Readonly<Partial<Record<MetricId, MetricEvidence>>> }[];
    readonly excludedByDate: readonly RowReference[];
    readonly excludedUndated: readonly RowReference[];
    readonly excludedByContentType?: readonly RowReference[];
  };
  readonly counts: { readonly inputRows: number; readonly includedRows: number; readonly excludedByDate: number; readonly excludedUndated: number; readonly excludedByContentType?: number };
  readonly warnings: readonly TabularWarning[];
  readonly timeBasis: TimeBasis;
}
