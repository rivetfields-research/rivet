import { createHash } from 'node:crypto';
import type { createTabularStore } from './tabular-datasets.ts';
import { HarnessError } from './errors.ts';
import { analyzeSources, validateSourceAnalysis } from '../../data-layer/src/source-semantics.ts';
import { tabularError } from './tabular-datasets.ts';
import { sourceAnalysisObservationIds } from './source-analysis.ts';

export type TabularStore = ReturnType<typeof createTabularStore>;
export type SharedTabular = Pick<TabularStore, 'list' | 'get' | 'analyze' | 'capabilities' | 'observationsForSource' | 'sourceObservation' | 'sourceRecords' | 'analyzeSources'>;
export const teamSource = (id: string) => id.startsWith('team_');

/** Namespaces references, not source contents or user-provided strings. All reads recheck current ACLs. */
export function sharedTabular(store: TabularStore, allowed: (sourceId: string) => boolean, namespace = 'team_'): SharedTabular {
  const prefix = (id: string) => `${namespace}${id}`;
  const original = (id: string) => {if (!id.startsWith(namespace)) throw new HarnessError('Shared source unavailable.',403,'shared_source_denied');return id.slice(namespace.length);};
  const references = () => new Set(store.list().filter(item => allowed(item.source.id)).flatMap(item => [item.id,item.source.id,...store.observationsForSource(item.source.id).map(observation => observation.id)]));
  const map = <T>(value: T, refs = references()): T => {
    if (Array.isArray(value)) return value.map(item => map(item,refs)) as T;
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      typeof item === 'string' && (['sourceId','datasetId','observationId','before','after'].includes(key) || (key === 'id' && ('rawSourceId' in value || 'mapping' in value || 'source' in value || 'content' in value))) && refs.has(item) ? prefix(item)
      : key === 'path' && typeof item === 'string' && item.startsWith('datasets/') ? item.replace('datasets/', `datasets/${namespace}`)
      : ['data','attributes'].includes(key) ? item : map(item,refs)])) as T;
  };
  // Source descriptors use content-derived IDs; explicitly map their ID even if its prefix changes.
  const summary = <T extends {id: string; source: {id: string; path: string; content: string; bytes: number}}>(item: T): T => {
    const result = map(item); result.id = prefix(item.id); result.source.id = prefix(item.source.id);
    const content = item.source.content.replaceAll(item.id,prefix(item.id));
    result.source = {...result.source,content,bytes:Buffer.byteLength(content)};return result;
  };
  const requireDataset = (id: string) => {
    const saved = store.get(original(id));
    if (!saved || !allowed(saved.source.id)) throw new HarnessError('This team source is no longer available to you.', 403, 'shared_source_denied');
    return saved;
  };
  const observation = (id: string) => {
    const saved = store.sourceObservation(original(id));
    if (!saved?.sourceId || !allowed(saved.sourceId)) throw new HarnessError('This team observation is unavailable.', 403, 'shared_source_denied');
    return saved;
  };
  return {
    list: () => store.list().filter(item => allowed(item.source.id)).map(summary),
    get: id => summary(requireDataset(id)),
    analyze: (id, request) => { const saved = requireDataset(id); const result = store.analyze(saved.id, request); const mapped = map(result); const content = result.source.content.replaceAll(saved.id,prefix(saved.id));
      const sourceId = `source_${createHash('sha256').update(content).digest('hex')}`;
      mapped.source = {...result.source,id:sourceId,content,bytes:Buffer.byteLength(content)}; mapped.analysis = {...mapped.analysis,sourceId,datasetId:prefix(result.analysis.datasetId)}; return mapped; },
    capabilities: id => store.capabilities(requireDataset(id).id),
    observationsForSource: id => allowed(original(id)) ? store.observationsForSource(original(id)).map(item => ({...map(item), id: prefix(item.id), sourceId: item.sourceId ? prefix(item.sourceId) : null})) : [],
    sourceObservation: id => { const item = observation(id); return {...map(item), id: prefix(item.id), sourceId: item.sourceId ? prefix(item.sourceId) : null}; },
    sourceRecords: id => { observation(id); return store.sourceRecords(original(id)); },
    analyzeSources: input => {
      const request = validateSourceAnalysis(input);
      const ids = sourceAnalysisObservationIds(request);
      const replacements = new Map(ids.map(id => [id, observation(id).id]));
      const unmap = (value: unknown): unknown => typeof value === 'string' ? replacements.get(value) ?? value : Array.isArray(value) ? value.map(unmap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,unmap(v)])) : value;
      return map(store.analyzeSources(unmap(request)));
    },
  };
}

/** Compose authorized readers without copying datasets or exposing their mutation methods. */
export function sharedTabularReaders(readers: () => {namespace:string;store:SharedTabular}[]): SharedTabular {
  const find = (id:string) => {
    const found = readers().sort((a,b) => b.namespace.length-a.namespace.length).find(item => id.startsWith(item.namespace));
    if (!found) throw new HarnessError('Shared source unavailable.',403,'shared_source_denied');
    return found.store;
  };
  return {
    list: () => readers().flatMap(item => item.store.list()),
    get: id => find(id).get(id), analyze: (id,request) => find(id).analyze(id,request), capabilities: id => find(id).capabilities(id),
    observationsForSource: id => find(id).observationsForSource(id), sourceObservation: id => find(id).sourceObservation(id), sourceRecords: id => find(id).sourceRecords(id),
    analyzeSources: input => {
      try {
        const request = validateSourceAnalysis(input);
        for (const id of sourceAnalysisObservationIds(request)) find(id).sourceObservation(id);
        return analyzeSources({get:id => find(id).sourceObservation(id),records:id => find(id).sourceRecords(id)},request);
      } catch (error) { return tabularError(error); }
    },
  };
}

export function combinedTabular(privateStore: TabularStore, shared: SharedTabular): TabularStore {
  return {...privateStore,
    list: () => [...privateStore.list(), ...shared.list()],
    get: id => teamSource(id) ? shared.get(id) : privateStore.get(id),
    capabilities: id => teamSource(id) ? shared.capabilities(id) : privateStore.capabilities(id),
    analyze: (id, request) => teamSource(id) ? shared.analyze(id, request) : privateStore.analyze(id, request),
    observationsForSource: id => teamSource(id) ? shared.observationsForSource(id) : privateStore.observationsForSource(id),
    sourceObservation: id => teamSource(id) ? shared.sourceObservation(id) : privateStore.sourceObservation(id),
    sourceRecords: id => teamSource(id) ? shared.sourceRecords(id) : privateStore.sourceRecords(id),
    analyzeSources: input => {
      const ids = sourceAnalysisObservationIds(validateSourceAnalysis(input));
      if (ids.some(teamSource) && !ids.every(teamSource)) throw new HarnessError('Choose observations from the same data space.', 422, 'mixed_data_spaces');
      return ids.every(teamSource) ? shared.analyzeSources(input) : privateStore.analyzeSources(input);
    },
  };
}
