import type { CareFixtureBundle, CareFixtureDocument, CareValues } from './care-types.ts';

// Authored development fixtures. Keep this module on the server: `expected` is
// grader data and must never enter document/model payloads or browser bundles.
const complete = (changes: Partial<CareValues> = {}): CareValues => ({
  signed_form: true,
  contact_confirmed: true,
  requested_service: true,
  supporting_documents: true,
  identity_consistent: true,
  clinical_question: false,
  ...changes,
});

const document = (id: string, title: string, content: string): CareFixtureDocument => ({
  id,
  title,
  content: `FICTIONAL / SYNTHETIC DEVELOPMENT EXAMPLE — NO REAL PATIENT\nPlain-text document authored for the Rivetfields local demonstration.\nThe source channel is simulated; this is not a scanned fax, PDF, or live EHR record.\n\n${content.trim()}\n`,
});

export const careFixtures: CareFixtureBundle = {
  cases: [
    {
      id: 'RF101', title: 'A referral arrives in pieces', ownerId: 'intake', department: 'Referral intake',
      description: 'Follow one fictional packet as a signed form and contact confirmation arrive separately. Review each new version before handing it on.',
    },
    {
      id: 'RF102', title: 'A complete first packet', ownerId: 'reviewer', department: 'Referral review',
      description: 'Inspect a complete fictional packet, check the evidence, and record the staff review and simulated handoff.',
    },
    {
      id: 'RF103', title: 'Two record identifiers', ownerId: 'intake', department: 'Referral intake',
      description: 'Compare conflicting fictional record identifiers and the later correction note. A staff member must resolve the association.',
    },
    {
      id: 'RF104', title: 'A question for the clinical team', ownerId: 'clinician', department: 'Clinical review',
      description: 'Keep an explicitly requested clinical review with the designated clinician, even when the administrative paperwork is complete.',
    },
    {
      id: 'RF105', title: 'A packet waiting for follow-up', ownerId: 'intake', department: 'Referral intake',
      description: 'Receive the packet, then advance the demo clock to test an administrative follow-up. Record the later documents without inventing clinical urgency.',
    },
    {
      id: 'RF106', title: 'A change after staff approval', ownerId: 'reviewer', department: 'Referral review',
      description: 'Review the initial packet before delivering its contact correction. Replay the same intake event to check that it does not create another case.',
    },
  ],
  arrivals: [
    {
      id: 'RF101-A1', caseId: 'RF101', title: 'Initial referral packet', channel: 'fax', initial: true,
      documents: [document('RF101-D1', 'Initial referral — fictional plain text', `
Case identifier: RF101. Subject label: Synthetic record RF101.
Signed form: missing. The referral form has not been signed.
Contact confirmed: no. Contact details have not been confirmed.
Requested service: listed. The request is for a specialist consultation.
Supporting documents: received. All supporting documents required by this fictional checklist are attached.
Identity consistent: yes. The case identifier RF101 is consistent across this packet.
Clinical question: none recorded. No clinical question is recorded in this packet.
This simulated intake contains administrative information only.`)],
      expected: complete({ signed_form: false, contact_confirmed: false }),
    },
    {
      id: 'RF101-A2', caseId: 'RF101', title: 'Signed referral arrives', channel: 'mailbox', initial: false,
      documents: [document('RF101-D2', 'Signed form update — fictional plain text', `
Case identifier: RF101. This update belongs to Synthetic record RF101.
Signed form: received. The signed referral form is now present.
Signature marker: DEMO-SIGNATURE-RF101. This marker is fictional, not a legal signature.
This update replaces the unsigned-form statement in RF101-D1.
Contact confirmed: no. Contact details are still not confirmed.
Requested service: listed as a specialist consultation; unchanged.
Supporting documents: received; unchanged.
Identity consistent: yes. This update and the original packet both identify RF101.
Clinical question: none recorded. No clinical question is recorded in this update.`)],
      expected: complete({ contact_confirmed: false }),
    },
    {
      id: 'RF101-A3', caseId: 'RF101', title: 'Contact confirmation arrives', channel: 'ehr', initial: false,
      documents: [document('RF101-D3', 'Contact confirmation — fictional plain text', `
Case identifier: RF101. This update belongs to Synthetic record RF101.
Contact confirmed: yes. Contact details have now been confirmed in this fictional record.
Contact marker: DEMO-CONTACT-RF101. This is not a telephone number or email address.
This update replaces the earlier unconfirmed-contact statements in RF101-D1 and RF101-D2.
Signed form: received; the signed form in RF101-D2 remains present.
Requested service: listed as a specialist consultation; unchanged.
Supporting documents: received; unchanged.
Identity consistent: yes. All received documents identify RF101.
Clinical question: none recorded. No clinical question is recorded in this packet.
This update records evidence only; it is not a staff approval or an appointment.`)],
      expected: complete(),
    },
    {
      id: 'RF102-A1', caseId: 'RF102', title: 'Complete referral packet', channel: 'ehr', initial: true,
      documents: [document('RF102-D1', 'Complete referral — fictional plain text', `
Case identifier: RF102. Subject label: Synthetic record RF102.
Signed form: received. The signed referral form is present with marker DEMO-SIGNATURE-RF102.
Contact confirmed: yes. Contact details are confirmed with marker DEMO-CONTACT-RF102.
Requested service: listed. The request is for a specialist consultation.
Supporting documents: received. All supporting documents required by this fictional checklist are attached.
Identity consistent: yes. Every part of the packet identifies RF102.
Clinical question: none recorded. No clinical question is recorded in this packet.
No staff approval, clinical clearance, insurance authorization, or appointment is recorded.`)],
      expected: complete(),
    },
    {
      id: 'RF103-A1', caseId: 'RF103', title: 'Packet with conflicting identifiers', channel: 'fax', initial: true,
      documents: [
        document('RF103-D1', 'Referral cover — fictional plain text', `
Intake case identifier: RF103. Subject label: Synthetic record RF103-A.
The attached supporting page uses subject label Synthetic record RF103-B.
Signed form: received. The referral form is signed with marker DEMO-SIGNATURE-RF103.
Contact confirmed: yes. A confirmation marker DEMO-CONTACT-RF103 is present on the referral form.
Requested service: listed. The request is for a specialist consultation.
Supporting documents: received. The required supporting page is attached, but its association is disputed.
Identity consistent: no. The cover and supporting page have conflicting subject identifiers.
Clinical question: none recorded. No clinical question is recorded in the referral.
Do not select which subject identifier is correct from this packet alone.`),
        document('RF103-D2', 'Supporting page — fictional plain text', `
Intake case identifier: RF103. Subject label printed on this page: Synthetic record RF103-B.
The referral cover prints Synthetic record RF103-A.
Identity consistent: no. This page conflicts with the subject identifier on the referral cover.
Supporting documents: received. This is the supporting page for the administrative checklist.
Clinical question: none recorded. This page contains no clinical question or diagnosis.
Staff must resolve the document-to-case association.`),
      ],
      expected: complete({ identity_consistent: false }),
    },
    {
      id: 'RF103-A2', caseId: 'RF103', title: 'Identifier correction note arrives', channel: 'mailbox', initial: false,
      documents: [document('RF103-D3', 'Proposed identity correction — fictional plain text', `
Intake case identifier: RF103.
The fictional sending office proposes that Synthetic record RF103-A is the intended subject and RF103-B was a transcription error.
Identity consistent: no. The conflicting original identifiers remain unresolved until an authorized staff member reviews this correction.
This note supplies correction evidence; it does not approve its own association.
Signed form: received; unchanged.
Contact confirmed: yes; the existing confirmation marker remains present.
Requested service: listed as a specialist consultation; unchanged.
Supporting documents: received; the original supporting page remains attached.
Clinical question: none recorded. No clinical question is recorded in this update.`)],
      expected: complete({ identity_consistent: false }),
    },
    {
      id: 'RF104-A1', caseId: 'RF104', title: 'Referral requesting clinical review', channel: 'ehr', initial: true,
      documents: [document('RF104-D1', 'Clinical review request — fictional plain text', `
Case identifier: RF104. Subject label: Synthetic record RF104.
Signed form: received. The signed referral form is present with marker DEMO-SIGNATURE-RF104.
Contact confirmed: yes. Contact details are confirmed with marker DEMO-CONTACT-RF104.
Requested service: listed. The request is for a specialist consultation.
Supporting documents: received. All supporting documents required by this fictional checklist are attached.
Identity consistent: yes. All received pages identify RF104.
Clinical question: present. The referring team explicitly asks the designated clinician to decide whether the requested service is appropriate.
No answer to that clinical question is recorded. This example contains no symptoms, diagnosis, or treatment recommendation.
Administrative completeness does not resolve the clinical question.`)],
      expected: complete({ clinical_question: true }),
    },
    {
      id: 'RF104-A2', caseId: 'RF104', title: 'Clinical review routing note arrives', channel: 'mailbox', initial: false,
      documents: [document('RF104-D2', 'Routing note — fictional plain text', `
Case identifier: RF104.
Clinical question: present. The clinical question in RF104-D1 remains open for the designated clinician.
The request has been identified for clinical review; no clinician decision is recorded in this note.
Signed form: received; unchanged.
Contact confirmed: yes; unchanged.
Requested service: listed as a specialist consultation; unchanged.
Supporting documents: received; unchanged.
Identity consistent: yes. This routing note and the original packet both identify RF104.
The text records a request, not proof that a real message was sent or a clinician approved anything.`)],
      expected: complete({ clinical_question: true }),
    },
    {
      id: 'RF105-A1', caseId: 'RF105', title: 'Referral awaiting supporting material', channel: 'mailbox', initial: true,
      documents: [document('RF105-D1', 'Incomplete packet — fictional plain text', `
Case identifier: RF105. Subject label: Synthetic record RF105.
Signed form: received. The signed referral form is present with marker DEMO-SIGNATURE-RF105.
Contact confirmed: unknown. The packet does not say whether contact details have been confirmed.
Requested service: listed. The request is for a specialist consultation.
Supporting documents: missing. The supporting document required by this fictional checklist is not attached.
Identity consistent: yes. The received form consistently identifies RF105.
Clinical question: none recorded. No clinical question is recorded in this packet.
No earlier arrival time is claimed. Administrative waiting time starts when this simulated intake is received.`)],
      expected: complete({ contact_confirmed: null, supporting_documents: false }),
    },
    {
      id: 'RF105-A2', caseId: 'RF105', title: 'Supporting material and contact update arrive', channel: 'fax', initial: false,
      documents: [document('RF105-D2', 'Supporting material update — fictional plain text', `
Case identifier: RF105. This update belongs to Synthetic record RF105.
Supporting documents: received. The supporting document required by this fictional checklist is now attached.
Contact confirmed: yes. Contact details are now confirmed with marker DEMO-CONTACT-RF105.
This update replaces the missing-supporting-document and unknown-contact statements in RF105-D1.
Signed form: received; the initial signed referral form remains present.
Requested service: listed as a specialist consultation; unchanged.
Identity consistent: yes. This update and the initial form both identify RF105.
Clinical question: none recorded. No clinical question is recorded in this packet.
An administrative follow-up interval does not establish clinical urgency.`)],
      expected: complete(),
    },
    {
      id: 'RF106-A1', caseId: 'RF106', title: 'Initial packet for staff review', channel: 'ehr', initial: true,
      documents: [document('RF106-D1', 'Initial review packet — fictional plain text', `
Case identifier: RF106. Subject label: Synthetic record RF106.
Signed form: received. The signed referral form is present with marker DEMO-SIGNATURE-RF106.
Contact confirmed: yes. Contact details are confirmed with marker DEMO-CONTACT-RF106-V1.
Requested service: listed. The request is for a specialist consultation.
Supporting documents: received. All supporting documents required by this fictional checklist are attached.
Identity consistent: yes. Every document in this packet identifies RF106.
Clinical question: none recorded. No clinical question is recorded in this packet.
This packet contains no staff approval. Any approval must be recorded separately against this version.`)],
      expected: complete(),
    },
    {
      id: 'RF106-A2', caseId: 'RF106', title: 'Contact correction changes the packet', channel: 'mailbox', initial: false,
      documents: [document('RF106-D2', 'Contact correction — fictional plain text', `
Case identifier: RF106. This update belongs to Synthetic record RF106.
Contact confirmed: no. The previously confirmed contact marker DEMO-CONTACT-RF106-V1 has been withdrawn; its replacement has not been confirmed.
This update replaces the contact-confirmation statement in RF106-D1.
Signed form: received; unchanged.
Requested service: listed as a specialist consultation; unchanged.
Supporting documents: received; unchanged.
Identity consistent: yes. The correction and initial packet both identify RF106.
Clinical question: none recorded. No clinical question is recorded in this update.
This is new evidence for the same case, not a new referral or an approval.
The intake event identifier for this correction is RF106-A2; replaying it must not add another document version.`)],
      expected: complete({ contact_confirmed: false }),
    },
  ],
};
