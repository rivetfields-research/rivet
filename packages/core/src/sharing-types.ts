import type { TabularAnalysis } from './tabular-datasets.ts';
import type { AnalysisRequest } from '../../data-layer/src/tabular/types.ts';
export type ShareAudience = {kind: 'team'} | {kind: 'members'; memberIds: string[]};
export interface TeamRecord {
  id: string; kind: 'source' | 'metric' | 'report'; name: string; version: number;
  audience: ShareAudience; publisher: string; updatedAt: string;
  data: {privateSnapshot?: boolean; privateConnection?: {workspaceId:string;connectionId:string}; sourceId?: string; connectionIds?: string[]; datasetId?: string; request?: AnalysisRequest; runId?: string; analysis?: TabularAnalysis};
}
