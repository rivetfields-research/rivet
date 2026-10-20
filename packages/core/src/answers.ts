import type { Artifact, Run } from './types.ts';
import { HarnessError } from './errors.ts';

export type AnswerKind = 'measured' | 'hypothetical' | 'missing-data' | 'text';
export interface AnswerIntent { outcome: string | null; period: string | null; comparison: string | null }
export interface Estimate {
  base: number; baseLabel: string; ratePercent: number; result: number; resultLabel: string; assumptions: string[];
}
export interface AnswerCheck { id: string; status: 'pass' | 'would-have-blocked' | 'not-checked' | 'not-applicable'; detail: string }
export interface AnswerRecord {
  id: string; kind: AnswerKind; intent?: AnswerIntent; estimate?: Estimate;
  question?: string;
  missing?: string[]; suggestions?: string[]; checks?: AnswerCheck[];
  savedFromRunId?: string;
}
export type AnswerOutput = NonNullable<Run['reply']> | Artifact;

export function hasCalculation(output: AnswerOutput): boolean {
  return Boolean(output.tabularAnalysis || output.sourceAnalysis || output.socialAnalysis || output.financialAnalysis || output.analysis);
}

/** Legacy records are interpreted on read, never migrated or guessed from prose. */
export function answerRecord(run: Run): AnswerRecord | undefined {
  const output = run.result ?? run.reply;
  return output ? output.answer ?? { id: `answer:${run.id}`, kind: hasCalculation(output) ? 'measured' : 'text' } : undefined;
}

export function latestAnswer(run: Run, lookup: (id: string) => Run | undefined): Run | undefined {
  let id = run.parentRunId;
  const seen = new Set([run.id]);
  for (let depth = 0; id && depth < 20; depth++) {
    if (seen.has(id)) return;
    seen.add(id);
    const previous = lookup(id);
    if (!previous || previous.workspaceId !== run.workspaceId || previous.profileId !== run.profileId) return;
    if (previous.status === 'completed' && (previous.result || previous.reply)) return previous;
    id = previous.parentRunId;
  }
}

// Only unambiguous save-only commands take the no-model shortcut. Changes need a new answer.
export function savesLatestAnswer(task: string): boolean {
  return /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:save|export|download)\s+(?:that|this|it|(?:the |this |that )?(?:latest |last )?(?:answer|estimate|result))(?:\s+(?:as|to)\s+(?:a |an )?(?:report|document|markdown|file))?[.!?]*$/i.test(task.trim());
}

const shortText = (value: unknown, name: string, limit = 180): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new HarnessError(`Provide a short ${name}.`, 422, 'invalid_answer');
  return value.trim();
};
const list = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || !value.length || value.length > 5) throw new HarnessError(`Provide 1-5 ${name}.`, 422, 'invalid_answer');
  return value.map(item => shortText(item, name));
};

/** New metadata is optional for old providers. Calculated values always come from code. */
export function createAnswer(id: string, input: unknown, measured: boolean): AnswerRecord {
  const fallback: AnswerRecord = { id: `answer:${id}`, kind: measured ? 'measured' : 'text' };
  if (input === undefined) return fallback;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HarnessError('Use answer metadata with kind and optional intent, estimate or missing.', 422, 'invalid_answer');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['kind', 'intent', 'estimate', 'missing'].includes(key)) || !['measured', 'hypothetical', 'missing-data', 'text'].includes(value.kind as string)) throw new HarnessError('Use a supported answer kind. Do not supply IDs, checks or calculated results.', 422, 'invalid_answer');
  if (measured && ['hypothetical', 'missing-data'].includes(value.kind as string)) throw new HarnessError('Keep hypothetical and missing-data answers separate from measured calculations.', 422, 'invalid_answer');
  const answer: AnswerRecord = { ...fallback, kind: measured ? 'measured' : value.kind === 'measured' ? 'text' : value.kind as AnswerKind };
  if (value.intent && typeof value.intent === 'object' && !Array.isArray(value.intent)) {
    const intent = value.intent as Record<string, unknown>;
    answer.intent = Object.fromEntries(['outcome','period','comparison'].map(key => [key, intent[key] == null ? null : shortText(intent[key], key)])) as unknown as AnswerIntent;
  }
  if (answer.kind === 'hypothetical') {
    const estimate = value.estimate as Record<string, unknown> | undefined;
    if (!estimate || typeof estimate !== 'object' || Array.isArray(estimate) || Object.keys(estimate).some(key => !['base','baseLabel','ratePercent','resultLabel','assumptions'].includes(key)) || typeof estimate.base !== 'number' || !Number.isFinite(estimate.base) || estimate.base < 0 || estimate.base > 1e12 || typeof estimate.ratePercent !== 'number' || !Number.isFinite(estimate.ratePercent) || estimate.ratePercent < 0 || estimate.ratePercent > 100) throw new HarnessError('An estimate needs a non-negative base and a percentage from 0 to 100. Rivet calculates the result; never supply it.', 422, 'invalid_answer');
    answer.estimate = { base: estimate.base, ratePercent: estimate.ratePercent,
      result: Number((estimate.base * estimate.ratePercent / 100).toPrecision(12)),
      baseLabel: shortText(estimate.baseLabel, 'base label', 80), resultLabel: shortText(estimate.resultLabel, 'result label', 80),
      assumptions: list(estimate.assumptions, 'assumptions') };
  }
  if (answer.kind === 'missing-data') answer.missing = list(value.missing, 'missing inputs');
  return answer;
}

export function estimateText(estimate: Estimate): string {
  const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 10 });
  return `${number(estimate.base)} ${estimate.baseLabel} x ${number(estimate.ratePercent)}% = ${number(estimate.result)} hypothetical ${estimate.resultLabel}.`;
}

export function estimateContent(answer: AnswerRecord): string {
  const literal = (text: string) => text.replace(/[\r\n\u0000-\u001f]+/g, ' ').replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&');
  return answer.estimate ? `**Hypothetical estimate, not measured results.**\n\n${literal(estimateText(answer.estimate))}\n\nAssumptions:\n${answer.estimate.assumptions.map(text => `- ${literal(text)}`).join('\n')}` : '';
}

export const ANSWER_GUIDANCE = `Use answer:{kind:"measured"|"hypothetical"|"missing-data"|"text"} on reply/finish. Optional intent:{outcome,period,comparison} describes the question; use null when unspecified. Missing inputs: kind:"missing-data",missing:[needed inputs], never an unrelated calculation. Clarification/options: kind:"text". Assumed percentages MUST use kind:"hypothetical",estimate:{base:number,baseLabel:string,ratePercent:number,resultLabel:string,assumptions:[string]}; code computes the result. Keep estimates separate from measured calculations. "What instead?" offers choices, not a calculation.`;

/** Validate new analytical output before legacy follow-up recovery can attach old facts. */
export function requireAnswerMetadata(input: unknown, measured: boolean, analyticalRead: boolean, task: string): void {
  if (input !== undefined || measured) return;
  const explicitEstimate = /\b(?:what if|assum(?:e|ing)|hypothetical|estimat\w*)\b/i.test(task) && /\d[\d,.]*\s*%/.test(task);
  if (analyticalRead || explicitEstimate) throw new HarnessError('Declare this answer\'s kind before choosing a calculation. If data is missing, use missing-data with the missing inputs; for an assumed percentage use hypothetical with base, ratePercent and assumptions; for clarification use text. Do not substitute the previous calculation.', 422, 'invalid_answer');
}

export function answerContext(answer: AnswerRecord | undefined) {
  if (!answer) return undefined;
  const {id,kind,intent,estimate,missing} = answer;
  return {id,kind,intent,estimate,missing};
}
