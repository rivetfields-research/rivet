import type { SocialAnalysis } from './social-analysis.ts';
import type { TabularAnalysis } from './tabular-datasets.ts';
import type { WeeklyUsageAnalysis } from './reporting-analysis.ts';
import type { FinancialAnalysis } from './financial-reporting.ts';
import type { SourceAnalysis } from './source-analysis.ts';
import type { AnswerRecord } from './answers.ts';
import type { SchedulePin } from './workflow-schedules.ts';
export type { WeeklyUsageAnalysis, UsageCoverage, PeriodCoverage, UsageComparison, UsageDay } from './reporting-analysis.ts';
export type { FinancialAnalysis, FinancialCoverage, FinancialPeriod, FinancialCurrency, FinancialPeriodReport, FinancialTotals, FinancialMetricComparison } from './financial-reporting.ts';
export type RunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
/** Server-supplied identity only. Never store access tokens or derive this from task text. */
export interface RunAccessContext { workspaceId: string; actor: { issuer: string; subject: string }; }
/** from/to are instants (inclusive/exclusive); timezone identifies their calendar-day basis. */
export interface WeeklyReviewPeriod { from: string; to: string; timezone: string; anchor: string; }
export interface WeeklyReviewMetadata extends SchedulePin {
  period: WeeklyReviewPeriod;
  connectionIds: string[];
  missingConnectionIds: string[];
}
export interface StartRunInput { task: string; requestId: string; parentRunId?: string; projectId?: string; sourceIds?: string[]; }
export interface SourceArchiveState { sourceId: string; archived: boolean; archivedAt: string | null; }
export interface Source {
  id: string;
  title: string;
  path: string;
  bytes: number;
  connections?: { id: string; displayName: string; provider: string; observedAt: string; syncedAt?: string }[];
  analytics?: { metrics: { id: string; label: string }[]; recordLabel: string };
  provenance?: { provider: 'google-drive'; fileId: string; accountLabel: string; url: string; modifiedTime: string; retrievedAt: string; contentHash: string; truncated: boolean };
}
export interface SourceDocument extends Source { content: string }
export interface ArchivedSource { source: Source; archivedAt: string | null; canRestore: boolean; }
export interface Artifact {
  id: string;
  title: string;
  content: string;
  citations: string[];
  createdAt: string;
  answer?: AnswerRecord;
  /** Fixed-code calculations saved with this exact artifact; absent on older briefs. */
  socialAnalysis?: SocialAnalysis;
  tabularAnalysis?: TabularAnalysis;
  analysis?: WeeklyUsageAnalysis;
  /** Separate from usage analysis so existing usage clients keep their exact contract. */
  financialAnalysis?: FinancialAnalysis;
  sourceAnalysis?: SourceAnalysis;
}
export interface RunEvent {
  id: string;
  sequence: number;
  type: 'started' | 'preparation' | 'model' | 'model_delta' | 'tool_call' | 'tool_result' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  createdAt: string;
  summary: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  requestId?: string;
  streamPhase?: 'started' | 'completed';
  delta?: string;
}
export interface Run {
  projectId?: string;
  projectSourceIds?: string[];
  projectBrief?: string;
  id: string;
  task: string;
  responseMode?: 'chat' | 'artifact';
  requestId: string;
  /** A durable cancellation of a request that had not yet been admitted. */
  requestWithdrawn?: boolean;
  /** Follow-up execution linked to the original conversation. Older runs are roots. */
  parentRunId?: string;
  sessionId?: string;
  workspaceId?: string;
  actor?: RunAccessContext['actor'];
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  model: string | null;
  profileId: string;
  workflowId: string | null;
  workflowVersion: number | null;
  /** Exact week and connection snapshots sealed before this run's admission. */
  weeklyReview?: WeeklyReviewMetadata;
  limits: { maxSteps: number; timeoutMs: number };
  usage: { inputTokens: number | null; outputTokens: number | null };
  error: string | null;
  /** Stable failure category for recovery and support; absent on older saved runs. */
  errorCode?: string;
  /** Complete CSV result committed before requesting its explanation. */
  savedCalculation?: { analysis: TabularAnalysis; savedAt: string };
  savedSourceAnalysis?: SourceAnalysis;
  /** Explicit, separately budgeted explanation attempt; never replays tools. */
  explanationRetryOf?: string;
  result: Artifact | null;
  /** A conversational response, not a source-checked report. Absent on older runs. */
  reply?: { content: string; createdAt: string; answer?: AnswerRecord; citations?: string[]; analysis?: WeeklyUsageAnalysis; financialAnalysis?: FinancialAnalysis; socialAnalysis?: SocialAnalysis; tabularAnalysis?: TabularAnalysis; sourceAnalysis?: SourceAnalysis };
  events: RunEvent[];
  /** Exact approved source snapshots selected when this attempt began. */
  sourceIds?: string[];
  /** Explicit additions on this request, retained for safe request-ID retries. */
  requestedSourceIds?: string[];
  /** Input attachments for this conversation, excluding calculated evidence receipts. */
  selectedSourceIds?: string[];
  sources?: Source[];
  sourceRevision?: number;
}
export interface RunUpdate { run: Omit<Run, 'events'>; events: RunEvent[]; cursor: number; hasMore: boolean; }
export type RunSummary = Omit<Run, 'events' | 'result' | 'reply' | 'savedCalculation' | 'savedSourceAnalysis'> & { artifactTitle: string | null; hasReply?: boolean; hasSavedCalculation?: boolean };
export interface ProjectInput { id: string; name: string; brief: string; sourceIds: string[]; version: number; }
export interface Project extends ProjectInput { createdAt: string; updatedAt: string; }
export interface WorkflowInput {
  name: string;
  instructions: string;
  output: string;
  review: string;
  /** Explicit input attachments; missing on older workflows means no sources. */
  sourceIds?: string[];
  /** Latest connection data for the previous full Monday-to-Monday UTC week. */
  weeklyReview?: { connectionIds: string[] };
}
export type WorkflowCreateInput = WorkflowInput & { requestId: string };
export type WorkflowUpdateInput = WorkflowInput & { version: number };
export interface Workflow extends WorkflowInput {
  id: string;
  version: number;
  trigger: 'manual';
  sourceScope: 'approved-notes';
  createdAt: string;
  updatedAt: string;
}
export interface ProviderStatus {
  configured: boolean;
  available: boolean;
  model: string | null;
  label: string;
  kind: 'openai-compatible' | 'azure-openai' | 'unknown';
  message: string;
}
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  tools: string[];
  suggestions?: string[];
  outputLabel?: string;
}
export interface Capability {
  id: string;
  name: string;
  status: 'available' | 'planned';
  description: string;
}
export interface WorkspaceStatus {
  /** Set only by the guarded desktop HTTP entry, not inferred from a local URL. */
  desktop?: true;
  name: string;
  mode: 'local' | 'hosted';
  profile: AgentProfile;
  provider: ProviderStatus;
  capabilities: Capability[];
  sources: Source[];
  /** Retained input metadata, never admitted to a new task until explicitly restored. */
  archivedSources?: ArchivedSource[];
  activeRunId: string | null;
  runBudget?: { limit: number; used: number; resetsAt: string };
  /** Whether this runtime serves scheduled data connections. False means no connection route answers (404). */
  connectionsEnabled?: boolean;
}
