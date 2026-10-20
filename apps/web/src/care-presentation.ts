import type { CareActorId, CareCase, CareCaseSummary, CareCheck, CareProposal } from '../../../packages/core/src/care-types';

export function careCheckLabel(check: CareCheck, proposal: CareProposal | undefined, resolved: boolean): string {
  if (check.result === 'unknown') return 'Unknown';
  if (check.result === 'missing') return 'Missing';
  if (check.result === 'review_required') return check.field === 'clinical_question' ? 'Clinical review' : check.field === 'identity_consistent' ? 'Identity review' : 'Review';
  if (check.field === 'clinical_question') return resolved ? 'Reviewed' : proposal?.value === false ? 'None recorded' : 'Check passed';
  if (check.field === 'identity_consistent') return resolved ? 'Resolved' : proposal?.value === true ? 'Consistent' : 'Check passed';
  return 'Present';
}

export function viewedCurrentCareEvidence(record: Pick<CareCase, 'analyses' | 'latestAnalysisId' | 'version' | 'views'>, actorId: CareActorId): boolean {
  const analysis = record.analyses.find(item => item.id === record.latestAnalysisId);
  return !!analysis && analysis.status === 'completed' && analysis.caseVersion === record.version
    && record.views.some(view => view.actorId === actorId && view.caseVersion === record.version
      && view.analysisId === analysis.id && Date.parse(view.viewedAt) >= Date.parse(analysis.updatedAt));
}

export function careNeedsAttention(record: Pick<CareCase, 'status' | 'analysisStatus' | 'staleAnalysis' | 'overdue'>): boolean {
  return record.overdue || record.staleAnalysis
    || ['needs_information', 'needs_identity_review', 'needs_clinical_review'].includes(record.status)
    || ['failed', 'cancelled', 'interrupted'].includes(record.analysisStatus ?? '');
}

export function careFollowUpNextStep(record: Pick<CareCaseSummary, 'status' | 'missingFields' | 'staleAnalysis' | 'analysisStatus' | 'documentCount'> | undefined): string {
  if (!record) return 'Open the case to confirm the next step.';
  if (record.staleAnalysis) return 'Recheck the updated packet, then review its new evidence.';
  if (record.analysisStatus === 'queued' || record.analysisStatus === 'running') return 'Wait for the current administrative check to finish.';
  if (['failed', 'cancelled', 'interrupted'].includes(record.analysisStatus ?? '')) return 'Open the case and retry the unfinished administrative check.';
  if (record.status === 'needs_identity_review') return 'Collect correction evidence and route identity review to the supervisor.';
  if (record.status === 'needs_clinical_review') return 'Route the outstanding question to the clinician for review.';
  if (record.status === 'needs_information') {
    const names = { signed_form: 'signed referral form', contact_confirmed: 'contact confirmation', requested_service: 'requested service', supporting_documents: 'supporting documents', identity_consistent: 'identity evidence', clinical_question: 'clinical review' };
    return record.missingFields.length ? `Request ${record.missingFields.map(field => names[field]).join(', ')}.` : 'Review the change request and collect the requested information.';
  }
  if (record.status === 'ready_for_review') return 'Have a reviewer inspect the current evidence and record a decision.';
  if (record.status === 'approved') return 'Create the approved simulated handoff.';
  if (record.status === 'handed_off') return 'The handoff is recorded; confirm this follow-up can be closed.';
  return record.documentCount ? 'Analyze the received packet and inspect its findings.' : 'Receive the referral packet from Intake.';
}
