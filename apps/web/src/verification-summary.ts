import type { Run, RunEvent, Source } from '../../../packages/core/src/types';
import { calculationItems } from './verification-calculations';

export type VerificationCategoryId = 'citations' | 'traces' | 'claims' | 'queries';
export type VerificationStatus = 'linked' | 'passed' | 'recorded' | 'warning' | 'not-checked' | 'not-applicable' | 'illustrative';
export type VerificationItemStatus = VerificationStatus | 'linked' | 'passed';
export interface VerificationItem {
  id: string;
  title: string;
  status: VerificationItemStatus;
  evidence: string;
  technical?: string;
  sourceId?: string;
  createdAt?: string;
}
export interface VerificationCategory {
  id: VerificationCategoryId;
  title: string;
  description: string;
  status: VerificationStatus;
  countLabel: string;
  items: VerificationItem[];
}
export interface VerificationSummary {
  example: boolean;
  model: string | null;
  timestamp: { label: string; value: string | null };
  notice: string;
  categories: VerificationCategory[];
}

const checkLabels: Record<string, string> = {
  schema: 'Input format', arithmetic: 'Arithmetic', coverage: 'Coverage',
  duplicates: 'Repeated records', 'source-truth': 'Source reliability', 'period-length': 'Period length',
};
const toolLabels: Record<string, string> = {
  'workspace.search': 'Search sources', 'workspace.read': 'Read sources',
  'workspace.calculate_usage': 'Calculate usage',
  'workspace.calculate_financial': 'Calculate financials',
  'workspace.analyze_table': 'Calculate table metrics',
  'workspace.analyze_sources': 'Analyze connected sources',
};
const validTime = (value: string | undefined): string | undefined =>
  value && Number.isFinite(Date.parse(value)) ? value : undefined;
const latestEventTime = (events: RunEvent[]): string | undefined => events.reduce<string | undefined>((latest, event) => {
  const value = validTime(event.createdAt);
  return value && (!latest || Date.parse(value) > Date.parse(latest)) ? value : latest;
}, undefined);

/** Describes recorded evidence only. It neither runs checks nor certifies a report. */
export function buildVerificationSummary(run: Run, fallbackSources: Source[], example = false): VerificationSummary {
  // An empty saved snapshot is authoritative: never resolve it against newer workspace data.
  const sources = new Map((run.sources ?? fallbackSources).map(source => [source.id, source]));
  const citationIds = [...new Set(run.result?.citations ?? run.reply?.citations ?? [])];
  const prepared = run.events.filter(event => event.type === 'preparation').map(event => event.output as {sourceId?: string; batchId?: string} | undefined)
    .filter((value): value is {sourceId: string; batchId: string} => Boolean(value?.sourceId && value.batchId && sources.has(value.sourceId)));
  const preparedIds = [...new Set(prepared.map(value => value.sourceId))].filter(id => !citationIds.includes(id));
  const linked = citationIds.filter(id => sources.has(id)).length;
  const artifactTime = validTime(run.result?.createdAt);
  const citations: VerificationCategory = {
    id: 'citations', title: 'Citations',
    description: 'Links to the evidence used.',
    status: citationIds.length ? linked === citationIds.length ? 'linked' : 'warning' : 'not-checked',
    countLabel: citationIds.length ? `${linked}/${citationIds.length} linked` : preparedIds.length ? `${preparedIds.length} prepared source` : 'No citations',
    items: [...citationIds, ...preparedIds].map(id => {
      const source = sources.get(id);
      return {
        id: `citation:${id}`, title: source?.title ?? 'Unavailable source',
        status: preparedIds.includes(id) ? 'recorded' : source ? 'linked' : 'warning',
        evidence: preparedIds.includes(id) ? 'This source was prepared for the model. The saved response did not include a citation. Open it to inspect the underlying evidence.' : source
          ? 'This source is linked to the saved answer. The link does not establish that the source supports the claim.'
          : `The source is absent from ${run.sources ? 'this run’s saved source list' : 'the available source list'}.`,
        technical: `Source ID: ${id}${source ? `\nPath: ${source.path}` : ''}`,
        ...(source ? { sourceId: id } : {}), ...(artifactTime ? { createdAt: artifactTime } : {}),
      };
    }),
  };

  const analysis = run.result?.analysis ?? run.result?.financialAnalysis ?? run.reply?.analysis ?? run.reply?.financialAnalysis;
  const passed = analysis?.checks.filter(check => check.status === 'passed').length ?? 0;
  const warnings = analysis?.checks.filter(check => check.status === 'warning').length ?? 0;
  const analysisTime = validTime(analysis?.createdAt);
  const receiptAvailable = analysis ? sources.has(analysis.sourceId) : false;
  const traces: VerificationCategory = {
    id: 'traces', title: 'Traces',
    description: 'Saved calculation checks and input records.',
    status: analysis ? warnings || !receiptAvailable ? 'warning' : analysis.checks.length && analysis.checks.every(check => check.status === 'passed') ? 'passed' : 'recorded' : 'not-checked',
    countLabel: analysis ? `${passed} passed · ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : 'No calculation saved',
    items: analysis ? [
      ...analysis.checks.map(check => ({
        id: `check:${check.id}`, title: checkLabels[check.id] ?? check.id,
        status: check.status, evidence: check.message,
        ...(receiptAvailable ? { sourceId: analysis.sourceId } : {}),
        ...(analysisTime ? { createdAt: analysisTime } : {}),
      })),
      {
        id: 'calculation-provenance', title: 'Calculation source',
        status: receiptAvailable ? 'recorded' : 'warning',
        evidence: receiptAvailable ? `Saved as ${sources.get(analysis.sourceId)!.title}.` : 'The calculation receipt is absent from the available source list.',
        technical: `Calculator: ${analysis.calculatorVersion}. Dataset: ${analysis.datasetId}. Input SHA-256: ${analysis.contentHash}.`,
        ...(receiptAvailable ? { sourceId: analysis.sourceId } : {}),
        ...(analysisTime ? { createdAt: analysisTime } : {}),
      },
    ] : [],
  };

  const social = run.result?.socialAnalysis ?? run.reply?.socialAnalysis;
  if (social) {
    traces.status = 'recorded';
    traces.countLabel = `${social.posts.length} source records`;
    traces.items = ([
      { id: 'social-period', title: 'Period and collection', status: 'recorded', evidence: `Posts published ${social.week.from} through ${social.week.through} UTC. Collected ${social.fetchedAt}. Counters are lifetime totals at collection.`, sourceId: social.sourceId },
      { id: 'social-records', title: 'Calculation and source posts', status: 'recorded', evidence: `Fixed code summed observed counters from ${social.posts.length} posts by account and platform. Missing values remain unknown. Coverage: ${social.coverage}.`, sourceId: social.sourceId },
      { id: 'social-snapshot', title: 'Saved snapshot', status: 'recorded', evidence: 'The chart, table and CSV use this same saved snapshot.', technical: `Input SHA-256: ${social.contentHash}.`, sourceId: social.sourceId },
    ] satisfies VerificationItem[]).map(item => ({ ...item, sourceId: sources.has(social.sourceId) ? social.sourceId : undefined }));
  }

  const recordedCalculation = calculationItems(run, sources);
  if (recordedCalculation) {
    traces.items = recordedCalculation;
    traces.status = recordedCalculation.some(item => item.status === 'warning') ? 'warning' : 'recorded';
    traces.countLabel = (run.result ?? run.reply)?.answer?.kind === 'missing-data' ? 'Missing inputs'
      : (run.result ?? run.reply)?.answer?.kind === 'hypothetical' ? 'Hypothetical estimate' : 'Calculation saved';
  }

  const claims: VerificationCategory = {
    id: 'claims', title: 'Claims',
    description: 'Interpretations and recommendations.',
    status: 'not-checked', countLabel: 'Needs review',
    items: [{ id: 'claim-review', title: 'Human review needed', status: 'not-checked',
      evidence: 'Source links and saved arithmetic do not verify the report’s interpretation, causal explanations or recommendations.' }],
  };
  const answer = (run.result ?? run.reply)?.answer;
  if (answer) {
    const kinds = { measured: 'Measured result', hypothetical: 'Hypothetical estimate', 'missing-data': 'Missing-data explanation', text: 'Text answer' };
    claims.items.unshift({ id: 'answer-context', title: 'Question and answer', status: 'recorded',
      evidence: `Question: ${answer.question ?? (answer.savedFromRunId ? 'Not recorded with this older saved answer' : run.task)}\nAnswer type: ${kinds[answer.kind]}${answer.intent ? `\nModel-interpreted request (not independently checked):\nOutcome: ${answer.intent.outcome ?? 'unspecified'}\nPeriod: ${answer.intent.period ?? 'unspecified'}\nComparison: ${answer.intent.comparison ?? 'unspecified'}` : ''}`,
      technical: `Answer ID: ${answer.id}${answer.savedFromRunId ? `\nSaved from task: ${answer.savedFromRunId}` : ''}` });
  }
  if (answer?.checks?.length) {
    const titles: Record<string,string> = {'question-calculation':'Question and calculation', 'title-result':'Title and result', 'body-result':'Explanation and result', 'saved-answer':'Saved answer', 'export-answer':'Exported answer', 'estimate-arithmetic':'Estimate arithmetic'};
    claims.description = 'Question, answer and consistency checks. Observations only.';
    claims.countLabel = answer.checks.some(check => check.status === 'would-have-blocked') ? 'Possible mismatch' : 'Not fully checked';
    claims.status = answer.checks.some(check => check.status === 'would-have-blocked') ? 'warning' : 'not-checked';
    claims.items.splice(1, 0, ...answer.checks.map(check => ({id:check.id,
      title: titles[check.id] ?? check.id,
      status: check.status === 'pass' ? 'passed' as const : check.status === 'would-have-blocked' ? 'warning' as const : check.status,
      evidence: check.detail,
    })));
  }

  const events = run.events.filter(event =>
    (event.type === 'tool_call' || event.type === 'tool_result') && event.toolName?.startsWith('workspace.'));
  const calls = events.filter(event => event.type === 'tool_call').length;
  const results = events.filter(event => event.type === 'tool_result').length;
  const queries: VerificationCategory = {
    id: 'queries', title: 'Queries',
    description: 'Recorded tool calls and returned results.',
    status: events.length ? 'recorded' : 'not-checked',
    countLabel: events.length ? `${calls} ${calls === 1 ? 'call' : 'calls'} · ${results} ${results === 1 ? 'result' : 'results'}` : 'No workspace tool records',
    items: [...new Set(events.map(event => event.toolName!))].map(tool => {
      const matching = events.filter(event => event.toolName === tool);
      const toolCalls = matching.filter(event => event.type === 'tool_call').length;
      const toolResults = matching.filter(event => event.type === 'tool_result').length;
      const createdAt = latestEventTime(matching);
      return { id: `tool:${tool}`, title: toolLabels[tool] ?? tool, status: 'recorded',
        evidence: `${tool}: ${toolCalls} call records and ${toolResults} result records. These counts do not establish successful execution or result correctness. SQL correctness has not been checked.`,
        ...(createdAt ? { createdAt } : {}),
      };
    }),
  };

  const categories = [citations, traces, claims, queries];
  if (example) {
    for (const category of categories) {
      category.status = 'illustrative';
      category.countLabel = 'Illustrative example';
      category.items = category.items.map(({ createdAt: _createdAt, ...item }) => ({ ...item, status: 'illustrative',
        evidence: `Authored example, not an executed check. ${item.status === 'warning' ? 'Example warning: ' : ''}${item.evidence}` }));
    }
  }
  return {
    example, model: null,
    timestamp: example ? { label: 'Illustrative example', value: null }
      : { label: artifactTime ? 'Artifact saved' : 'Run updated', value: artifactTime ?? validTime(run.updatedAt) ?? null },
    notice: example ? 'This is an authored interface example, not a verified model run.'
      : 'Source links and saved checks do not verify narrative claims.',
    categories,
  };
}
