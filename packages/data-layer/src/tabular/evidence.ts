import type { AnalysisResult, MetricEvidence, RowReference } from './types.ts';

/** Only deduplicate the source hash; row identity, record and physical line stay exact. */
export function compactEvidence(evidence: AnalysisResult['evidence'], sourceHash: string): AnalysisResult['evidence'] {
  const refs = (rows: readonly RowReference[]) => rows.map(({sourceHash: _hash,...row}) => row);
  const metrics = (values: Readonly<Partial<Record<string,MetricEvidence>>>) => Object.fromEntries(Object.entries(values).map(([id,value]) =>
    [id,{...value!,eligible:refs(value!.eligible),missing:refs(value!.missing),excluded:refs(value!.excluded)}]));
  return {sharedSourceHash:sourceHash,totals:metrics(evidence.totals),
    groups:evidence.groups.map(group => ({group:group.group,metrics:metrics(group.metrics)})),
    excludedByDate:refs(evidence.excludedByDate),excludedUndated:refs(evidence.excludedUndated),
    ...(evidence.excludedByContentType ? {excludedByContentType:refs(evidence.excludedByContentType)} : {})};
}

/** Rehydrate only an explicit matching shared hash, never infer absent provenance. */
export function expandMetricEvidence(result: AnalysisResult, evidence: MetricEvidence | undefined): MetricEvidence | undefined {
  const hash = result.evidence.sharedSourceHash;
  if (!evidence || !hash || hash !== result.sourceHash || !/^[a-f0-9]{64}$/.test(hash)) return evidence;
  const refs = (rows: readonly RowReference[]) => rows.map(row => row.sourceHash === undefined ? {...row,sourceHash:hash} : row);
  return {...evidence,eligible:refs(evidence.eligible),missing:refs(evidence.missing),excluded:refs(evidence.excluded)};
}
