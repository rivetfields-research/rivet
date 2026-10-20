import { refuse } from '../errors.ts';
import { allowedKeys, object } from './input.ts';
import type { CountMetric, CsvMapping, MetricDefinition, MetricSource, TimeBasis } from './types.ts';

const FIELDS: Record<MetricSource['provider'], Partial<Record<CountMetric, string>>> = {
  facebook: { reactions: 'sum(post_reactions_by_type_total)', shares: 'shares.count' },
  instagram: { likes: 'media insights likes', comments: 'media insights comments', shares: 'media insights shares' },
  youtube: { likes: 'statistics.likeCount', comments: 'statistics.commentCount' },
};

export function validateMetricSource(input: MetricSource, mapping: CsvMapping): MetricSource {
  const source = object(input, 'Metric source');
  allowedKeys(source, ['provider', 'accountId'], 'Metric source');
  if (!['facebook', 'instagram', 'youtube'].includes(source.provider as string) ||
      typeof source.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(source.accountId)) {
    refuse('invalid_metric_source', 'Use the connector-provided metric source.');
  }
  const provider = source.provider as MetricSource['provider'];
  if (mapping.kind === 'source-table' || mapping.platform !== (provider === 'youtube' ? 'unspecified' : provider) ||
      Object.keys(mapping.columns).some(field => !['postId', 'publishedAt', 'account', 'contentType'].includes(field) && !Object.hasOwn(FIELDS[provider], field))) {
    refuse('invalid_metric_source', 'The mapped metrics do not match this connector. Views, reach and impressions are not interchangeable.');
  }
  return { provider, accountId: source.accountId };
}

export function providerTimeBasis(source: MetricSource): TimeBasis {
  return {
    grouping: 'publication_time', timezone: 'UTC', weekStartsOn: 'monday', metricObservation: 'api_lifetime_counts', observedAt: null,
    description: `${source.provider === 'youtube' ? 'Video' : 'Post'} counts are lifetime counters read from the provider API. Dates select when content was published, not when engagement was earned. Never add successive snapshots of the same counters. Exact provider measurement time is not supplied. Missing values are not zero.`,
  };
}

export function providerMetricDefinition(definition: MetricDefinition, source?: MetricSource): MetricDefinition {
  const sourceField = source && FIELDS[source.provider][definition.id as CountMetric];
  return sourceField ? { ...definition, sourceField, countingPeriod: 'lifetime' } : definition;
}
