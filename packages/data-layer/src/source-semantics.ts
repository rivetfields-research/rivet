import type { DatabaseSync } from 'node:sqlite';
import { sampleCorrelation } from 'simple-statistics';
import { contentHash } from './tabular/input.ts';
import { refuse } from './errors.ts';
import type { RawBatch } from './types.ts';
import { parseMetaGraphSnapshot, deriveMetaGraphCsv } from './adapters/meta-graph.ts';
import { parseYouTubeSnapshot } from './adapters/youtube.ts';
import { analyticsTable, mailchimpTable } from './adapters/provider-table.ts';
import { parseCsv } from './csv.ts';
import { reviewSource, validateSourceReview, type SourceReviewRequest } from './source-review.ts';

export const SEMANTIC_VERSION = 'source-semantic/v1';
type Provider = 'facebook' | 'instagram' | 'youtube' | 'mailchimp' | 'google-analytics';
export interface SourceMetricDefinition { id: string; label: string; unit: 'count'; basis: 'lifetime' | 'period'; additive: boolean; sourceField: string }
const definition = (id: string, label: string, sourceField: string, basis: SourceMetricDefinition['basis'] = 'lifetime', additive = true): SourceMetricDefinition => ({ id, label, sourceField, basis, additive, unit: 'count' });
export const SOURCE_METRICS: Record<Provider, readonly SourceMetricDefinition[]> = {
  facebook: [definition('reactions', 'Reactions', 'sum(post_reactions_by_type_total)'), definition('shares', 'Shares', 'shares.count')],
  instagram: ['likes', 'comments', 'shares'].map(id => definition(id, id, `media insights ${id}`)),
  youtube: ['views', 'likes', 'comments'].map(id => definition(id, id, `statistics.${id === 'views' ? 'viewCount' : id === 'likes' ? 'likeCount' : 'commentCount'}`)),
  mailchimp: ['emailsSent', 'totalOpens', 'uniqueOpens', 'totalClicks', 'uniqueClicks', 'unsubscribes', 'hardBounces', 'softBounces']
    .map((id, index) => definition(id, ['Emails sent', 'Total opens', 'Campaign unique opens', 'Total clicks', 'Campaign unique clicks', 'Unsubscribes', 'Hard bounces', 'Soft bounces'][index]!,
      ['emails_sent', 'opens.opens_total', 'opens.unique_opens', 'clicks.clicks_total', 'clicks.unique_clicks', 'unsubscribed', 'bounces.hard_bounces', 'bounces.soft_bounces'][index]!, 'lifetime', !['uniqueOpens', 'uniqueClicks'].includes(id))),
  'google-analytics': ['sessions', 'activeUsers', 'views', 'engagedSessions'].map(id => definition(id, id, id === 'views' ? 'screenPageViews' : id, 'period', id !== 'activeUsers')),
};
export interface SourceRecord {
  id: string; kind: 'post' | 'video' | 'email-campaign' | 'traffic-period'; publishedAt: string | null;
  text: string | null; url: string | null; contentType: string | null;
  campaignId: string | null; trackingLinks: string[];
  period: { date: string; timezone: string; channel: string } | null;
  metrics: Record<string, { value: number | null; missingReason: 'not_returned' | 'unsupported' | null }>;
}
export interface SourceObservation {
  id: string; version: typeof SEMANTIC_VERSION; rawBatchId: string; rawSourceId: string; sourceId: string | null;
  provider: Provider; accountId: string; observedAt: string; providerMeasuredAt: null;
  sourceHash: string; coverage: 'complete' | 'partial' | 'unknown'; capped: boolean; recordCount: number;
  metricDefinitions: readonly SourceMetricDefinition[];
  recordRange?: { from: string; to: string; basis: 'publication' | 'reporting-period'; datedRecords: number };
}
interface Projection { provider: Provider; accountId: string; records: SourceRecord[] }
const text = (value: unknown) => typeof value === 'string' ? value : null;
const time = (value: unknown) => typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function url(value: unknown) {
  if (typeof value !== 'string') return null;
  try { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? value : null; } catch { return null; }
}
function count(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))) refuse('invalid_semantic_count', 'Provider counts must be exact non-negative integers or missing.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) refuse('invalid_semantic_count', 'Provider counts exceed the exact supported range.');
  return parsed;
}
function metrics(provider: Provider, values: unknown[], unsupported = false): SourceRecord['metrics'] {
  return Object.fromEntries(SOURCE_METRICS[provider].map((metric, index) => {
    const value = count(values[index]);
    return [metric.id, { value, missingReason: value === null ? unsupported && !(provider === 'facebook' && metric.id === 'shares') ? 'unsupported' : 'not_returned' : null }];
  }));
}
function project(batch: RawBatch): Projection | null {
  if (batch.adapter === 'meta-graph') {
    const snapshot = parseMetaGraphSnapshot(batch.payload), derived = deriveMetaGraphCsv(batch.payload);
    const csv = derived.csv ? parseCsv(derived.csv) : null;
    const column = (index: number, name: string) => csv?.rows[index]?.[csv.headers.indexOf(name)];
    return { provider: snapshot.product, accountId: snapshot.account.id,
      records: snapshot.posts.map((post, index) => ({ id: post.id, kind: 'post', publishedAt: time(column(index, 'Published')),
        text: text(post.fields[snapshot.product === 'instagram' ? 'caption' : 'message']),
        url: url(post.fields[snapshot.product === 'instagram' ? 'permalink' : 'permalink_url']), contentType: text(column(index, 'Type')),
        campaignId: null, trackingLinks: url(post.fields.link) ? [url(post.fields.link)!] : [],
        period: null, metrics: metrics(snapshot.product, SOURCE_METRICS[snapshot.product].map(metric => column(index, metric.id[0]!.toUpperCase() + metric.id.slice(1))), post.insightsStatus === 'unsupported') })) };
  }
  if (batch.adapter === 'youtube') {
    const snapshot = parseYouTubeSnapshot(batch.payload);
    return { provider: 'youtube', accountId: snapshot.account.id,
      records: snapshot.videos.map(video => ({ id: video.id, kind: 'video', publishedAt: time(video.publishedAt), text: video.title,
        url: `https://www.youtube.com/watch?v=${video.id}`, contentType: 'video', campaignId: null, trackingLinks: [], period: null, metrics: metrics('youtube', [video.views, video.likes, video.comments]) })) };
  }
  if (batch.adapter === 'mailchimp') {
    const snapshot = mailchimpTable.parse(batch.payload);
    return { provider: 'mailchimp', accountId: snapshot.account.id,
      records: snapshot.rows.map(row => ({ id: String(row[0]), kind: 'email-campaign', publishedAt: time(row[3]), text: text(row[2]),
        url: null, contentType: 'email', campaignId: String(row[0]), trackingLinks: [], period: null, metrics: metrics('mailchimp', row.slice(4)) })) };
  }
  if (batch.adapter === 'google-analytics') {
    const snapshot = analyticsTable.parse(batch.payload);
    return { provider: 'google-analytics', accountId: snapshot.account.id,
      records: snapshot.rows.map(row => {
        const date = String(row[1]);
        if (!/^\d{8}$/.test(date)) refuse('invalid_semantic_period', 'Traffic rows need a provider calendar date.');
        const day = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
        if (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day || typeof row[7] !== 'string') refuse('invalid_semantic_period', 'Traffic rows need a real date and property timezone.');
        try { new Intl.DateTimeFormat('en', { timeZone: row[7] }); } catch { refuse('invalid_semantic_period', 'The property timezone is not supported.'); }
        return { id: String(row[0]), kind: 'traffic-period', publishedAt: null, text: null, url: null, contentType: null, campaignId: null, trackingLinks: [],
          period: { date: day, timezone: row[7], channel: String(row[2]) }, metrics: metrics('google-analytics', row.slice(3, 7)) };
      }) };
  }
  return null;
}

/** Rebuildable projections share the raw store's database; uploads cannot supply provider provenance. */
export function createSourceSemantics(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS semantic_observations (
    id TEXT PRIMARY KEY REFERENCES raw_observations(id), raw_source_id TEXT NOT NULL, source_id TEXT, metadata TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS semantic_observations_source ON semantic_observations(raw_source_id);
    CREATE INDEX IF NOT EXISTS semantic_observations_input ON semantic_observations(source_id);
    CREATE TABLE IF NOT EXISTS semantic_records (
      observation_id TEXT NOT NULL REFERENCES semantic_observations(id), record_id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(observation_id, record_id));
    CREATE TABLE IF NOT EXISTS semantic_metric_values (
      observation_id TEXT NOT NULL, record_id TEXT NOT NULL, metric_id TEXT NOT NULL, value INTEGER, missing_reason TEXT,
      PRIMARY KEY(observation_id, record_id, metric_id),
      FOREIGN KEY(observation_id,record_id) REFERENCES semantic_records(observation_id,record_id));`);
  const get = (id: string): SourceObservation | undefined => {
    const row = db.prepare('SELECT metadata FROM semantic_observations WHERE id=?').get(id);
    return row ? JSON.parse(row.metadata as string) as SourceObservation : undefined;
  };
  const records = (id: string): SourceRecord[] => db.prepare('SELECT data FROM semantic_records WHERE observation_id=? ORDER BY record_id').all(id).map(row => JSON.parse(row.data as string));
  return {
    get, records,
    forSource(sourceId: string): SourceObservation[] {
      return db.prepare("SELECT metadata FROM semantic_observations WHERE source_id=? ORDER BY json_extract(metadata,'$.observedAt') DESC,id DESC LIMIT 100")
        .all(sourceId).map(row => JSON.parse(row.metadata as string));
    },
    list(rawSourceId: string): SourceObservation[] {
      return db.prepare("SELECT metadata FROM semantic_observations WHERE raw_source_id=? ORDER BY json_extract(metadata,'$.observedAt') DESC,id DESC LIMIT 100")
        .all(rawSourceId).map(row => JSON.parse(row.metadata as string));
    },
    ingest(batch: RawBatch, sourceId: string | null): SourceObservation | null {
      const projection = project(batch);
      if (!projection) return null;
      const existing = get(batch.observationId);
      if (existing) return existing;
      const ids = new Set<string>();
      for (const record of projection.records) {
        if (!record.id || record.id.length > 200 || ids.has(record.id)) refuse('duplicate_semantic_record', 'Provider records need distinct stable IDs.');
        ids.add(record.id);
      }
      const dates = projection.records.map(record => record.period?.date ?? record.publishedAt).filter((date): date is string => date !== null).sort();
      const observation: SourceObservation = { id: batch.observationId, version: SEMANTIC_VERSION, rawBatchId: batch.id, rawSourceId: batch.sourceId,
        sourceId, provider: projection.provider, accountId: projection.accountId, observedAt: batch.fetchedAt, providerMeasuredAt: null,
        sourceHash: batch.contentHash, coverage: batch.provenance.declaredCoverage,
        capped: projection.provider === 'facebook' || projection.provider === 'instagram' ? parseMetaGraphSnapshot(batch.payload).truncated : projection.provider === 'youtube' ? parseYouTubeSnapshot(batch.payload).truncated : false,
        recordCount: projection.records.length, metricDefinitions: SOURCE_METRICS[projection.provider],
        ...(dates.length ? { recordRange: { from: dates[0]!, to: dates.at(-1)!, basis: projection.provider === 'google-analytics' ? 'reporting-period' as const : 'publication' as const, datedRecords: dates.length } } : {}) };
      db.exec('SAVEPOINT source_projection');
      try {
        db.prepare('INSERT INTO semantic_observations(id,raw_source_id,source_id,metadata) VALUES (?,?,?,?)').run(observation.id, batch.sourceId, sourceId, JSON.stringify(observation));
        const insertRecord = db.prepare('INSERT INTO semantic_records(observation_id,record_id,data) VALUES (?,?,?)');
        const insertMetric = db.prepare('INSERT INTO semantic_metric_values(observation_id,record_id,metric_id,value,missing_reason) VALUES (?,?,?,?,?)');
        for (const record of projection.records) {
          insertRecord.run(observation.id, record.id, JSON.stringify(record));
          for (const [metricId, value] of Object.entries(record.metrics)) insertMetric.run(observation.id, record.id, metricId, value.value, value.missingReason);
        }
        db.exec('RELEASE source_projection');
      } catch (error) { db.exec('ROLLBACK TO source_projection; RELEASE source_projection'); throw error; }
      return observation;
    },
  };
}
export type SourceSemantics = ReturnType<typeof createSourceSemantics>;
export type SourceAnalysisRequest =
  | SourceReviewRequest
  | { operation: 'compare'; before: string; after: string; metric: string }
  | { operation: 'join' | 'correlate'; left: { observationId: string; metric: string }; right: { observationId: string; metric: string };
      on: { kind: 'identity' | 'period' } | { kind: 'explicit'; pairs: { leftRecordId: string; rightRecordId: string }[] } };

function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) refuse('invalid_source_analysis', 'Use a supported typed source-analysis request, not SQL or supplied values.');
  return value as Record<string, any>;
}
const identifier = (value: unknown) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) refuse('invalid_source_analysis', 'Use exact saved observation, record and metric IDs.');
  return value;
};
export function validateSourceAnalysis(input: unknown): SourceAnalysisRequest {
  if ((input as SourceAnalysisRequest)?.operation === 'review') return validateSourceReview(input);
  if ((input as SourceAnalysisRequest)?.operation === 'compare') {
    const value = object(input, ['operation', 'before', 'after', 'metric']);
    return { operation: 'compare', before: identifier(value.before), after: identifier(value.after), metric: identifier(value.metric) };
  }
  const value = object(input, ['operation', 'left', 'right', 'on']);
  if (!['join', 'correlate'].includes(value.operation)) refuse('invalid_source_analysis', 'Choose review, compare, join or correlate.');
  const side = (input: unknown) => { const value = object(input, ['observationId', 'metric']); return { observationId: identifier(value.observationId), metric: identifier(value.metric) }; };
  const on = object(value.on, value.on?.kind === 'explicit' ? ['kind', 'pairs'] : ['kind']);
  if (!['identity', 'period', 'explicit'].includes(on.kind)) refuse('invalid_source_analysis', 'Join by identity, compatible periods or explicit one-to-one record pairs.');
  if (on.kind === 'explicit') {
    if (!Array.isArray(on.pairs) || !on.pairs.length || on.pairs.length > 100) refuse('invalid_source_analysis', 'Provide 1-100 explicit record pairs.');
    on.pairs = on.pairs.map((pair: unknown) => { const value = object(pair, ['leftRecordId', 'rightRecordId']); return { leftRecordId: identifier(value.leftRecordId), rightRecordId: identifier(value.rightRecordId) }; });
    if (new Set(on.pairs.map((pair: any) => pair.leftRecordId)).size !== on.pairs.length || new Set(on.pairs.map((pair: any) => pair.rightRecordId)).size !== on.pairs.length) refuse('join_fanout', 'Explicit pairs must be one-to-one; fan-out would duplicate metrics.');
  }
  return { operation: value.operation, left: side(value.left), right: side(value.right), on } as SourceAnalysisRequest;
}

export function analyzeSources(store: Pick<SourceSemantics,'get'|'records'>, input: unknown) {
  const request = validateSourceAnalysis(input);
  if (request.operation === 'review') return reviewSource(store, request);
  const load = (id: string, metric: string) => {
    const observation = store.get(id);
    if (!observation) refuse('unknown_observation', 'That observation is unavailable in this workspace.');
    const definition = observation.metricDefinitions.find(value => value.id === metric);
    if (!definition) refuse('unsupported_source_metric', 'That metric is not defined for this source.');
    return { observation, definition, records: store.records(id) };
  };
  const evidence = (observation: SourceObservation, recordId: string) => ({ observationId: observation.id, rawBatchId: observation.rawBatchId,
    sourceId: observation.sourceId, sourceHash: observation.sourceHash, recordId });
  if (request.operation === 'compare') {
    const before = load(request.before, request.metric), after = load(request.after, request.metric);
    if (before.observation.rawSourceId !== after.observation.rawSourceId || before.observation.provider !== after.observation.provider || before.observation.accountId !== after.observation.accountId || before.definition.basis !== 'lifetime') refuse('incompatible_observations', 'Counter comparisons need the same connected account and lifetime metric. Period data needs a period query instead.');
    if (before.observation.observedAt >= after.observation.observedAt) refuse('invalid_observation_order', 'Choose two observations in forward acquisition-time order.');
    const previous = new Map(before.records.map(record => [record.id, record])), current = new Map(after.records.map(record => [record.id, record]));
    const rows = [...new Set([...previous.keys(), ...current.keys()])].sort().map(id => {
      const left = previous.get(id), right = current.get(id), a = left?.metrics[request.metric]?.value ?? null, b = right?.metrics[request.metric]?.value ?? null;
      return { recordId: id, before: a, after: b, delta: a !== null && b !== null ? b - a : null,
        status: !left ? 'new_in_window' : !right ? 'absent_from_window' : a === null || b === null ? 'missing_metric' : 'matched',
        evidence: [left ? evidence(before.observation, id) : null, right ? evidence(after.observation, id) : null].filter(Boolean) };
    });
    const matched = rows.filter(row => row.delta !== null);
    const total = matched.reduce((sum, row) => sum + row.delta!, 0);
    if (!Number.isSafeInteger(total)) refuse('semantic_overflow', 'Counter changes exceed the exact supported range.');
    return { operation: 'compare' as const, id: `source_analysis_${contentHash(request)}`, request, metric: before.definition, rows, matchedRecords: matched.length,
      matchedNetChange: matched.length ? total : null, observations: [before.observation, after.observation],
      warnings: ['Net change of matched lifetime counters, not a complete activity log. New or absent records are not zero and absence does not prove deletion.', 'Coverage describes each collected window, not the whole account.'] };
  }
  const left = load(request.left.observationId, request.left.metric), right = load(request.right.observationId, request.right.metric);
  if (left.definition.basis !== right.definition.basis) refuse('incompatible_metric_periods', 'Do not pair lifetime counters with daily activity. First obtain compatible period measurements.');
  let pairs: { leftRecordId: string; rightRecordId: string }[];
  if (request.on.kind === 'explicit') pairs = request.on.pairs;
  else {
    if (request.on.kind === 'identity' && (left.observation.provider !== right.observation.provider || left.observation.accountId !== right.observation.accountId)) refuse('incompatible_join', 'Record identity joins require the same provider and account. Cross-source relationships need explicit pairs.');
    if (request.on.kind === 'period') {
      const zones = new Set([...left.records, ...right.records].map(record => record.period?.timezone));
      if (zones.has(undefined) || zones.size > 1) refuse('incompatible_join', 'Period joins need one common property timezone.');
    }
    const key = (record: SourceRecord) => {
      if (request.on.kind === 'identity') return record.id;
      if (!record.period) refuse('incompatible_join', 'Period joins need native date, timezone and channel dimensions on both sides.');
      return JSON.stringify([record.period.date, record.period.timezone, record.period.channel]);
    };
    const index = new Map<string, string>();
    for (const record of right.records) { const id = key(record); if (index.has(id)) refuse('join_fanout', 'The requested join key is not unique.'); index.set(id, record.id); }
    const seen = new Set<string>();
    pairs = left.records.flatMap(record => { const id = key(record); if (seen.has(id)) refuse('join_fanout', 'The requested join key is not unique.'); seen.add(id); const match = index.get(id); return match ? [{ leftRecordId: record.id, rightRecordId: match }] : []; });
  }
  const a = new Map(left.records.map(record => [record.id, record])), b = new Map(right.records.map(record => [record.id, record]));
  const rows = pairs.map(pair => {
    const x = a.get(pair.leftRecordId), y = b.get(pair.rightRecordId);
    if (!x || !y) refuse('unknown_join_record', 'An explicit pair names a record outside the saved observations.');
    if (left.definition.basis === 'period' && (!x.period || !y.period || x.period.date !== y.period.date || x.period.timezone !== y.period.timezone)) refuse('incompatible_join', 'Paired period measurements must share their date and timezone; lagged comparisons are not supported.');
    return { ...pair, left: x.metrics[request.left.metric]!.value, right: y.metrics[request.right.metric]!.value,
      evidence: [evidence(left.observation, x.id), evidence(right.observation, y.id)] };
  });
  const eligible = rows.filter(row => row.left !== null && row.right !== null);
  const warnings = ['Pairing shows an association, not attribution or causation. No significance test or multiple-testing correction is performed.',
    ...(request.on.kind === 'explicit' ? ['Relationships are caller-declared exact pairs, not provider-verified campaign links.'] : []),
    ...(left.observation.observedAt !== right.observation.observedAt ? ['The two sources were acquired at different times; provider reporting delays are not adjusted.'] : []),
    ...(left.definition.basis === 'lifetime' ? ['Lifetime counters can correlate because content differs in age or exposure. These are not daily activity measurements.'] : ['Paired periods share their provider date and timezone. Period-key joins also match channel. No resampling or lag inference is performed.']),
    ...([left.observation, right.observation].some(value => value.coverage !== 'complete' || value.capped) ? ['At least one collected window is partial or capped.'] : [])];
  let correlation: number | null = null;
  if (request.operation === 'correlate' && eligible.length >= 3) {
    const value = sampleCorrelation(eligible.map(row => row.left!), eligible.map(row => row.right!));
    correlation = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : null;
  }
  return { operation: request.operation, id: `source_analysis_${contentHash(request)}`, request, observations: [left.observation, right.observation],
    metrics: [left.definition, right.definition], rows, eligiblePairs: eligible.length, missingPairs: rows.length - eligible.length,
    unmatchedLeft: left.records.length - rows.length, unmatchedRight: right.records.length - rows.length,
    ...(request.operation === 'correlate' ? { method: 'Pearson', correlation, status: eligible.length < 3 ? 'insufficient_pairs' : correlation === null ? 'constant_or_unrepresentable_series' : 'calculated' } : {}), warnings };
}
