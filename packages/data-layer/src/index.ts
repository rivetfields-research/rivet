/**
 * Rivet data layer: acquisition separated from interpretation by an immutable raw batch.
 *
 * Phase 1: the contract, the CSV and Apify dataset adapters, and durable storage.
 * Phase 2: strict normalizers, deterministic summaries and comparisons, evidence receipts.
 */
export type {
  PayloadEncoding, RawBatch, RawCoverage, RawFetch, RawManifest, RawObservation, RawProvenance,
  RawRecord, RawScalar, SourceAdapter, SyncCheckpoint, SyncReceipt, SyncStatus,
} from './types.ts';
export { DataLayerError, refuse, type DataDiagnostic } from './errors.ts';
export { canonicalJson, sha256 } from './hash.ts';
export { parseCsv, CSV_LIMITS, type ParsedCsv } from './csv.ts';
export { csvSourceAdapter, CSV_SOURCE_LIMITS, type CsvSourceInput } from './adapters/csv-source.ts';
export { apifyDatasetAdapter, APIFY_DATASET_LIMITS, type ApifyDatasetInput, type ApifyPlatform } from './adapters/apify-dataset.ts';
export { metaGraphAdapter, deriveMetaGraphCsv, parseMetaGraphSnapshot, META_GRAPH_LIMITS, META_GRAPH_SCHEMA, META_INSTAGRAM_MAPPING, META_FACEBOOK_MAPPING, type MetaGraphDerived, type MetaGraphPost, type MetaGraphSnapshot, type MetaProduct } from './adapters/meta-graph.ts';
export { buildBatch, batchId, accountKeyOf, MANIFEST_DIGEST_PREFIX, type BatchIdentity, type PendingBatch } from './batch.ts';
export { openRawStore, type CommitInput, type CommitResult, type FailInput, type RawStore, type RawStoreOptions } from './store.ts';
export { runSync, refusalDiagnostics, type SyncOutcome, type SyncRequest } from './sync.ts';

// --- phase 2 -----------------------------------------------------------------------------
export { TOOL_IDS, TOOL_LABELS, labelFor, isUserFacingLabel, type InternalToolId } from './labels.ts';
export {
  buildReceipt, freshnessOf, observationGapSeconds, FRESHNESS_LIMITS, CONTEMPORANEOUS_TOLERANCE_SECONDS,
  type EvidenceReceipt, type Freshness, type ReceiptInput,
} from './receipts.ts';
export type { FinancialArithmetic } from './ports.ts';
/** The only file that imports `packages/core`; it implements a port this package defines. */
export { coreFinancialArithmetic } from './integrations/core-financial.ts';
export { normalizeFinancialBatch, type NormalizedFinancialSnapshot } from './normalize/financial.ts';
export {
  normalizeSocialBatch, SOCIAL_METRICS, SOCIAL_NORMALIZER_VERSION,
  type NormalizedSocialBatch, type SocialMetric, type SocialPlatform, type SocialPost,
} from './normalize/social.ts';
export {
  socialWeeklySummary, socialPeriodComparison, weekRange, COHORT_STATEMENT,
  type SocialAccountGroup, type SocialMetricAggregate, type SocialPeriodComparison, type SocialWeeklySummary,
} from './query/social.ts';
export {
  financialPeriodSummary, financialMarginChanges, coverageStatus,
  type FinancialCoverageDeclaration, type FinancialQueryResult,
} from './query/financial.ts';
