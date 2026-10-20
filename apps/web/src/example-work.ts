import type { Run, SourceDocument } from '../../../packages/core/src/types';

// Authored, fictional interface example. Never persisted as an executed run.
const notes = [
  { id: 'example-planning', title: 'Quarterly planning', path: 'quarterly-planning.md', content: `# Quarterly planning

Fictional sample workspace. These notes describe an invented company, Alder Studio.

The operations team is preparing the October board update. Mina owns the draft narrative and Theo owns the revenue numbers. The first draft is due October 6; finance review is due October 9. The team will meet October 12 to resolve open questions before sharing the final update.

The main risk is incomplete September invoice reconciliation. The board update must separate invoiced revenue from cash received. No one should describe forecast revenue as collected cash.

Next steps: finance supplies the reconciliation table, operations lists unresolved customer questions, and Mina drafts a short summary with the remaining risks clearly identified.` },
  { id: 'example-handoff', title: 'Finance handoff', path: 'finance-handoff.md', content: `# Finance handoff

Fictional sample workspace. This is example content, not a real customer record.

Theo is responsible for the September invoice reconciliation. Four invoices remain unmatched because bank references are incomplete. The current plan is to resolve those items by October 8, one day before finance review of the board update.

The team has not approved a new accounting integration. Until then, use the reviewed CSV export and record unanswered questions for Theo. Do not change payment status based on a guess.

The update should say that reconciliation is in progress. It should not claim that the month is closed. A delay beyond October 8 would put the October 9 finance review at risk.` },
  { id: 'example-guide', title: 'Team writing guide', path: 'team-writing-guide.md', content: `# Team writing guide

Fictional sample workspace. This guide is provided explicitly; no personal email has been imported.

Start with what changed and what the reader needs to do. Keep messages short, direct and warm. Prefer named owners and exact dates. Use bullets for several next steps. Avoid vague confidence and excessive praise.

Distinguish known facts, proposals and unanswered questions. For the October board update, include owners, dates, the invoice-reconciliation risk and one concrete next action.

Drafts require a person's review before being sent outside the workspace.` },
];
export const exampleSources: SourceDocument[] = notes.map(note => ({ ...note, bytes: new TextEncoder().encode(note.content).length }));
const createdAt = '2026-09-16T17:00:00.000Z';
const task = 'Read the planning and handoff notes. Prepare a short update with the owners, key dates, risks and next steps.';
export const exampleRun: Run = {
  id: 'design-example', requestId: 'design-example', task, status: 'completed', createdAt, updatedAt: createdAt,
  model: null, profileId: 'workspace-analyst', workflowId: null, workflowVersion: null,
  limits: { maxSteps: 8, timeoutMs: 90_000 }, usage: { inputTokens: null, outputTokens: null }, error: null,
  events: [
    { id: 'example-search', sequence: 1, type: 'tool_call', createdAt, toolName: 'workspace.search', summary: 'Find the planning notes and handoff context', input: { query: 'October board update' } },
    { id: 'example-search-result', sequence: 2, type: 'tool_result', createdAt, toolName: 'workspace.search', summary: 'Three relevant sample notes', output: exampleSources.map(({ id, title }) => ({ id, title })) },
    ...exampleSources.flatMap((source, index) => [
      { id: `example-read-${index}`, sequence: 3 + index * 2, type: 'tool_call' as const, createdAt, toolName: 'workspace.read', summary: `Read ${source.title.toLowerCase()}`, input: { id: source.id } },
      { id: `example-read-result-${index}`, sequence: 4 + index * 2, type: 'tool_result' as const, createdAt, toolName: 'workspace.read', summary: source.title, output: { id: source.id, title: source.title, content: source.content } },
    ]),
  ],
  result: { id: 'example-brief', title: 'October planning brief', createdAt, citations: exampleSources.map(source => source.id), content: `## The work ahead

The October update has a clear sequence: draft the narrative, finish reconciliation, then review the numbers. **The main dependency is Theo’s reconciliation work.** Four invoices still need complete bank references. [Finance handoff](source:example-handoff)

## Owners and dates

| Milestone | Owner | Date |
| --- | --- | --- |
| First narrative draft | Mina | October 6 |
| Resolve unmatched invoices | Theo | October 8 |
| Finance review | Finance team | October 9 |
| Resolve open questions together | Team | October 12 |

The notes identify Mina as the narrative owner and Theo as the revenue owner. They do not name an individual owner for the finance review or the team meeting. [Quarterly planning](source:example-planning)

## One dependency to watch

Reconciliation is **in progress**. If the four unmatched invoices remain unresolved after October 8, the October 9 finance review is at risk. Keep invoiced revenue and cash received separate in the update. [Finance handoff](source:example-handoff)

## Next steps

- **Theo:** supply the reconciliation table and surface any incomplete bank references.
- **Mina:** prepare the narrative with the remaining risk stated plainly.
- **Operations:** collect the unresolved customer questions before the October 12 meeting.

Keep the final update short, with named owners, exact dates and unresolved questions clearly separated from established facts. [Team writing guide](source:example-guide)

## Still to confirm

Who will supply the missing bank references, and when? The notes do not record an answer. This draft stays inside the workspace for review.` },
};
