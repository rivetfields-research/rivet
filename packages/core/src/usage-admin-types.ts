import type { ModelAllowanceSnapshot } from './workspace-diagnostics.ts';
import type { AdminControlChange } from './admin-control-types.ts';

export interface AllowanceCredit { workspaceId: string; inputByteUnits: number; outputTokens: number; dailyRuns?: number; }
export interface UsageResetReceipt {
  id: string; scope: string; period: string; reason: string; actor: string; at: string;
  adjustments: AllowanceCredit[];
}
export interface UsageResetPreview {
  scope: string; expected: string; people: number; inputByteUnits: number; outputTokens: number;
  dailyRuns?: number;
}
export interface AdminUsageRow {
  id: string; organization: string; name: string; email: string;
  status: 'ready' | 'read_only' | 'inactive' | 'unavailable';
  allowance: ModelAllowanceSnapshot | null;
  preview: UsageResetPreview | null;
  daily?: {limit: number; used: number; resetsAt: string} | null;
  dailyPreview?: UsageResetPreview | null;
  dailyLimit?: {value: number; version: number};
}
export interface AdminUsage {
  period: string; resetsAt: string;
  installation: {allowance: ModelAllowanceSnapshot; preview: UsageResetPreview};
  users: AdminUsageRow[]; allUsers: UsageResetPreview;
  allDaily?: UsageResetPreview;
  history: UsageResetReceipt[];
  limitHistory?: AdminControlChange[];
}
