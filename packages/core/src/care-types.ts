export const CARE_FIELDS = ['signed_form', 'contact_confirmed', 'requested_service', 'supporting_documents', 'identity_consistent', 'clinical_question'] as const;
export type CareField = typeof CARE_FIELDS[number];
export type CareValues = Record<CareField, boolean | null>;
export type CareStatus = 'received' | 'needs_information' | 'needs_identity_review' | 'needs_clinical_review' | 'ready_for_review' | 'approved' | 'handed_off';
export type CareActorId = 'intake' | 'reviewer' | 'clinician' | 'supervisor';
export interface CareActor { id: CareActorId; name: string; role: string; grants: string[] }
export interface CareFixtureCase { id: string; title: string; ownerId: CareActorId; department: string; description: string }
export interface CareFixtureDocument { id: string; title: string; content: string }
export interface CareFixtureArrival { id: string; caseId: string; title: string; channel: 'fax' | 'mailbox' | 'ehr'; initial: boolean; documents: CareFixtureDocument[]; expected: CareValues }
export interface CareFixtureBundle { cases: CareFixtureCase[]; arrivals: CareFixtureArrival[] }
export interface CareArrivalSummary extends Omit<CareFixtureArrival, 'documents' | 'expected'> { delivered: boolean; documentCount: number }
export interface CareDocument extends CareFixtureDocument { arrivalId: string; channel: CareFixtureArrival['channel']; caseVersion: number; receivedAt: string; synthetic: true }
export interface CareProposal { field: CareField; value: boolean | null; documentId: string | null; quote: string | null }
export interface CareCheck { field: CareField; result: 'pass' | 'missing' | 'unknown' | 'review_required'; explanation: string }
export interface CareEvent { id: string; sequence: number; type: string; createdAt: string; actorId: CareActorId | 'system' | 'model'; caseVersion: number; summary: string; detail?: unknown }
export interface CareAnalysis {
  id: string; caseId: string; caseVersion: number; actorId: CareActorId; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string; updatedAt: string; elapsedMs: number | null; model: string | null; inputTokens: number | null; outputTokens: number | null;
  proposals: CareProposal[]; checks: CareCheck[]; explanation: string; error: string | null;
  benchmark: { matched: number; total: number; mismatches: CareField[] } | null;
}
export interface CareReview { id: string; actorId: CareActorId; caseVersion: number; analysisId: string | null; decision: 'approve' | 'request_changes' | 'resolve_identity' | 'resolve_clinical'; note: string; createdAt: string; stale: boolean }
export interface CareReceipt { id: string; caseId: string; caseVersion: number; approvalId: string; actorId: CareActorId; createdAt: string; destination: 'Simulated internal handoff'; payload: string; simulated: true; stale: boolean }
export interface CareTimer { id: string; actorId: CareActorId; kind: 'manual_baseline' | 'review'; caseVersion: number; startedAt: string; stoppedAt: string | null; elapsedMs: number | null }
export interface CareCaseSummary extends CareFixtureCase { version: number; status: CareStatus; documentCount: number; receivedAt: string | null; updatedAt: string; latestAnalysisId: string | null; analysisStatus: CareAnalysis['status'] | null; staleAnalysis: boolean; missingFields: CareField[]; approvalId: string | null; receiptId: string | null; overdue: boolean; synthetic: true }
export interface CareCase extends CareCaseSummary { documents: CareDocument[]; analyses: CareAnalysis[]; reviews: CareReview[]; receipts: CareReceipt[]; events: CareEvent[]; timers: CareTimer[]; views: { actorId: CareActorId; caseVersion: number; viewedAt: string; analysisId?: string | null }[] }
export interface CareSchedule { id: string; name: string; enabled: boolean; everyMinutes: number; createdAt: string; updatedAt: string; nextDueAt: string }
export interface CareFollowUp { id: string; scheduleId: string; caseId: string; caseVersion: number; dueAt: string; createdAt: string; status: 'open' | 'resolved'; resolvedBy: CareActorId | null; resolvedAt: string | null; summary: string; simulated: true }
export interface CareMetrics {
  caseCount: number; receivedCases: number; statuses: Record<CareStatus, number>; analyses: { completed: number; failed: number; cancelled: number; interrupted: number; matchedFields: number; scoredFields: number; averageElapsedMs: number | null; inputTokens: number | null; outputTokens: number | null };
  manualSamples: number; averageManualMs: number | null; reviewSamples: number; averageReviewMs: number | null; estimatedModelCostUSD: null; costExplanation: string;
  handoffs: number; openFollowUps: number;
}
export interface CareOverview { actors: CareActor[]; cases: CareCaseSummary[]; arrivals: CareArrivalSummary[]; schedules: CareSchedule[]; followUps: CareFollowUp[]; metrics: CareMetrics; simulatorNow: string; offsetMinutes: number; mode: 'synthetic-local-demo' }
export interface CareMutation { actorId: CareActorId; requestId: string }
export interface CareVersionMutation extends CareMutation { caseVersion: number }
